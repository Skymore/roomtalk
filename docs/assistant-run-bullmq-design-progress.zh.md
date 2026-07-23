# RoomTalk Assistant Run BullMQ 设计与实施进度

> 状态：代码、文档、完整验证与生产切换已完成
> 基线：`b7941513`（`assistant_runs` durable aggregate 已上线）  
> 开始日期：2026-07-22  
> 目标：用 BullMQ 接管普通聊天 AI 任务的调度与 Worker 运维，同时保持 PostgreSQL 中已经收敛的业务一致性协议。

## 1. 为什么继续演进

基线版本已经解决了 AI 流式消息最危险的一致性问题：一次 AI 请求会先在 PostgreSQL 中原子创建 streaming placeholder 和 `assistant_runs`；Worker 通过 generation fence 获得执行权；最终内容先保存为 immutable terminal payload，再在一个事务中更新 message、run 和房间费用。旧 Worker 不能覆盖新 generation，也不能复活已删除的 placeholder。

在本次改造前，任务调度仍由 App 进程内的 `AssistantRunWorker` 完成：

```text
App / Socket.IO
  ├─ 接收 ask_ai
  ├─ 写 PostgreSQL assistant_runs
  └─ 在同一进程轮询、claim、续租、重试和调用 Provider
```

这个实现正确，但运行边界还不够清楚：

- App 扩容会同时扩大 HTTP/Socket 与 AI Worker 数量，二者无法独立调节；
- 任务等待、退避和重试由 PostgreSQL 字段与轮询循环自己实现，运维可见性较弱；
- App 重启会同时中断连接服务和正在执行的 Provider 请求；
- 如果未来需要优先级、并发上限、延迟重试或暂停队列，还会继续扩张自建调度代码。

因此本阶段引入 BullMQ，但它只替换调度与运行时队列，不推翻已经验证的 PostgreSQL 聚合模型。

## 2. 最终职责边界

### 2.1 PostgreSQL：业务事实与跨系统提交意图

PostgreSQL 保存：

- 房间、成员、权限与 canonical messages；
- `assistant_runs` 的请求快照、业务状态、generation、terminal payload、错误和用量；
- `room_events` 客户端 changefeed；
- 房间 AI 费用汇总；
- `task_dispatch_outbox`，即“这个 run 需要被送到队列”的最小投递意图。

`assistant_runs` 是唯一业务事实源。判断一次运行是 queued、running、finalizing、complete、error 或 cancelled，只读 PostgreSQL，不读取 BullMQ job state，也不使用 BullMQ result backend。

### 2.2 BullMQ：任务调度与 Worker 运行时

BullMQ 保存和管理：

- waiting / active / delayed / retry 等运行状态；
- Worker 并发、锁和 stalled job 恢复；
- attempts、backoff、失败保留与运维查询；
- `jobId = runId` 的幂等队列入口。

BullMQ job payload 固定为：

```ts
{
  schemaVersion: 1,
  runId: string
}
```

队列不复制 prompt、上下文、Provider 凭据、terminal message 或费用。Worker 每次都用 `runId` 从 PostgreSQL 读取经过验证的 request payload。

### 2.3 Redis：一个实例，两个职责域

第一阶段继续使用一个 Redis 实例，避免为了概念纯度增加第二套备份、监控与故障处理。但代码和连接必须分开：

| 职责域 | 连接配置 | 数据例子 | 持久性 |
| --- | --- | --- | --- |
| Realtime | `REDIS_URL` | Socket adapter、presence、session、cache、transient AI stream | 可重建，但共享实例配置下也会进入 AOF |
| Queue | `QUEUE_REDIS_URL`，默认回落到 `REDIS_URL` | BullMQ waiting、active、delayed、locks | 运行队列需要 AOF |

当前 Compose Redis 改为：

- AOF 开启，`appendfsync everysec`；
- `maxmemory-policy noeviction`，避免队列 key 被静默驱逐；
- 保留独立命名空间与连接；
- 使用 named volume 保存 `/data`。

将来只要把 `QUEUE_REDIS_URL` 指向独立 Redis，就能拆分队列故障域，不需要修改业务代码或迁移 PostgreSQL 事实。

### 2.4 App 与 Worker：同镜像，不同进程

```text
roomtalk app
  ├─ HTTP / Socket.IO / auth
  ├─ 写 assistant_runs + task_dispatch_outbox
  ├─ dispatch relay
  └─ Redis transient subscriber → io.local

roomtalk ai-worker
  ├─ BullMQ Worker
  ├─ 从 PostgreSQL读取/claim assistant_run
  ├─ 调用 Provider
  ├─ 发布 transient chunks
  └─ stage + project terminal transaction
```

两者使用同一个构建镜像，分别运行 `npm start` 和 `npm run start:ai-worker`。这样不会在 Python 中重写 TypeScript Provider、A2UI、费用计算与消息协议，也能让 App 和 AI Worker 独立重启、扩容和观察。

## 3. 为什么还需要 `task_dispatch_outbox`

PostgreSQL 与 Redis 不能共享一个事务。以下直接写法存在不可接受的半状态：

```text
1. PostgreSQL commit assistant_run
2. queue.add(runId) 失败
3. 用户看到 placeholder，但任务永远不执行
```

反过来先入队也不安全：Worker 可能在 PostgreSQL commit 前读取 job，找不到 run。

因此创建请求的同一个 PostgreSQL 事务必须同时写入：

```text
streaming message
assistant_run
task_dispatch_outbox(run_id, pending)
room event after-image
```

Relay 的语义是 at-least-once：

1. claim 一小批 pending dispatch rows；
2. `queue.add({ runId }, { jobId: runId })`；
3. 成功后把 dispatch row 标为 dispatched；
4. 若 Relay 在第 2、3 步之间崩溃，下一次会重复 enqueue，但相同 `jobId` 使队列入口幂等；
5. Redis 不可用时，dispatch row 留在 PostgreSQL，恢复后继续投递。

这张表只回答“是否已尝试把 run 交给调度器”，不回答 run 是否成功，也不保存 Provider 结果。终态仍只由 `assistant_runs` 描述。

`dispatched` 也不是永久放弃恢复。App 还有一轮周期对账：先取得 PostgreSQL advisory lock，再读取仍为 queued/running/finalizing、且 dispatch 已确认并经过短暂 grace period 的 run。BullMQ job 缺失时用同一 `runId` 补建；job 已 failed 或已经 completed、但 PostgreSQL run 仍未终态时，把它重新放回 waiting。waiting、active 与 delayed job 不动。每轮只检查有界批次，满批次通过 runId cursor 轮转，因此不会在多实例上重复扫，也不会长期饿死后面的 run。这一层修的是 Redis 丢失/恢复和 attempts 耗尽，不重新发明 PostgreSQL scheduler。

## 4. 执行状态机与不变量

### 4.1 业务状态机

```text
queued
  └─ claim generation N → running
       ├─ provider 完成 → finalizing(terminal_payload)
       │                  └─ project → complete / error
       ├─ 可重试失败 → queued + BullMQ retry
       └─ placeholder 被删除 → cancelled
```

BullMQ 的 waiting/active/delayed/failed 是运行时状态，不取代这张业务状态机。

### 4.2 Worker 收到 job 后的规则

Worker 以 `runId` 读取 PostgreSQL：

- run 不存在：job 完成，记录 orphan 指标；
- `complete/error/cancelled`：job 幂等完成，不调用 Provider；
- `finalizing`：只执行 terminal projection，不重新调用 Provider；
- `queued`：原子 claim，并递增 generation 后调用 Provider；
- `running` 且仍由其他有效 owner 持有：当前 job 退出或重试，不抢占；
- generation/owner 失配：当前 Worker 已过期，停止发送 chunk 和写终态。

### 4.3 必须保持的 invariant

1. 一个 run 最多产生一次可计费 terminal projection。
2. Provider 成功后 terminal payload 一旦落库，任何重试都只能 project，不能再次调用 Provider。
3. 删除或截断 streaming placeholder 后，任何旧 job 都不能 INSERT 或 upsert 它。
4. 旧 generation 的 chunk、stream end 和 terminal write 都被拒绝。
5. Redis enqueue 前失败由 dispatch relay 补发；dispatch 已确认后 job 丢失或 attempts 耗尽，则由 active-run reconciler 修复。
6. BullMQ job 重复或旧 generation 接管冲突，不会产生第二个被接受的终态，也不会重复累计 RoomTalk 内部费用。
7. App 不消费 AI job；`ai-worker` 不接受用户 Socket 请求。
8. `room_events` 不承载 transient chunk，最终完整 message 仍通过 durable event 收敛。

这里必须把 exactly-once 的边界说准确：RoomTalk 能保证终态 projection 与内部费用结算只接受一次，但不能对所有外部 Provider 承诺只调用一次。如果 Provider 已接受请求，而 Worker 在 terminal payload 落库前退出，接管后的 generation 可能再次发起请求。某个 Provider 若提供可靠 idempotency key，可以为该集成单独增强；基础契约仍是 Provider 至少一次、旧 generation 不能提交结果。

## 5. Transient AI 流的跨进程路径

Worker 已不再持有 Socket.IO server，因此不能直接 `io.to(roomId).emit(...)`。它发布一个有界、版本化的 transient envelope 到 Redis；每个 App 实例订阅后，只向本机已授权连接发送：

```ts
{
  schemaVersion: 1,
  event: 'ai_chunk' | 'a2ui_update' | 'ai_stream_end' | 'ai_stream_error',
  roomId: string,
  messageId: string,
  runId: string,
  generation: number,
  chunkSeq?: number,
  payload: unknown
}
```

规则：

- payload 在发布前经过现有 safe-message/协议校验；
- App 发送完整 payload 前重新校验本机 socket 的房间授权；
- `runId + generation` 用于淘汰旧 Worker；
- `chunkSeq` 继续作为轻量顺序与诊断信息，不实现 chunk durable replay、乱序缓存或缺包重传；
- transient Pub/Sub 丢失时，客户端靠最终 durable `messages.upserted` 收敛。

## 6. 重试责任只有一处

迁移后由 BullMQ 决定何时再次运行 job，并配置有界 attempts 与指数 backoff。PostgreSQL 不再通过 `available_at` 扫描来调度下一次执行。

PostgreSQL 仍保留：

- `generation`：业务 fencing；
- 当前执行 owner/lease：阻止两个 generation 同时提交副作用，并支持失效接管；
- `attempt`：业务审计，可从每次成功 claim 递增；
- `terminal_payload`：Provider 已完成的不可变结果。

`available_at` 在迁移期间不再作为调度源；确认生产稳定后可在后续兼容 migration 中删除。首轮 cutover 不同时重写所有 schema 约束，避免把调度迁移和历史数据清理混成一个不可回滚步骤。

## 7. 健康、可观测性与降级语义

### 7.1 App

- liveness：Node HTTP process 可响应；
- readiness：PostgreSQL、realtime Redis、对象存储和 Socket adapter 可用；
- queue Redis/dispatch relay 异常：状态报告 degraded，但只要 PostgreSQL 正常，仍可接受 AI 请求并显示 queued placeholder，因为投递意图不会丢失；
- backlog 指标：pending/processing dispatch、BullMQ waiting/active/delayed/failed 与 oldest queued time；
- active-run reconciliation：advisory lock 下检查已 ack dispatch，missing job 补建，failed/completed-but-nonterminal job 重试。

### 7.2 AI Worker

- 独立 Compose healthcheck；
- 检查 queue Redis 连接、PostgreSQL 可读与 Worker event-loop heartbeat；Worker 用共享 TTL key 证明“至少一个 consumer 存活”；
- 指标/日志至少包括 waiting、active、delayed、failed、stalled、runId、generation、attempt、provider latency；
- 日志不得包含 prompt、凭据或完整上下文。

### 7.3 队列保留

- completed jobs 有界保留，用于近期诊断，不作为审计账本；
- failed jobs保留更长但仍有上限；
- PostgreSQL `assistant_runs` 才负责长期业务查询与审计；
- 不启用 BullMQ result backend 作为产品读路径。

## 8. 重要用户用例测试

测试以用户可见后果和付费副作用为中心，不为每个 getter 重复堆覆盖率。

### 场景 A：点击发送时 Redis 队列不可用

预期：用户消息、AI placeholder、run 与 dispatch intent 一起提交；UI 显示 queued/streaming；Redis 恢复后 relay 自动入队并完成回复，不需要用户重发。

### 场景 B：Relay 在 enqueue 后、ack 前崩溃

预期：重复投递使用相同 `jobId=runId`，只有一个 generation 能被接受；房间费用只累计一次。若崩溃发生在 Provider 已接受请求、terminal payload 尚未落库之间，外部调用仍可能重试，这不是 RoomTalk 能普遍消除的边界。

### 场景 C：Worker 在 Provider 调用中崩溃

预期：BullMQ stalled/retry 恢复；新 claim 使用更高 generation；旧 Worker 的 chunk 和 terminal write 无效；最终消息与内部费用只收敛一次。Provider 调用采用至少一次语义。

### 场景 D：terminal payload 已保存，projection 前崩溃

预期：重试只执行 projection；Provider 调用次数仍为 1；message、run 和 cost 在同一事务收敛。

### 场景 E：用户在运行期间删除 placeholder 或截断历史

预期：run 变 cancelled 或 projection 返回 obsolete；队列重试成为 no-op；消息不会复活。

### 场景 F：App 与 Worker 分别重启

预期：重启 App 不取消后台任务；重启 Worker 不影响在线 Socket；两个进程恢复后未完成 run 自动继续。

### 场景 G：Transient 早到、丢失或来自旧 generation

预期：客户端有界暂存早到 chunk；忽略旧 generation；丢 chunk 仍被最终 durable event 覆盖。

### 场景 H：从 migration `0009` cutover

预期：已有 queued/running run 被安全放回 dispatch；finalizing run 只 project；terminal run 不入队；旧嵌入式 Worker 与新 BullMQ Worker 不同时运行。

### 场景 I：dispatch 已确认，但 Redis job 丢失或 failed attempts 耗尽

预期：PostgreSQL 仍 active 的 run 被 singleton reconciler 发现；missing job 使用同一 `runId` 补建，failed job 重置 infrastructure attempts 后回到 waiting。Terminal run、waiting/active/delayed job 不受影响。

### 场景 J：Worker 进程停止但 queue Redis 仍在线

预期：共享 heartbeat 在 TTL 后过期；App 仍可持久化请求并保持 HTTP ready，但 `/api/status` 变为 degraded，明确显示 Worker unavailable 与队列积压。

## 9. 发布与回滚

这次是运行协议切换，生产发布使用维护窗口：

1. 确认源码、CI 与真实 PostgreSQL 集成测试通过；
2. 停止旧 App，确保嵌入式 PostgreSQL worker 不再 claim；
3. 生成 PostgreSQL 与对象存储配对备份；
4. 执行新 migration，创建 dispatch outbox 并为 active runs 回填 pending dispatch；
5. 以 AOF/noeviction 配置重启 Redis，并验证现有 volume；
6. 启动 App 与独立 `ai-worker`；
7. 验证 migration、队列连接、outbox backlog、run invariants 和公开域名；
8. 不用生产账号发起付费请求；用 fake provider/受控 smoke 验证端到端执行。

回滚时必须同时考虑 schema 与进程协议。只回滚 App 镜像、却保留新 Worker 或让旧 Worker重新轮询同一批 run，会形成双执行者。安全回滚顺序是先停 App/Worker，再恢复成同一版本组合；必要时从维护窗口备份恢复。

## 10. 实施进度

### Commit 1：设计与执行契约

- [x] 确认 `b7941513` 已推送、部署且工作区干净；
- [x] 确认当前实现是 App 内 PostgreSQL polling worker；
- [x] 决定 BullMQ 只负责调度，`assistant_runs` 保持唯一业务事实；
- [x] 决定一个 Redis 起步、两套 URL/连接边界、未来可无代码拆分；
- [x] 写完迁移时序、故障语义和用户用例矩阵；
- [x] 提交本设计记录。

### Commit 2：BullMQ 运行路径

- [x] 添加 BullMQ 依赖与版本化 queue contract；
- [x] 添加 `task_dispatch_outbox` schema、原子创建和 relay；
- [x] 添加独立 AI Worker entrypoint；
- [x] 把 Provider executor 从 Socket server 生命周期中解耦；
- [x] 添加跨进程 transient Redis bridge；
- [x] 移除 App 内 PostgreSQL polling worker；
- [x] 更新 Compose、Docker、Redis AOF/noeviction、env 与健康检查；
- [x] 处理 migration `0010` active run cutover。

### Commit 3：关键场景验证与文档收口

- [x] 补齐 A-H 中具有真实故障价值的单元/集成/进程测试；
- [x] 运行真实 PostgreSQL migration 与 transaction 测试；
- [x] 更新 README、架构、配置、部署 runbook 与面试 HTML；
- [x] 检查旧 AI outbox/polling/usage ledger 措辞并合并重复内容；
- [x] 构建 Server/Client，运行受影响测试；
- [x] CI 为 `master` / PR 配置真实 PostgreSQL 与 Redis 服务；
- [x] 维护窗口部署并验证 `room.ruit.me` 与兼容域名。

### Post-cutover reliability closure

- [x] 增加 active PostgreSQL run 与 BullMQ job 的 advisory-locked reconciliation；
- [x] 覆盖 missing job、exhausted failed job 与 PostgreSQL 恢复到空队列；
- [x] 增加 Worker TTL heartbeat 与 waiting/active/delayed/failed/oldest-queued 状态；
- [x] 把 Provider 契约修正为至少一次，把 exactly-once 限定在终态 projection 与内部费用结算。

## 11. 完成标准

只有同时满足以下条件，本阶段才算完成：

- App 进程不再 claim 或执行普通聊天 AI run；
- 独立 BullMQ Worker 能从 `runId` 恢复完整执行；
- Redis 短暂不可用不会丢失已提交请求；
- duplicate/stalled/retry 只有一个 generation 能提交终态，内部费用只结算一次；
- Provider 在 terminal staging 前的外部调用使用至少一次语义，不伪称跨服务 exactly-once；
- acknowledged job 丢失或 attempts 耗尽时，active run 会由 reconciler 自动恢复；
- Worker 失联时公开状态在 TTL 内变为 degraded；
- terminal payload 后的恢复不会重跑 Provider；
- 删除 placeholder 后任何 job 都不能复活消息；
- Compose 与 AWS 迁移边界有明确配置；
- 关键用户用例、真实 PostgreSQL 集成、生产构建与部署验证都有证据；
- 文档描述的是当前代码与生产拓扑，不再混用旧 outbox、轮询 worker 或 usage ledger 设计。
