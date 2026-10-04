// 端到端场景：通过真实 HTTP API 走一遍全部并发/迟到/订正语义。
const BASE = process.env.BASE || 'http://localhost:8080';

async function api(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { code: data.code, status: res.status, details: data.details });
  return data;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const I = 15 * 60000;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name, extra); }
  else { fail++; console.log('  ❌', name, extra); }
}

(async () => {
  await api('/api/sim/reset', {});

  console.log('场景 A：发布 + 冻结 + 双聚合商抢同一设备');
  const st0 = await api('/api/state', null, 'GET');
  const start = Math.ceil((st0.now + 30 * 60000) / I) * I;
  const end = start + 16 * I;
  const ev = await api('/api/events', { meterId: 'MP-1', targetKw: 40, startMs: start, endMs: end, algorithm: 'MID_8_OF_10' });
  const id = ev.event.id;
  await api('/api/claims', { eventId: id, deviceId: 'DEV-1', aggregatorId: 'AGG-A' });
  let busy;
  try { await api('/api/claims', { eventId: id, deviceId: 'DEV-1', aggregatorId: 'AGG-B' }); }
  catch (e) { busy = e; }
  check('同设备第二个聚合商声明被拒', busy?.code === 'DEVICE_ALREADY_CLAIMED', busy?.code);
  // 第二台设备，第二事件重叠
  await api('/api/claims', { eventId: id, deviceId: 'DEV-2', aggregatorId: 'AGG-B' });
  let overlap;
  try { await api('/api/events', { meterId: 'MP-1', targetKw: 10, startMs: start + I, endMs: end }); }
  catch (e) { overlap = e; }
  check('时窗重叠事件被拒', overlap?.code === 'OVERLAPPING_WINDOW', overlap?.code);

  console.log('场景 B：时间推进到开始 —— 基线冻结');
  await api('/api/sim/tick', { minutes: (start - st0.now) / 60000 });
  let st = await api('/api/state', null, 'GET');
  let e1 = st.events.find((e) => e.id === id);
  check('事件激活', e1.status === 'ACTIVE');
  check('基线 v1 已冻结', e1.baselineVersions.length === 1 && e1.baselineVersions[0].days.length >= 5,
    `依据 ${e1.baselineVersions[0]?.days.length} 日`);

  console.log('场景 C：回执乱序（seq3 先到、seq2 后到自动排水）');
  await api('/api/receipts', { eventId: id, deviceId: 'DEV-1', status: 'ACCEPTED', requestedKw: 40, clientSeq: 1 });
  const jump = await api('/api/receipts', { eventId: id, deviceId: 'DEV-1', status: 'EXECUTING', requestedKw: 40, clientSeq: 3 });
  check('跳序 seq3 缓冲', jump.buffered === true && jump.expectSeq === 2);
  const fill = await api('/api/receipts', { eventId: id, deviceId: 'DEV-1', status: 'EXECUTING', requestedKw: 40, clientSeq: 2 });
  check('seq2 到达后排水 seq3', fill.drained === 1, `drained=${fill.drained}`);
  // DEV-2 拒绝参与
  await api('/api/receipts', { eventId: id, deviceId: 'DEV-2', status: 'DECLINED' });

  console.log('场景 D：撤销 vs 执行并发（第二个事件做演示）');
  // 事件1窗口为 4 小时；让事件2在事件1窗口内（90 分钟后）开始
  const ev2 = await api('/api/events', { meterId: 'MP-2', targetKw: 20, startInMinutes: 90, durationIntervals: 4 });
  const id2 = ev2.event.id;
  await api('/api/claims', { eventId: id2, deviceId: 'DEV-3', aggregatorId: 'AGG-B' });
  await api('/api/sim/tick', { minutes: 90 });
  st = await api('/api/state', null, 'GET');
  e1 = st.events.find((e) => e.id === id);
  check('第一个事件仍在执行窗口', e1.status === 'ACTIVE', e1.status);
  // 事件2开始后先声明执行，再撤销
  await api('/api/receipts', { eventId: id2, deviceId: 'DEV-3', status: 'EXECUTING', requestedKw: 20 });
  const cancel = await api('/api/events/cancel', { eventId: id2, reason: '电网恢复' });
  check('撤销立即释放设备', cancel.released.includes('DEV-3'));
  let afterCancel;
  try { await api('/api/receipts', { eventId: id2, deviceId: 'DEV-3', status: 'EXECUTING', requestedKw: 20 }); }
  catch (e) { afterCancel = e; }
  check('撤销后的执行回报被拒', afterCancel?.code === 'EVENT_RECALLED', afterCancel?.code);
  const lateRec = await api('/api/receipts', { eventId: id2, deviceId: 'DEV-3', status: 'RECOVERED' });
  check('撤销后迟到 RECOVERED 仍记录', lateRec.accepted === true);

  console.log('场景 E：通信中断 -> 数据缺口 -> INCONCLUSIVE（用事件3）');
  const ev3 = await api('/api/events', { meterId: 'MP-3', targetKw: 30, startInMinutes: 1500, durationIntervals: 8 });
  const id3 = ev3.event.id;
  await api('/api/claims', { eventId: id3, deviceId: 'DEV-4', aggregatorId: 'AGG-A' });
  // 把 MP-3 中断后推进到事件3并结束
  await api('/api/meters/offline', { meterId: 'MP-3', offline: true });
  await api('/api/sim/tick', { minutes: 1500 });
  await api('/api/receipts', { eventId: id3, deviceId: 'DEV-4', status: 'EXECUTING', requestedKw: 30 });
  await api('/api/sim/tick', { minutes: 130 }); // 跨过结束
  st = await api('/api/state', null, 'GET');
  const r3v1 = st.events.find((e) => e.id === id3).reports[0];
  check('中断事件结束、全部缺口', r3v1 && r3v1.gapCount === 8 && r3v1.verdict === 'INCONCLUSIVE',
    r3v1 && `${r3v1.verdict}/${r3v1.gapCount}`);
  await api('/api/meters/offline', { meterId: 'MP-3', offline: false });

  console.log('场景 F：事件1关闭 -> v1 原始裁决');
  st = await api('/api/state', null, 'GET');
  e1 = st.events.find((e) => e.id === id);
  if (e1.status !== 'CLOSED') await api('/api/sim/tick', { minutes: Math.ceil((e1.endMs + I - st.now) / 60000) });
  st = await api('/api/state', null, 'GET');
  e1 = st.events.find((e) => e.id === id);
  const v1 = e1.reports.find((r) => r.version === 1);
  check('事件已关闭', e1.status === 'CLOSED');
  check('v1 原始裁决存在且有正削减', v1 && v1.kind === 'ORIGINAL' && v1.reductionKwh > 0,
    v1 && `${v1.verdict} ${v1.reductionKwh}/${v1.targetKwh}kWh`);

  console.log('场景 G：迟到电表数据只能订正，v1 不可改写');
  const v1Full = await api(`/api/reports/${id}/versions/1`, null, 'GET');
  const v1Hash = v1Full.hash;
  const corr = await api('/api/late-history', { meterId: 'MP-1', dayOffset: 4 });
  check('迟到 D-4 触发基线订正', corr.baselineCorrected.some((b) => b.eventId === id && b.version === 2));
  check('产生 v2 订正报告', corr.reportsIssued.some((x) => x.endsWith(':v2')));
  const v1After = await api(`/api/reports/${id}/versions/1`, null, 'GET');
  check('v1 报告哈希字节级不变', v1After.hash === v1Hash);
  check('v1 基线版本仍为 1', v1After.baselineVersion === 1);
  const v2 = await api(`/api/reports/${id}/versions/2`, null, 'GET');
  check('v2 锚定基线 v2', v2.baselineVersion === 2 && v2.kind === 'CORRECTED');
  // 重复补送同一天被拒
  let dupDay;
  try { await api('/api/late-history', { meterId: 'MP-1', dayOffset: 4 }); } catch (e) { dupDay = e; }
  check('重复历史日被拒（不可变）', dupDay?.code === 'DAY_PRESENT', dupDay?.code);
  // 无新证据时不产生新版本（再补传窗口实际：事件1窗口无缺口 -> 0）
  const bf1 = await api('/api/backfill', { eventId: id });
  check('无缺口补传不产生新版本', bf1.reportsIssued.length === 0);
  const bf3 = await api('/api/backfill', { eventId: id3 });
  check('事件3缺口补传产生订正报告', bf3.reportsIssued.length === 1);

  console.log('场景 H：哈希链 + 报告指纹校验');
  const chain = await api('/api/chain/verify', null, 'GET');
  check('哈希链完整', chain.ok, `length=${chain.length}`);
  check('所有报告指纹锚定完好', chain.reportChecks.every((r) => r.anchorIntact),
    `${chain.reportChecks.filter((r) => r.anchorIntact).length}/${chain.reportChecks.length}`);
  const vf = await api(`/api/reports/${id}/versions/2/verify`, null, 'GET');
  check('v2 报告可独立重算指纹', vf.bodyHashMatches);

  console.log('场景 I：履约异议处置（受理/幂等/唯一待处理/材料顺序/审核终态）');
  const v1Rep = await api(`/api/reports/${id}/versions/1`, null, 'GET');
  const dspBody = { requestId: 'REQ-E2E-1', aggregatorId: 'AGG-A', reportId: v1Rep.reportId, reportHash: v1Rep.hash, reason: '交付率认定存疑' };
  const filed = await api('/api/disputes', dspBody);
  check('异议受理为待处理，时限=签发后48h', filed.dispute.status === 'PENDING' &&
    filed.dispute.deadline === v1Rep.issuedAt + 48 * 3600 * 1000, filed.dispute.disputeId);
  const dspId = filed.dispute.disputeId;
  const dupFile = await api('/api/disputes', dspBody);
  check('同请求号同正文返回原结果', dupFile.idempotent === true && dupFile.dispute.disputeId === dspId);
  let reqConflict;
  try { await api('/api/disputes', { ...dspBody, reason: '改动正文' }); } catch (e) { reqConflict = e; }
  check('同请求号不同正文返回 409', reqConflict?.code === 'REQUEST_ID_CONFLICT' && reqConflict?.status === 409, reqConflict?.code);
  let pending2;
  try { await api('/api/disputes', { ...dspBody, requestId: 'REQ-E2E-2' }); } catch (e) { pending2 = e; }
  check('同一代理商同一标的仅一个待处理', pending2?.code === 'DISPUTE_PENDING_EXISTS', pending2?.code);
  let hashBad;
  try { await api('/api/disputes', { ...dspBody, requestId: 'REQ-E2E-3', reportHash: '0'.repeat(64) }); } catch (e) { hashBad = e; }
  check('标的指纹不符被拒', hashBad?.code === 'REPORT_HASH_MISMATCH', hashBad?.code);

  const sup1 = await api(`/api/disputes/${dspId}/supplements`, { requestId: 'REQ-E2E-S1', aggregatorId: 'AGG-A', note: '电表原始脉冲记录' });
  const sup2 = await api(`/api/disputes/${dspId}/supplements`, { requestId: 'REQ-E2E-S2', aggregatorId: 'AGG-A', note: '现场运行日志' });
  check('材料顺序追加序号单调', sup1.material.seq === 1 && sup2.material.seq === 2);
  let seqBad;
  try { await api(`/api/disputes/${dspId}/supplements`, { requestId: 'REQ-E2E-S3', aggregatorId: 'AGG-A', note: '跳序', materialSeq: 9 }); }
  catch (e) { seqBad = e; }
  check('材料跳序被拒', seqBad?.code === 'MATERIAL_SEQ_CONFLICT', seqBad?.code);
  const detail = await api(`/api/disputes/${dspId}`, null, 'GET');
  check('工单历史含受理与两次补充', detail.history.map((h) => h.type).join(',') === 'FILED,SUPPLEMENTED,SUPPLEMENTED' &&
    detail.materials.map((m) => m.seq).join(',') === '1,2');

  const resolved = await api(`/api/disputes/${dspId}/resolution`, { requestId: 'REQ-E2E-R1', outcome: 'UPHELD', comment: '复核后维持原裁定，异议记录在案' });
  check('审核通过进入终态', resolved.dispute.status === 'UPHELD' && resolved.dispute.resolution.outcome === 'UPHELD');
  let reResolve;
  try { await api(`/api/disputes/${dspId}/resolution`, { requestId: 'REQ-E2E-R2', outcome: 'REJECTED' }); } catch (e) { reResolve = e; }
  check('终态后不可再次裁定', reResolve?.code === 'DISPUTE_TERMINAL', reResolve?.code);
  let supLate;
  try { await api(`/api/disputes/${dspId}/supplements`, { requestId: 'REQ-E2E-S4', aggregatorId: 'AGG-A', note: '终态后补充' }); }
  catch (e) { supLate = e; }
  check('终态后不可再补充材料', supLate?.code === 'DISPUTE_TERMINAL', supLate?.code);

  const v1AfterDispute = await api(`/api/reports/${id}/versions/1`, null, 'GET');
  check('被质疑的原始裁定内容不变', v1AfterDispute.hash === v1Hash);
  const stFinal = await api('/api/state', null, 'GET');
  check('state 暴露异议工单', stFinal.disputes.some((d) => d.disputeId === dspId && d.status === 'UPHELD'));
  const chainFinal = await api('/api/chain/verify', null, 'GET');
  check('异议流程后哈希链仍完整', chainFinal.ok, `length=${chainFinal.length}`);

  console.log('场景 J：现场网关离线作业包（制包/围栏/分段/释放/移交/过期/恢复）');
  const pkgStart = Math.ceil((stFinal.now + 60 * 60000) / I) * I;
  const pkgEnd = pkgStart + 8 * I;
  const pev = await api('/api/events', { meterId: 'MP-1', targetKw: 40, startMs: pkgStart, endMs: pkgEnd });
  const pevId = pev.event.id;
  // 主演示包：两设备两序号；乱序/移交/旧围栏都在它上面（只交 seq1 或挂起 seq2，保持开放）
  const mkH = await api('/api/packages', { eventId: pevId, deviceIds: ['DEV-1', 'DEV-2'], validUntilMs: pkgEnd });
  const pidH = mkH.package.packageId;
  const pid = pidH;
  check('包锚定事件固定版本（eventRefHash/摘要/Ed25519 签名）',
    /^[0-9a-f]{64}$/.test(mkH.package.eventRefHash) && mkH.bundle.signature.length === 128, mkH.package.manifestHash.slice(0, 12));
  const mvf = await api(`/api/packages/${pid}/verify`, null, 'GET');
  check('只读包摘要复算 + 验签通过', mvf.digestMatches && mvf.signatureValid);
  // 重复设备
  let dupDev;
  try { await api('/api/packages', { eventId: pevId, deviceIds: ['DEV-2'] }); } catch (e) { dupDev = e; }
  check('不同包不得重复包含同一设备', dupDev?.code === 'DEVICE_IN_OTHER_PACKAGE', dupDev?.code);
  let dupBatch;
  try { await api('/api/packages', { eventId: pevId, deviceIds: ['DEV-1', 'DEV-1'] }); } catch (e) { dupBatch = e; }
  check('批次内重复设备被拒', dupBatch?.code === 'DUPLICATE_DEVICE_IN_BATCH', dupBatch?.code);

  const c1 = await api(`/api/packages/${pid}/claim`, { gatewayId: 'GW-1' });
  check('网关领取获得递增围栏号 fence=1', c1.fence === 1);
  const c1dup = await api(`/api/packages/${pid}/claim`, { gatewayId: 'GW-1' });
  check('同网关重复领取幂等（不换围栏）', c1dup.idempotent === true && c1dup.fence === 1);
  let held;
  try { await api(`/api/packages/${pid}/claim`, { gatewayId: 'GW-2' }); } catch (e) { held = e; }
  check('他网关领取被拒 PACKAGE_HELD', held?.code === 'PACKAGE_HELD', held?.code);

  // 越界 / 设备不符 / 摘要不符
  let oor, oos, pdm;
  try { await api(`/api/packages/${pid}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'e1', items: [{ seq: 9, outcome: 'EXECUTED' }] }); }
  catch (e) { oor = e; }
  check('越界序号被拒 SEQ_OUT_OF_RANGE', oor?.code === 'SEQ_OUT_OF_RANGE', oor?.code);
  try { await api(`/api/packages/${pid}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'e2', items: [{ seq: 1, deviceId: 'DEV-2', outcome: 'EXECUTED' }] }); }
  catch (e) { oos = e; }
  check('越界设备被拒 DEVICE_OUT_OF_SCOPE', oos?.code === 'DEVICE_OUT_OF_SCOPE', oos?.code);
  try { await api(`/api/packages/${pid}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'e3', manifestHash: '0'.repeat(64), items: [{ seq: 1, outcome: 'EXECUTED' }] }); }
  catch (e) { pdm = e; }
  check('清单摘要不匹配被拒', pdm?.code === 'PACKAGE_DIGEST_MISMATCH', pdm?.code);

  // 乱序分段：高位 seq2 先到挂起，seq1 补齐后排水（两序号齐了会自动完成，
  // 因此为保持包开放做后续移交演示，这里先用 seq3 不可行——改为在另一包 pidRel 演示释放，
  // 本包仅演示挂起：只发 seq2，不补 seq1，包保持 OPEN 且有挂起证据）。
  await api(`/api/packages/${pidH}/claim`, { gatewayId: 'GW-1' });
  const segHi = await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'J-HI', items: [{ seq: 2, outcome: 'SKIPPED', reason: '现场不可执行' }] });
  check('高位乱序分段挂起（wm=0, pending=2）', segHi.watermark === 0 && segHi.pending.join() === '2');
  // 完全相同分段重传（上传超时重试）：检查点稳定
  const segHiRetry = await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'J-HI', items: [{ seq: 2, outcome: 'SKIPPED', reason: '现场不可执行' }] });
  check('相同分段重传不重复计数，检查点不变', segHiRetry.duplicate === true && segHiRetry.checkpoint === segHi.checkpoint);
  // 补 seq1 -> 排水 1,2 自动完成关闭（在独立的“完成包”上做，避免主包关闭；
  // 用 MP-3 包演示完整排水与自动 COMPLETED）
  const evDrain = await api('/api/events', { meterId: 'MP-3', targetKw: 30, startMs: pkgStart, endMs: pkgEnd });
  const pkDrain = await api('/api/packages', { eventId: evDrain.event.id, deviceIds: ['DEV-4', 'DEV-5'], validUntilMs: pkgEnd });
  const pidDrain = pkDrain.package.packageId;
  await api(`/api/packages/${pidDrain}/claim`, { gatewayId: 'GW-3' });
  await api(`/api/packages/${pidDrain}/segments`, { gatewayId: 'GW-3', fence: 1, segmentId: 'D-HI', items: [{ seq: 2, outcome: 'SKIPPED' }] });
  const segLo = await api(`/api/packages/${pidDrain}/segments`, { gatewayId: 'GW-3', fence: 1, segmentId: 'D-LO', items: [{ seq: 1, outcome: 'EXECUTED' }] });
  check('缺口补齐自动排水（1,2）并自动完成', segLo.merged.join() === '1,2' && segLo.closed === true);
  // 序号内容变化（主包：seq2 已挂起 SKIPPED）
  let scc;
  try { await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'J-HI', items: [{ seq: 2, outcome: 'FAILED' }] }); }
  catch (e) { scc = e; }
  check('同段号不同内容 SEGMENT_CONFLICT', scc?.code === 'SEGMENT_CONFLICT', scc?.code);
  let scc2;
  try { await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'J-X', items: [{ seq: 2, outcome: 'EXECUTED' }] }); }
  catch (e) { scc2 = e; }
  check('同序号不同结果 SEQ_CONTENT_CONFLICT', scc2?.code === 'SEQ_CONTENT_CONFLICT', scc2?.code);

  // 主包当前仅挂起 seq2（无已合并进度）：首条执行回执前可释放 -> 重新领取
  const rel = await api(`/api/packages/${pidH}/release`, { gatewayId: 'GW-1', fence: 1 });
  check('首条执行回执前可释放（nextFence=2）', rel.nextFence === 2 && rel.package.heldBy === null);
  // 旧网关旧围栏上传失效
  let staleRel;
  try { await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-1', fence: 1, segmentId: 'J-R1', items: [{ seq: 1, outcome: 'EXECUTED' }] }); }
  catch (e) { staleRel = e; }
  check('释放后旧网关回执 STALE_FENCE', staleRel?.code === 'STALE_FENCE', staleRel?.code);
  const c2 = await api(`/api/packages/${pidH}/claim`, { gatewayId: 'GW-2' });
  check('释放后重新领取获得新围栏 fence=2（挂起缺口已随释放清空）', c2.fence === 2 && c2.package.pendingSeqs.length === 0);

  // 新领取者上传 seq1（形成已合并进度，包仍 OPEN：seq2 未交）
  const segNew = await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-2', fence: 2, segmentId: 'N-1', items: [{ seq: 1, outcome: 'EXECUTED' }] });
  check('新领取者推进 wm=1，包保持开放', segNew.watermark === 1 && segNew.closed === false);
  // 有进度后不能自助释放，只能强制移交
  let relLocked;
  try { await api(`/api/packages/${pidH}/release`, { gatewayId: 'GW-2', fence: 2 }); } catch (e) { relLocked = e; }
  check('已有进度自助释放被拒', relLocked?.code === 'PACKAGE_PROGRESS_LOCKED', relLocked?.code);
  const ho1 = await api(`/api/packages/${pidH}/handover`, { toGatewayId: 'GW-3', expectedFence: 2, reason: 'GW-2 通信失联' });
  check('强制移交保留证据并轮换围栏 fence=3', ho1.fence === 3 && ho1.package.mergedCount === 1);
  let hoRace;
  try { await api(`/api/packages/${pidH}/handover`, { toGatewayId: 'GW-1', expectedFence: 2 }); } catch (e) { hoRace = e; }
  check('移交竞争（陈旧围栏）FENCE_CONFLICT', hoRace?.code === 'FENCE_CONFLICT', hoRace?.code);
  // 旧领取者恢复联网上传 -> STALE_FENCE，不覆盖新领取者
  let stale;
  try { await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-2', fence: 2, segmentId: 'J-OLD', items: [{ seq: 2, outcome: 'FAILED' }] }); }
  catch (e) { stale = e; }
  check('旧围栏回执失效 STALE_FENCE（不覆盖新进度）', stale?.code === 'STALE_FENCE', stale?.code);

  // 包过期：短有效期包推进时间后关闭（事件开始得更晚，确保关闭原因为 EXPIRED）
  const evExp = await api('/api/events', { meterId: 'MP-2', targetKw: 20, startMs: pkgStart + 4 * I, endMs: pkgEnd });
  const pkE = await api('/api/packages', { eventId: evExp.event.id, deviceIds: ['DEV-3'], validityMinutes: 30 });
  await api('/api/sim/tick', { minutes: 45 });
  const pvE = await api(`/api/packages/${pkE.package.packageId}`, null, 'GET');
  check('过期包自动关闭 EXPIRED', pvE.status === 'CLOSED' && pvE.closeReason === 'EXPIRED');
  let claimExp;
  try { await api(`/api/packages/${pkE.package.packageId}/claim`, { gatewayId: 'GW-1' }); } catch (e) { claimExp = e; }
  check('过期包不可领取（410）', claimExp?.code === 'PACKAGE_CLOSED' && claimExp?.status === 410, claimExp?.code);
  // 过期释放设备：DEV-3 可重新切包
  const pkERe = await api('/api/packages', { eventId: evExp.event.id, deviceIds: ['DEV-3'], validityMinutes: 300 });
  check('关闭后设备可被新包包含', !!pkERe.package.packageId);
  // 事件撤销 -> 未关闭包关闭
  const cancelPkg = await api('/api/events/cancel', { eventId: evExp.event.id, reason: '演练中止' });
  check('撤销事件关闭其作业包', cancelPkg.packagesClosed.includes(pkERe.package.packageId));

  // 事件开始后未领取包关闭、已领取包可继续（pidH 由 GW-3 持有 fence=3）
  await api('/api/sim/tick', { minutes: Math.ceil((pkgStart - (await api('/api/state', null, 'GET')).now) / 60000) });
  const pvOpen = await api(`/api/packages/${pidH}`, null, 'GET');
  check('已领取包在事件开始后仍 OPEN 可继续', pvOpen.status === 'OPEN');
  const finish = await api(`/api/packages/${pidH}/segments`, { gatewayId: 'GW-3', fence: 3, segmentId: 'J-FIN', items: [{ seq: 2, outcome: 'FAILED', reason: '设备故障' }] });
  check('新领取者补齐最后序号自动 COMPLETED（证据=1 执行 + 1 失败）',
    finish.closed === true && finish.mergedCount === 2 && finish.package.counts.EXECUTED === 1 && finish.package.counts.FAILED === 1);

  // 审计历史
  const aud = await api(`/api/packages/${pidH}/audit`, null, 'GET');
  check('审计历史含领取/移交/分段/关闭且锚定哈希链',
    aud.records.length >= 4 && aud.records.every((r) => /^[0-9a-f]{64}$/.test(r.hash)) &&
    aud.history.some((h) => h.type === 'HANDED_OVER'),
    `${aud.records.length} 条链上记录`);
  const chainJ = await api('/api/chain/verify', null, 'GET');
  check('离线包流程后哈希链仍完整', chainJ.ok, `length=${chainJ.length}`);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E 异常', e); process.exit(1); });
