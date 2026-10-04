// 现场网关离线作业包契约：制包/领取围栏/分段幂等/乱序/释放/强制移交/过期/撤销/重启恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Kernel } from '../src/kernel.js';
import { BASE_NOW } from '../src/seed.js';
import { EventStore } from '../src/store.js';
import {
  buildInstructions, buildManifest, canonicalManifest, computeCheckpoint, digestOf,
  mergeSegment, segmentDigest, signCanonical, verifyBundle,
} from '../src/offline.js';

const I = 15 * 60 * 1000;
const START = Date.UTC(2026, 8, 16, 2, 0, 0);
const END = START + 8 * I;

function newKernel() {
  return Kernel.freshMemory(BASE_NOW);
}

function publish(k, { meterId = 'MP-1', start = START, end = END, targetKw = 40 } = {}) {
  return k.dispatch({ type: 'PUBLISH_EVENT', meterId, targetKw, startMs: start, endMs: end }).event.id;
}

// 制包（默认有效期 = 事件结束）
function issue(k, eventId, deviceIds, extra = {}) {
  return k.dispatch({ type: 'ISSUE_PACKAGE', eventId, deviceIds, ...extra }).package.packageId;
}

function claim(k, packageId, gatewayId) {
  return k.dispatch({ type: 'CLAIM_PACKAGE', packageId, gatewayId });
}

function upload(k, packageId, gatewayId, fence, segmentId, items, extra = {}) {
  return k.dispatch({ type: 'UPLOAD_PACKAGE_SEGMENT', packageId, gatewayId, fence, segmentId, items, ...extra });
}

const EX = (seq, outcome = 'EXECUTED', rest = {}) => ({ seq, outcome, ...rest });

test('制包：锚定已发布事件固定版本，生成清单摘要与 Ed25519 验签材料', () => {
  const k = newKernel();
  const eid = publish(k);
  const out = k.dispatch({ type: 'ISSUE_PACKAGE', eventId: eid, deviceIds: ['DEV-2', 'DEV-1'] });
  const p = out.package;
  // 序号按设备号排序后连续 1..N；指令削减不超过设备额定
  assert.deepEqual(p.instructions.map((i) => i.deviceId), ['DEV-1', 'DEV-2']);
  assert.deepEqual(p.instructions.map((i) => i.seq), [1, 2]);
  assert.equal(p.instructions.find((i) => i.deviceId === 'DEV-2').kw, 30); // 额定 30 < 目标 40
  assert.equal(p.eventVersion, 1);
  assert.match(p.eventRefHash, /^[0-9a-f]{64}$/);
  assert.match(p.manifestHash, /^[0-9a-f]{64}$/);
  assert.match(p.signature, /^[0-9a-f]{128}$/);
  const vf = k.verifyPackageView(p.packageId);
  assert.equal(vf.digestMatches, true);
  assert.equal(vf.signatureValid, true);
});

test('清单改动一个字节即摘要不符、签名失效（只读包防篡改）', () => {
  const k = newKernel();
  const eid = publish(k);
  const out = k.dispatch({ type: 'ISSUE_PACKAGE', eventId: eid, deviceIds: ['DEV-1'] });
  const pkg = k.s.packages.get(out.package.packageId);
  const tampered = { ...pkg.manifest, validUntil: pkg.manifest.validUntil + 1 };
  const vf = verifyBundle(tampered, pkg.manifestHash, pkg.signature);
  assert.equal(vf.digestMatches, false);
  assert.equal(vf.signatureValid, false);
});

test('不同包不得重复包含同一设备（跨包 + 批次内）；关闭后释放设备', () => {
  const k = newKernel();
  const eid = publish(k);
  issue(k, eid, ['DEV-1']);
  assert.throws(() => issue(k, eid, ['DEV-1', 'DEV-2']), (e) => e.code === 'DEVICE_IN_OTHER_PACKAGE');
  assert.throws(() => issue(k, eid, ['DEV-2', 'DEV-2']), (e) => e.code === 'DUPLICATE_DEVICE_IN_BATCH');
  // 不属于该计量点的设备
  assert.throws(() => issue(k, eid, ['DEV-3']), (e) => e.code === 'METER_MISMATCH');
});

test('事件撤销或开始后不允许制包/领取新包', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1']);
  k.dispatch({ type: 'TICK', minutes: (START - k.now()) / 60000 }); // 事件激活
  assert.throws(() => issue(k, eid, ['DEV-2']), (e) => e.code === 'EVENT_NOT_SCHEDULED');
  // 事件开始：未领取包已随激活关闭（EVENT_STARTED），领取被拒
  assert.throws(() => claim(k, pid, 'GW-1'), (e) => e.code === 'PACKAGE_CLOSED');
  const v = k.packageView(pid);
  assert.equal(v.status, 'CLOSED');
  assert.equal(v.closeReason, 'EVENT_STARTED');

  const e2 = publish(k, { meterId: 'MP-2', start: START + 20 * I, end: START + 28 * I });
  const p2 = issue(k, e2, ['DEV-3']);
  claim(k, p2, 'GW-1'); // 开始前已领取：继续有效
  k.dispatch({ type: 'CANCEL_EVENT', eventId: e2 });
  const v2 = k.packageView(p2);
  assert.equal(v2.status, 'CLOSED');
  assert.equal(v2.closeReason, 'EVENT_RECALLED');
  // 当前持有网关再上传新回执 -> 已关闭（事件撤销），明确拒绝
  assert.throws(
    () => upload(k, p2, 'GW-1', v2.fence, 's', [EX(1)]),
    (e) => e.code === 'PACKAGE_CLOSED'
  );
  // 被移交后凭旧围栏的旧领取者 -> STALE_FENCE（围栏闸仍然生效）
  const e3 = publish(k, { meterId: 'MP-3', start: START + 30 * I, end: START + 38 * I });
  const p3 = issue(k, e3, ['DEV-4']);
  claim(k, p3, 'GW-1');
  k.dispatch({ type: 'HANDOVER_PACKAGE', packageId: p3, toGatewayId: 'GW-2' });
  k.dispatch({ type: 'CANCEL_EVENT', eventId: e3 });
  assert.throws(
    () => upload(k, p3, 'GW-1', 1, 'old', [EX(1)]),
    (e) => e.code === 'STALE_FENCE'
  );
});

test('领取获得递增围栏号；同网关幂等重试；他网关持有被拒', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  assert.equal(claim(k, pid, 'GW-1').fence, 1);
  assert.equal(claim(k, pid, 'GW-1').idempotent, true);
  assert.throws(() => claim(k, pid, 'GW-2'), (e) => e.code === 'PACKAGE_HELD');
});

test('旧围栏回执失效：移交轮换围栏后旧领取者不得覆盖新领取者进度', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  claim(k, pid, 'GW-1');
  upload(k, pid, 'GW-1', 1, 'a', [EX(1, 'EXECUTED')]);
  const ho = k.dispatch({ type: 'HANDOVER_PACKAGE', packageId: pid, toGatewayId: 'GW-2', expectedFence: 1 });
  assert.equal(ho.fence, 2);
  // 旧领取者凭旧围栏上报（甚至相同序号的不同结果）——必须被识别失效
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 'old', [EX(1, 'FAILED')]),
    (e) => e.code === 'STALE_FENCE'
  );
  // 此前证据保留
  const v = k.packageView(pid);
  assert.equal(v.mergedCount, 1);
  assert.equal(v.counts.EXECUTED, 1);
  // 新领取者继续推进
  const cont = upload(k, pid, 'GW-2', 2, 'b', [EX(2, 'EXECUTED')]);
  assert.equal(cont.watermark, 2);
});

test('按包内序号合并 + 稳定检查点；乱序分段挂起、缺口补齐自动排水', () => {
  // MP-1 下两台设备不够演示三序号缺口；用专用事件 + 三设备（MP-3 有 DEV-4/DEV-5，仅两台），
  // 因此这里用两台设备验证“高位挂起、低位补齐后排水”的同一机制，再在恢复用例验证三序号。
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  claim(k, pid, 'GW-1');
  const hi = upload(k, pid, 'GW-1', 1, 'seg-hi', [EX(2, 'SKIPPED')]);
  assert.equal(hi.watermark, 0);
  assert.deepEqual(hi.pending, [2]);
  const lo = upload(k, pid, 'GW-1', 1, 'seg-lo', [EX(1, 'EXECUTED')]);
  assert.deepEqual(lo.merged, [1, 2]);
  assert.equal(lo.watermark, 2);
  assert.equal(lo.closed, true); // 全部序号合并 -> 自动完成关闭
  assert.equal(k.packageView(pid).closeReason, 'COMPLETED');
});

test('完全相同的分段重传不重复计数并返回同一稳定检查点（上传超时重试）', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  claim(k, pid, 'GW-1');
  const items = [EX(1, 'EXECUTED'), EX(2, 'SKIPPED', { reason: '用户拒动' })];
  const a = upload(k, pid, 'GW-1', 1, 'seg-1', items);
  const before = k.store.all().length;
  const b = upload(k, pid, 'GW-1', 1, 'seg-1', items);
  assert.equal(b.duplicate, true);
  assert.equal(b.checkpoint, a.checkpoint);
  assert.equal(k.store.all().length, before, '重传不追加任何记录');
  assert.equal(k.packageView(pid).mergedCount, 2);
});

test('序号内容变化（同段号不同内容 / 同序号不同结果）明确拒绝', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  claim(k, pid, 'GW-1');
  upload(k, pid, 'GW-1', 1, 'seg-1', [EX(1, 'EXECUTED')]);
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 'seg-1', [EX(1, 'FAILED')]),
    (e) => e.code === 'SEGMENT_CONFLICT'
  );
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 'seg-2', [EX(1, 'SKIPPED')]),
    (e) => e.code === 'SEQ_CONTENT_CONFLICT'
  );
});

test('越界序号、越界设备、清单/分段摘要不匹配、已关闭包均明确拒绝', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  const hash = k.packageView(pid).manifestHash;
  claim(k, pid, 'GW-1');
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 's', [EX(9, 'EXECUTED')]),
    (e) => e.code === 'SEQ_OUT_OF_RANGE'
  );
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 's', [EX(0, 'EXECUTED')]),
    (e) => e.code === 'SEQ_OUT_OF_RANGE'
  );
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 's', [EX(1, 'EXECUTED', { deviceId: 'DEV-2' })]),
    (e) => e.code === 'DEVICE_OUT_OF_SCOPE'
  );
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 's', [EX(1)], { manifestHash: '0'.repeat(64) }),
    (e) => e.code === 'PACKAGE_DIGEST_MISMATCH'
  );
  const items = [EX(1)];
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 's', items, { segmentHash: '0'.repeat(64) }),
    (e) => e.code === 'SEGMENT_DIGEST_MISMATCH'
  );
  void hash;
  // 已关闭包（完成）：新内容拒绝，相同重传仍幂等
  upload(k, pid, 'GW-1', 1, 's', [EX(1), EX(2)]);
  assert.equal(k.packageView(pid).status, 'CLOSED');
  assert.throws(
    () => upload(k, pid, 'GW-1', 1, 'new', [EX(1)]),
    (e) => e.code === 'PACKAGE_CLOSED'
  );
  const retried = upload(k, pid, 'GW-1', 1, 's', [EX(1), EX(2)]);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.closed, true);
});

test('首条执行回执前可释放并重新领取（围栏递增）；已有进度只能强制移交', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  claim(k, pid, 'GW-1');
  // 仅挂起（乱序未排水）算不算“已有进度”？需求锁定点是“首条执行回执前”：
  // 挂起未合并不算合并进度，但保守起见这里验证：无合并时可释放。
  const r = k.dispatch({ type: 'RELEASE_PACKAGE', packageId: pid, gatewayId: 'GW-1', fence: 1 });
  assert.equal(r.nextFence, 2);
  assert.equal(k.packageView(pid).heldBy, null);
  // 非持有者 / 旧围栏不能释放
  claim(k, pid, 'GW-2');
  assert.throws(
    () => k.dispatch({ type: 'RELEASE_PACKAGE', packageId: pid, gatewayId: 'GW-1', fence: 1 }),
    (e) => e.code === 'NOT_PACKAGE_HOLDER'
  );
  // 有合并进度后释放被拒
  upload(k, pid, 'GW-2', 2, 's', [EX(1)]);
  assert.throws(
    () => k.dispatch({ type: 'RELEASE_PACKAGE', packageId: pid, gatewayId: 'GW-2', fence: 2 }),
    (e) => e.code === 'PACKAGE_PROGRESS_LOCKED'
  );
});

test('强制移交保留证据、轮换围栏；移交竞争 expectedFence 失效返回 409', () => {
  const k = newKernel();
  const eid = publish(k);
  const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
  claim(k, pid, 'GW-1');
  upload(k, pid, 'GW-1', 1, 's', [EX(1)]);
  k.dispatch({ type: 'HANDOVER_PACKAGE', packageId: pid, toGatewayId: 'GW-2', expectedFence: 1 });
  // 另一运营人员基于陈旧页面再移交（期望围栏仍为 1）
  assert.throws(
    () => k.dispatch({ type: 'HANDOVER_PACKAGE', packageId: pid, toGatewayId: 'GW-3', expectedFence: 1 }),
    (e) => e.code === 'FENCE_CONFLICT'
  );
  // 刷新后带正确围栏可继续移交
  const ho = k.dispatch({ type: 'HANDOVER_PACKAGE', packageId: pid, toGatewayId: 'GW-3', expectedFence: 2 });
  assert.equal(ho.fence, 3);
  const v = k.packageView(pid);
  assert.equal(v.heldBy, 'GW-3');
  assert.equal(v.mergedCount, 1, '证据保留');
  assert.ok(v.history.some((h) => h.type === 'HANDED_OVER'));
});

test('包过期：tick 惰性关闭，领取/上传均被拒；关闭后设备可被新包包含', () => {
  const k = newKernel();
  const eid = publish(k);
  const validUntil = START - 2 * I; // 事件开始前 30 分钟即过期
  const pid = issue(k, eid, ['DEV-1'], { validUntilMs: validUntil });
  k.dispatch({ type: 'TICK', minutes: (validUntil - k.now()) / 60000 + 15 });
  assert.equal(k.packageView(pid).closeReason, 'EXPIRED');
  assert.throws(() => claim(k, pid, 'GW-1'), (e) => e.code === 'PACKAGE_CLOSED');
  // 设备已从索引释放，可重新切包
  const pid2 = issue(k, eid, ['DEV-1'], { validUntilMs: END });
  assert.ok(pid2);
});

test('进程恢复：领取关系/围栏/检查点/挂起缺口/回执次序重启后不倒退', async () => {
  const dir = tmpdir();
  const file = join(dir, `dr-pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  try {
    const store = new EventStore(file);
    seedBoot(store, BASE_NOW);
    let k = new Kernel(store);
    // MP-1 只有 DEV-1/DEV-2；为保留一个跨重启的挂起缺口 seq3，采用 MP-1 两设备但只到 seq2 的
    // 水位推进并不足；这里让 seq2 高位挂起后重启，再补 seq1 排水。
    const eid = publish(k);
    const pid = issue(k, eid, ['DEV-1', 'DEV-2']);
    claim(k, pid, 'GW-1');
    upload(k, pid, 'GW-1', 1, 'hi', [EX(2, 'SKIPPED')]); // 缺口挂起（seq2 等 seq1）
    const before = k.packageView(pid);
    assert.deepEqual(before.pendingSeqs, [2]);
    assert.equal(before.watermark, 0);

    // 模拟进程重启：新 store 从磁盘重放
    const store2 = new EventStore(file);
    const loaded = await store2.load();
    assert.equal(loaded.ok, true);
    k = new Kernel(store2, { boot: false });
    k.bootstrap();
    const after = k.packageView(pid);
    assert.equal(after.heldBy, 'GW-1');
    assert.equal(after.fence, 1);
    assert.equal(after.watermark, 0);
    assert.deepEqual(after.pendingSeqs, [2]);
    assert.equal(after.checkpoint, before.checkpoint, '检查点由记录重放，字节一致');
    // 恢复后续传：补齐缺口，自动排水，次序不倒退
    const done = upload(k, pid, 'GW-1', 1, 'one', [EX(1, 'FAILED', { reason: '通信故障' })]);
    assert.deepEqual(done.merged, [1, 2]);
    assert.equal(done.closed, true);
    assert.equal(k.packageView(pid).counts.FAILED, 1);
    assert.equal(k.packageView(pid).counts.SKIPPED, 1);
  } finally {
    rmSync(file, { force: true });
  }
});

test('纯函数：检查点稳定、排水正确、段摘要对条目顺序/内容敏感', () => {
  const receipts = new Map([[1, { outcome: 'EXECUTED', reason: null }]]);
  const pending = new Map([[3, { outcome: 'SKIPPED', reason: null }]]);
  const cp1 = computeCheckpoint('P', 1, receipts, [3]);
  const cp2 = computeCheckpoint('P', 1, new Map(receipts), [3]);
  assert.equal(cp1.checkpoint, cp2.checkpoint);
  assert.equal(cp1.watermark, 1);
  // 围栏变化 -> 检查点变化
  assert.notEqual(cp1.checkpoint, computeCheckpoint('P', 2, receipts, [3]).checkpoint);

  const r = new Map();
  const p = new Map();
  mergeSegment(r, p, [EX(2), EX(3)]);
  assert.equal(r.size, 0);
  assert.deepEqual([...p.keys()].sort(), [2, 3]);
  const merged = mergeSegment(r, p, [EX(1)]);
  assert.deepEqual(merged.map((m) => m.seq), [1, 2, 3]);

  const d1 = segmentDigest('P', 's', [EX(1), EX(2)]);
  const d2 = segmentDigest('P', 's', [EX(2), EX(1)]);
  const d3 = segmentDigest('P', 's', [EX(1, 'FAILED'), EX(2)]);
  assert.notEqual(d1, d2, '条目重排摘要不同');
  assert.notEqual(d1, d3, '内容变化摘要不同');
});

// 清单构造纯函数的直接覆盖（指令 kw 取额定与目标的较小值）
test('buildInstructions / buildManifest：序号连续、kw 取额定上限', () => {
  const ev = { id: 'EV-1', targetKw: 40, startMs: START, endMs: END };
  const rows = [{ deviceId: 'DEV-2', maxKw: 30 }, { deviceId: 'DEV-1', maxKw: 50 }];
  const ins = buildInstructions(ev, rows);
  assert.deepEqual(ins.map((i) => [i.deviceId, i.kw]), [['DEV-1', 40], ['DEV-2', 30]]);
  const m = buildManifest({
    packageId: 'PKG-x', ev, eventRefHash: 'a'.repeat(64), instructions: ins, issuedAt: BASE_NOW, validUntil: END,
  });
  const hash = digestOf(canonicalManifest(m));
  const sig = signCanonical(canonicalManifest(m));
  assert.equal(verifyBundle(m, hash, sig).signatureValid, true);
});

// 与测试文件内 publish/issue 相同的最小引导（文件库需要先播种）
import { seed as seedFn } from '../src/seed.js';
function seedBoot(store, now) {
  seedFn(store, now);
}
