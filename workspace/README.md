# 电力需求响应（Demand Response）事件编排服务

运营方按 **计量点 / 基线算法 / 目标削减量 / 事件时窗** 发布指令；参与设备回报 **接受 / 执行 / 恢复** 状态。
基线在事件开始时冻结；迟到的电表读数**只能形成订正版**，永不改写原始执行裁决。多个聚合商声明同一设备、
指令撤销与设备执行并发、回执乱序、通信中断等场景下，**一台设备同一时刻只归属一个有效事件，并保持明确水位**。

- 零依赖、纯 Node.js（≥ 20），无数据库、无构建步骤。
- **事件溯源 + SHA-256 哈希链**：所有裁决（发布、冻结、声明、回执、撤销、读数、报告）都是只增记录，可独立核验；任何历史篡改都会被检出。
- 仿真时钟：时间只由 `/api/sim/tick` 推进，裁决、迟到数据、订正版本完全可重复演示。

## 快速开始

```bash
npm start                 # http://localhost:8080
# 可选：PORT=8080 DR_MEMORY=1 npm start   # 纯内存，不落盘
```

- 设备执行页面（运营台）：http://localhost:8080/
- 自动化测试：`npm test`（66 个领域/恢复单测，含 12 个通知投递契约、11 个履约异议契约、16 个离线作业包契约）
- 端到端场景：先 `npm start`，再 `npm run test:e2e`（69 项 HTTP 断言）

## 聚合商通知投递模块（独立服务，`notifier/`）

事件 **发布 / 撤销 / 开始 / 结束 / 报告订正** 时为订阅方生成 **Ed25519 签名的不可变信封**，
按订阅方维护独立的持久待发队列：同订阅方严格按事件顺序投递、稳定幂等键处理超时重投、
不同订阅方互不阻塞、重启后继续未确认投递且游标不重复推进。支持 WebSub 风格订阅校验、
HMAC 回执确认 API、密钥轮换（旧在途通知仍可验）、死信人工重新入队与签名证据页。

```bash
npm run notifier          # 投递服务 + 投递台 → http://localhost:8091/
npm run demo:notifier     # 一键演示 7 个故障/恢复场景（暂时失败/确认丢失/重复确认/
                          #                 轮换验签/死信重入/重启恢复/证据可验）
npm run test:notifier     # 24 项真实 HTTP 端到端断言
```

该服务只读尾随 `data/events.log`（`sourceRef=orch:<seq>` 幂等），不回写编排内核；
详见 [`notifier/README.md`](notifier/README.md)。

## 履约异议处置工作流

资源代理商对已封存裁定（报告版本）提起异议，全程事件溯源，原裁定内容永不改写：

- **受理**：代理商须在**截止时刻**（裁定签发后 48 仿真小时）前，以裁定的 **编号 + 内容指纹** 为标的提交异议；
  指纹与封存裁定不符即拒（`REPORT_HASH_MISMATCH`），超期即拒（`DISPUTE_DEADLINE_PASSED`）。
- **客户请求号幂等**：`requestId` 必填。同一请求号 + 相同正文 → 返回原受理结果（不新增记录）；
  同一请求号 + 不同正文 → `409 REQUEST_ID_CONFLICT`。受理/补充/审核三个命令均遵守。
- **唯一待处理**：同一代理商对同一标的只允许一个 `PENDING` 实例（`DISPUTE_PENDING_EXISTS`）；
  审核终结后可对该标的再提新实例。
- **补充材料只能顺序追加**：`materialSeq` 单调递增（显式跳序 `MATERIAL_SEQ_CONFLICT`），
  仅提起方本人可补（`DISPUTE_OWNER_MISMATCH`），终态后不可再补。
- **审核终态**：`UPHELD`（通过）/ `REJECTED`（驳回）一经作出不可再次裁定（`DISPUTE_TERMINAL`）；
  审核只形成结论记录，**被质疑的原始裁定字节级不变**。
- **后补计量数据**：迟到数据产生新裁定版本时，旧异议继续锚定原标的（编号+指纹），**不自动转移**；
  新版本作为新标的可单独受理，两类待处理并存。
- **重启恢复**：待处理状态、截止时限、材料次序全部由链上记录重放重建，重启前后完全一致。
- **投递通知**：受理 / 补充 / 结论分别映射为 `dr.dispute.accepted / .supplemented / .resolved`，
  由投递服务生成 Ed25519 签名信封并按 `orch:<seq>` 去重。
- 运营台底部“④ 提起履约异议 / 异议工单”面板支持：提起异议、补充材料、审核通过/驳回、查看历史时间线。

## 现场网关离线作业包（通信不稳定场景）

运营人员按一个**已发布事件的固定版本**为设备批次切出**只读作业包**；现场网关领取后离线执行、分段回传：

- **只读包**：`manifest`（固定事件版本锚点 `eventRefHash` + 设备批次 + 包内连续指令序号 + 有效期）
  经键名排序规范化后计算 `manifestHash = sha256(canonical)`，并用运营方 **Ed25519 私钥签名**。
  清单任何字节被改动都会导致摘要不符 / 签名失效（`/api/packages/:id/verify` 可独立复核）。
- **设备批次互斥**：同一台设备同一时刻只能出现在一个**未关闭包**中（跨包重复 `DEVICE_IN_OTHER_PACKAGE`，
  批次内重复 `DUPLICATE_DEVICE_IN_BATCH`）；包关闭（过期/撤销/完成）后设备自动释放、可重新切包。
- **领取窗口**：事件被**撤销或开始后不再允许领取新包**——激活时未领取包以 `EVENT_STARTED` 关闭；
  已领取的包可继续执行。撤销事件会关闭其全部未关闭包（`EVENT_RECALLED`）。
- **递增围栏号（fencing token）**：每次领取获得 `fence+1`；同网关超时重试幂等返回原围栏。
  网关释放（仅首条执行回执前）后可被重新领取；**旧领取者恢复联网后凭旧围栏上传一律 `STALE_FENCE`，
  绝不覆盖新领取者进度**。
- **分段回执 + 稳定检查点**：按**包内序号**合并 EXECUTED/SKIPPED/FAILED，高位序号先到则挂起（HTTP 202），
  缺口补齐自动排水。检查点 = `sha256(canonical({fence, 已合并序号内容, 挂起缺口}))`，
  台账不变则检查点字节不变。
- **重传与拒绝语义**：完全相同的分段（包ID+段号+规范化条目，摘要由服务端复算）重传**不重复计数、
  不追加记录**，原样返回同一检查点；序号内容变化 `SEGMENT_CONFLICT`/`SEQ_CONTENT_CONFLICT`、
  越界序号 `SEQ_OUT_OF_RANGE`、越界设备 `DEVICE_OUT_OF_SCOPE`、清单摘要不符 `PACKAGE_DIGEST_MISMATCH`、
  分段摘要不符 `SEGMENT_DIGEST_MISMATCH`、已关闭包 `PACKAGE_CLOSED`（HTTP 410）均明确拒绝。
- **释放 / 强制移交**：首条执行回执前（无已合并进度）持有网关可自助**释放**，包回到可领取状态；
  已有进度后只能由运营人员**强制移交**——此前证据（回执/挂起/段台账）全部保留，围栏号轮换，
  `expectedFence` 用于检测移交竞争（`FENCE_CONFLICT`）。
- **有效期**：默认与事件时窗同寿，可单独指定；到期由时间推进惰性关闭（`EXPIRED`），之后不可领取/上传。
- **恢复契约**：领取关系、围栏、检查点、挂起缺口、回执次序全部由链上记录重放重建，重启后不倒退；
  恢复后用相同段号重传安全幂等，补齐缺口即可继续。
- 运营台“⑤ 离线作业包”面板支持：制包、领取、执行/跳过/失败分段上传、乱序高位分段、旧围栏演示、
  释放、强制移交、验签与审计历史时间线。

## 重启恢复契约（日志损坏 / 断电残尾）

服务重启时逐行重放 `data/events.log`，并对每条记录独立校验**序号连续性、prevHash 衔接、内容哈希**：

- **任何完整记录异常（序号被改写、中间断链、内容与哈希不符、结构性损坏）→ 只读隔离（QUARANTINED）**。
  - 检出**首个损坏位置**（seq、物理行号、字节偏移、原因）后立即停止重放，内存只保留最后一条验证通过记录之前的一致状态；
  - 服务**照常启动**：`GET /api/state`、`/api/log`、`/api/chain/verify`、报告查询与运营台页面均可只读访问，
    状态接口与页面横幅显示首个损坏位置；
  - **所有业务写入（含 `/api/sim/reset`）返回 HTTP 503（`LOG_QUARANTINED`），日志绝不追加、文件原样保留**；
  - 隔离不会因再次重启而自愈，需人工核验。
- **仅文件末尾的单条不完整记录可作为断电残尾恢复**：残尾必须是“未写完且无终止换行”的最后一个物理行。
  - 残尾按**原始字节**原样复制到 `data/quarantine/torn-tail-<时间戳>-<pid>.log`，
    同目录 `.meta.json` 留存字节长度、**残尾 sha256**、截断位置、最后一条完好记录的 seq/hash；
  - 主日志截断到残尾之前，服务从最后一条验证通过的记录恢复，**新记录延续原哈希链**（序号与 prevHash 接续）；
  - 残尾之后还有任何内容（多条坏行、坏行后仍有记录、带换行的坏物理行）一律按损坏隔离。
- 恢复后再次重启即为正常重启；`/api/state` 顶层暴露 `mode`（`OK`/`QUARANTINED`）、`readOnly`、`recovery`。

## 一页走查（运营台）

1. **发布指令**：左侧选择计量点、基线算法、目标削减 kW、时窗长度，发布。事件为 `SCHEDULED`，基线尚未冻结。
2. **设备声明**：中间表格为每个设备选择聚合商并“声明”。同一设备：
   - 同事件换聚合商 → `DEVICE_ALREADY_CLAIMED (409)`；
   - 声明到另一个仍有效的事件 → `DEVICE_BUSY (409)`。
3. 顶栏 **+15 分钟 / +1 小时** 推进时间。时间跨过事件开始点时自动 **冻结基线 v1** 并激活事件。
4. 对已声明设备发送 `ACCEPTED → EXECUTING → RECOVERED` 回执；可点 **↕ 乱序执行** 演示跳序号：
   高序号先到进入缓冲，缺口补齐后自动排水，过期重放返回 `STALE_SEQ`，每个设备都有单调 **watermark（wm）**。
5. 事件进行中点 **撤销指令**：设备立即释放（可被新事件声明），之后迟到的 `EXECUTING` 被拒绝，
   但迟到的 `RECOVERED` 仍会被记录为终态水位（不改变归属、不改写裁决）。
6. 在计量点面板 **中断通信** 后跨过事件结束：缺失区间形成 `DATA_GAP`，缺口过多时裁决为 `INCONCLUSIVE`。
7. 事件结束自动出具 **v1 原始裁决**（锚定冻结基线 v1 与结束时数据水位）。
8. 左下 **补送 MP-1 的 D-4 历史读数**：该历史日在种子数据中缺失。迟到数据
   - 产生 **基线 v2（BASELINE_CORRECTED）** 与 **报告 v2（CORRECTED）**；
   - **v1 字节级不变**（UI 中指纹前后一致，接口 `/api/reports/:id/versions/1` 哈希恒定）。
9. **补传选中事件窗口内缺失的实际读数**（通信恢复后的电表补传）：有缺口才产生新订正版；无新证据不产生新版本。
10. **验证事件链 + 报告指纹**：重新计算整条哈希链与每份报告的内容指纹。
11. 底部 **④ 履约异议**：选择聚合商与已封存裁定（编号+指纹），填写事由提交；
    同一请求号重复提交演示幂等，改动正文再提交得到 409；在工单卡片上顺序追加材料、
    审核通过/驳回（终态），展开“历史”查看完整时间线。
12. 底部 **⑤ 离线作业包**：选一个未开始事件、勾选设备批次制包（验签查看摘要/签名）；
    选择网关“领取”拿到围栏号；上传执行/跳过/失败分段、用“↕ 乱序高位分段”演示挂起与排水、
    重复点同一按钮演示超时重传（不重复计数、检查点不变）、“模拟旧围栏回执”看到 `STALE_FENCE`；
    上传一条进度后“释放”被拒，改用“运营强制移交”（围栏轮换、证据保留）；
    缩短有效期或撤销事件后观察包关闭；展开“审计历史”查看链上时间线。重启服务后可继续续传。

## 关键不变量（如何落地需求）

| 需求 | 实现 |
| --- | --- |
| 基线在事件开始时冻结 | 时间跨过 `startMs` 时写入 `BASELINE_FROZEN(version=1)`，此后基线对象只读 |
| 迟到数据只能订正，不能改写原始裁决 | 新读数只能追加；重算有差异才追加 `BASELINE_CORRECTED` / 新 `REPORT_ISSUED(version=n)`，v1 永不更新 |
| 同一区间读数不可变 | 已存在读数再次写入 → `CONFLICTING_READING(409)`，幂等重复写入安全忽略 |
| 一设备只属一个有效事件 | 声明时检查归属：重叠有效事件 `DEVICE_BUSY`；撤销/结束时 `DEVICE_RELEASED` |
| 撤销与执行并发 | 命令严格串行、按到达顺序裁决；撤销即释放归属，迟到 `RECOVERED` 作为终态水位留痕 |
| 回执乱序 | 每设备单调 `clientSeq` 水位；超前缓冲、缺口自动排水、过期拒绝（`STALE_SEQ`/`PHASE_CONFLICT`），状态机禁止非法跃迁 |
| 通信中断 | 表计离线期间无读数 → 区间缺口；裁决按缺口比例给 `INCONCLUSIVE`；恢复后补传只产生订正版 |
| 可验证的削减报告 | 报告含逐区间基线/实际/削减、设备履约行、裁决等级与 **内容指纹**；链上锚定，`/verify` 可独立重算 |
| 异议标的锚定 | 异议记录裁定的 `reportId`+`reportHash`；指纹不符/超截止时刻/同标的重复待处理均被拒 |
| 异议请求号幂等 | `requestId`+正文哈希入链；同号同文返回原结果，同号不同文 409；重启后台账不丢 |
| 异议材料与审核 | 材料 `materialSeq` 顺序追加；`UPHELD`/`REJECTED` 终态不可再裁定；原裁定内容永不改写 |
| 离线包只读可验 | 清单规范化哈希 + Ed25519 签名；固定版本锚定事件发布记录链哈希，改动即摘要/签名失效 |
| 批次设备互斥 | 未关闭包设备索引；跨包重复 `DEVICE_IN_OTHER_PACKAGE`，关闭后释放 |
| 事件开始/撤销不领新包 | 激活时关闭未领取包（`EVENT_STARTED`）；撤销关闭全部未关闭包（`EVENT_RECALLED`） |
| 旧围栏回执失效 | 领取/移交分配递增 fence；持有者+围栏双匹配才接受，否则 `STALE_FENCE`，新进度不被覆盖 |
| 分段幂等与稳定检查点 | segmentId+规范化条目摘要去重，重传不计数不追加；检查点由围栏+台账+挂起规范化哈希 |
| 乱序分段 | 包内序号水位；高位挂起 202、缺口补齐自动排水；越界/他设备/摘要不符/序号改写均拒绝 |
| 释放 vs 强制移交 | 无合并进度可自助释放重领；有进度仅运营移交，证据保留 + `expectedFence` 防移交竞争 |
| 包过期与恢复 | tick 惰性 `EXPIRED` 关闭；领取关系/检查点/挂起/次序全部由链重放，重启不倒退 |

报告裁决等级：`MET`（交付率 ≥ 100%）、`PARTIAL`（≥ 50%）、`MISSED`、`INCONCLUSIVE`（缺口 ≥ 40%）、
`NO_PARTICIPATION`、`RECALLED`。设备履约：`PERFORMED / UNDERPERFORMED / FAILED / OPT_OUT`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 运营台完整视图（含哈希链校验结果） |
| POST | `/api/events` | 发布事件 `{meterId,targetKw,algorithm,startInMinutes,durationIntervals}` 或显式 `startMs/endMs` |
| POST | `/api/events/cancel` | `{eventId,reason}` 撤销 |
| POST | `/api/claims` | 聚合商声明设备 `{eventId,deviceId,aggregatorId}` |
| POST | `/api/receipts` | 设备回执 `{eventId,deviceId,status,requestedKw?,clientSeq?}`（缓冲返回 202） |
| POST | `/api/readings` | 通用读数上报 `{items:[{meterId,ts,value}]}` |
| POST | `/api/late-history` | 迟到历史日 `{meterId,dayOffset}` |
| POST | `/api/backfill` | 补传事件窗口内缺失实际读数 `{eventId}` |
| POST | `/api/meters/offline` | 模拟通信中断/恢复 `{meterId,offline}` |
| POST | `/api/sim/tick` | 推进仿真时钟 `{minutes}` |
| POST | `/api/sim/reset` | 截断日志并重建种子数据 |
| POST | `/api/disputes` | 提起异议 `{requestId,aggregatorId,reportId,reportHash,reason}`（幂等重放返回 200，新受理 201） |
| GET | `/api/disputes?status=&aggregatorId=` | 异议工单列表 |
| GET | `/api/disputes/:id` | 工单详情（材料次序 + 历史时间线） |
| POST | `/api/disputes/:id/supplements` | 顺序补充材料 `{requestId,aggregatorId,note,kind?,materialSeq?}` |
| POST | `/api/disputes/:id/resolution` | 审核 `{requestId,outcome:UPHELD\|REJECTED,comment?,resolvedBy?}` |
| POST | `/api/packages` | 制包 `{eventId,deviceIds:[...],validUntilMs?|validityMinutes?}`（只读包：摘要+Ed25519 签名） |
| GET | `/api/packages?eventId=&status=` | 作业包列表 |
| GET | `/api/packages/:id` | 作业包详情（围栏/水位/计数/检查点/挂起缺口/时间线） |
| GET | `/api/packages/:id/verify` | 独立复核清单摘要 + Ed25519 验签 |
| GET | `/api/packages/:id/audit` | 审计历史（时间线 + 链上记录 seq/hash 锚点） |
| POST | `/api/packages/:id/claim` | 网关领取 `{gatewayId}`（幂等重试返回原围栏） |
| POST | `/api/packages/:id/release` | 首条执行回执前释放 `{gatewayId,fence}` |
| POST | `/api/packages/:id/handover` | 运营强制移交 `{toGatewayId,expectedFence?,reason?,operator?}`（保留证据+换围栏） |
| POST | `/api/packages/:id/segments` | 分段回执 `{gatewayId,fence,segmentId,items:[{seq,outcome:EXECUTED\|SKIPPED\|FAILED,reason?,deviceId?}],manifestHash?,segmentHash?}`（挂起 202；相同重传 200 幂等） |
| GET | `/api/operator-key` | 运营方验签公钥（PEM）与 keyId |
| GET | `/api/reports/:eventId/versions/:v` | 完整报告（逐区间 + 设备行 + 指纹） |
| GET | `/api/reports/:eventId/versions/:v/verify` | 独立重算报告指纹 |
| GET | `/api/chain/verify` | 哈希链 + 全部报告指纹校验 |
| GET | `/api/log?type=&limit=` | 原始裁决日志（JSONL 记录） |

## 数据模型（事件类型）

事件日志默认落盘到 `data/events.log`（每行一条 JSON，UTF-8 JSONL）：

```
SEED_CLOCK / SEED_AGGREGATOR / SEED_METER / SEED_DEVICE / SEED_GATEWAY / SEED_DAY_READINGS
EVENT_PUBLISHED · BASELINE_FROZEN · EVENT_ACTIVATED · EVENT_CANCELLED · EVENT_CLOSED
DEVICE_CLAIMED · DEVICE_RELEASED
DEVICE_RECEIPT · RECEIPT_BUFFERED · RECEIPT_DROPPED
READINGS_BATCH · DAY_READINGS_LOADED · SIM_METER_OFFLINE · SIM_TICK
BASELINE_CORRECTED · REPORT_ISSUED
DISPUTE_FILED · DISPUTE_SUPPLEMENTED · DISPUTE_RESOLVED
PACKAGE_ISSUED · PACKAGE_CLAIMED · PACKAGE_RELEASED · PACKAGE_HANDED_OVER ·
PACKAGE_SEGMENT_ACCEPTED · PACKAGE_CLOSED
```

每条记录：`{seq,ts,type,payload,prevHash,hash}`，
`hash = sha256(规范化JSON({seq,ts,type,payload,prevHash}))`，规范化时键名排序，保证任意实现可复算。

## 目录

```
src/
  server.js       HTTP API + 静态页面
  kernel.js       领域内核（命令校验 → 追加记录 → 投影/水位）
  baseline.js     基线算法（近10均值 / 居中8日 / 近5均值，工作日同类日筛选）
  adjudication.js 削减报告纯函数（区间能量、裁决等级、内容指纹）
  store.js        只增日志 + SHA-256 哈希链（重启恢复：残尾归档续链 / 损坏只读隔离）
  offline.js      离线作业包纯函数（清单/摘要/Ed25519 验签/分段合并/稳定检查点）
  seed.js         确定性种子（2 聚合商 / 3 计量点 / 5 设备 / 3 现场网关 / 21 天 15 分钟曲线，含缺失日）
  clock.js        仿真时钟
  util.js         时间区间、规范化 JSON、哈希
public/           运营台（index.html + app.js，含隔离/残尾恢复横幅、履约异议面板、离线作业包面板）
test/kernel.test.js   14 个领域单测（node:test）
test/dispute.test.js  11 个履约异议单测（受理/幂等/材料顺序/终态/重启/投递映射）
test/offline-package.test.js 16 个离线作业包单测（制包/围栏/重传/乱序/释放/移交/过期/撤销/重启恢复）
test/recovery.test.js 13 个恢复契约单测（残尾/篡改/断链/503 边界/重启续链，含真实 HTTP）
scripts/e2e.mjs       69 项 HTTP 端到端断言（含场景 J 离线作业包 31 项）
```
