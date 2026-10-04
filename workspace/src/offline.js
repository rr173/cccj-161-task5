// 离线作业包：清单 / 摘要 / 验签 / 检查点等纯函数（内核与网关均可复算）。
//
// 只读包（read-only bundle）锚定一次“已发布事件的固定版本”：
//   manifest  -> 规范化 JSON（键名字典序），字节固定
//   manifestHash = sha256(canonical(manifest))           —— 清单摘要
//   signature = Ed25519 运营方签名私钥对同一份 canonical 字节签名 —— 验签材料
// 任何字段（设备批次、指令序号、有效期、事件锚点）被改动，摘要与签名必不一致。
//
// 检查点（checkpoint）由“当前围栏号 + 已合并序号内容 + 挂起缺口序号”规范化哈希得到，
// 相同分段重传不写入任何记录，返回的检查点字节稳定。
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJSON, sha256Hex } from './util.js';

export const PACKAGE_DIGEST_VERSION = 1;
export const PACKAGE_OUTCOMES = ['EXECUTED', 'SKIPPED', 'FAILED'];
export const OPERATOR_KEY_ID = 'OPS-PACKAGE-KEY-1';

// 运营方演示签名密钥（确定性派生，重启不变；生产环境应替换为 KMS 托管私钥）。
// Ed25519 PKCS8 私钥 = 固定 DER 前缀 + 32 字节种子。
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const OPERATOR_SEED = createHash('sha256').update('dr-orchestrator offline package operator key v1').digest();

let cachedKey = null;
function operatorKey() {
  if (!cachedKey) {
    const der = Buffer.concat([ED25519_PKCS8_PREFIX, OPERATOR_SEED]);
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    cachedKey = { privateKey, publicKey: createPublicKey(privateKey) };
  }
  return cachedKey;
}

export function operatorKeyId() {
  return OPERATOR_KEY_ID;
}

export function operatorPublicKeyPem() {
  return operatorKey().publicKey.export({ type: 'spki', format: 'pem' });
}

// 对 canonical 字节做 Ed25519 签名（PureEdDSA，hash 必须为 null）。
export function signCanonical(canonical) {
  return sign(null, Buffer.from(canonical, 'utf8'), operatorKey().privateKey).toString('hex');
}

// 用运营方公钥验签；任何异常都视为验证失败。
export function verifySignature(canonical, signatureHex, publicKeyPem = operatorPublicKeyPem()) {
  try {
    return verify(null, Buffer.from(canonical, 'utf8'), createPublicKey(publicKeyPem), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

// 指令序列：一台设备一条 SHED 指令（覆盖事件时窗），序号按设备号排序后 1..N 连续编号。
// 序号是包内命名空间：上传回执只认包内序号，天然防止跨包串号。
// 内核用额定功率构造指令（每台设备允许削减上限）
export function buildInstructions(ev, deviceRows) {
  return [...deviceRows]
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))
    .map((d, i) => ({
      seq: i + 1,
      deviceId: d.deviceId,
      action: 'SHED',
      kw: Math.round(Math.min(Number(ev.targetKw), Number(d.maxKw)) * 1000) / 1000,
      startMs: ev.startMs,
      endMs: ev.endMs,
    }));
}

// 固定版本锚点：事件发布记录的链哈希（seq/ts/prevHash/内容全部参与），
// 事件对象任何历史被篡改都会让锚点失效。
export function buildManifest({
  packageId, ev, eventRefHash, instructions, issuedAt, validUntil,
}) {
  return {
    digestVersion: PACKAGE_DIGEST_VERSION,
    packageId,
    eventId: ev.id,
    eventVersion: 1, // 已发布事件的固定版本（发布快照 v1；基线冻结/裁决版本均不改变作业指令）
    eventRefHash,
    meterId: ev.meterId,
    targetKw: ev.targetKw,
    startMs: ev.startMs,
    endMs: ev.endMs,
    issuedAt,
    validUntil,
    instructions,
  };
}

export function canonicalManifest(manifest) {
  return canonicalJSON(manifest);
}

export function digestOf(canonical) {
  return sha256Hex(canonical);
}

// 分段摘要：段号 + 规范化条目（条目顺序参与摘要，防止条目被增删/重排后冒充重传）。
export function segmentDigest(packageId, segmentId, items) {
  return sha256Hex(canonicalJSON({ packageId, segmentId, items }));
}

// 稳定检查点：围栏号 + 已合并序号的完整内容 + 挂起缺口序号集合。
// 只要服务端台账不变，检查点哈希就不变（相同分段重传返回同一检查点）。
export function computeCheckpoint(packageId, fence, receipts, pendingSeqs) {
  const merged = [...receipts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, r]) => ({ seq, outcome: r.outcome, reason: r.reason ?? null }));
  const pending = [...pendingSeqs].sort((a, b) => a - b);
  const watermark = watermarkOf(receipts);
  return {
    fence,
    watermark,
    mergedCount: merged.length,
    pending,
    checkpoint: sha256Hex(canonicalJSON({ packageId, fence, merged, pending })),
  };
}

// 水位：自 1 起连续已合并的最大序号。
export function watermarkOf(receipts) {
  let wm = 0;
  while (receipts.has(wm + 1)) wm++;
  return wm;
}

// 将一个已通过校验的分段并入台账（纯函数式：就地更新 Map，返回新合并的序号）。
// 调用方必须先完成：围栏/有效期/包状态/序号越界/设备归属/序号内容冲突等全部校验。
export function mergeSegment(receipts, pending, items) {
  const newlyMerged = [];
  for (const it of items) {
    if (receipts.has(it.seq) || pending.has(it.seq)) continue; // 同序号同内容：幂等跳过
    pending.set(it.seq, { outcome: it.outcome, reason: it.reason ?? null });
  }
  let wm = watermarkOf(receipts);
  while (pending.has(wm + 1)) {
    const r = pending.get(wm + 1);
    pending.delete(wm + 1);
    receipts.set(wm + 1, r);
    newlyMerged.push({ seq: wm + 1, outcome: r.outcome, reason: r.reason ?? null });
    wm++;
  }
  return newlyMerged;
}

// 独立复核一份只读包：重算摘要 + 验签（审计/网关侧均可调用）。
export function verifyBundle(manifest, manifestHash, signature, publicKeyPem) {
  const canonical = canonicalManifest(manifest);
  const recomputedHash = digestOf(canonical);
  return {
    keyId: OPERATOR_KEY_ID,
    manifestHash,
    recomputedHash,
    digestMatches: recomputedHash === manifestHash,
    signatureValid: verifySignature(canonical, signature, publicKeyPem),
  };
}
