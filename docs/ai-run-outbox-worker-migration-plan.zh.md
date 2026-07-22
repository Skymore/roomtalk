# AI Run / Outbox / Worker 迁移方案

> 历史方案，已于 2026-07-22 被替代。当前实现以 `assistant_runs` 作为唯一业务 aggregate，`task_dispatch_outbox` 只桥接 PostgreSQL commit 与 BullMQ，并使用独立 Node/TypeScript `ai-worker`。现行设计见 [Assistant Runs 与 BullMQ](assistant-run-bullmq-design-progress.zh.md)。下文各阶段作为设计演进证据保留，不再是当前操作说明。

[English](ai-run-outbox-worker-migration-plan.md)

状态：已有基础能力的历史迁移方案
复核：2026-07-12

> 2026-07-20 补充（历史）：RoomTalk 后续增加了独立的有界 `room_events` replay log，见[房间事件同步与可迁移部署](room-event-sync-portable-deployment.zh.md)。当时 `outbox_events` 是单 Worker claim/retry 机制；普通 Chat AI 后续已改为 `task_dispatch_outbox` + BullMQ。

## 目标

把 RoomTalk 的 AI generation 从“由接收 socket 的 handler 持有整个进程”演进为 durable、observable、retryable 的 run model，同时不改变用户看到的实时流式体验。

最终切换应发生在所有阶段都已上线并经过 shadow verification 之后，而不是一次性重写 socket、streaming、persistence 和 worker。

## 原始状态

- 用户消息与 AI message 持久化在 room history；
- streaming 前先写 AI placeholder；
- text chunks 只通过 Socket.IO 推送，不逐 chunk 持久化；
- stream 完成后保存 final content；
- server startup 会把遗留 `streaming` message 标记失败。

这对用户体验是合理基础，但 socket handler 仍是请求 owner，因此 retry、cancel、run audit、跨进程恢复与独立 worker 缺少 durable task identity。

## 目标形态

```text
socket handler
  -> access/posting validation
  -> user message + AI placeholder
  -> assistant_run
  -> outbox_event

worker
  -> claim outbox event
  -> lease assistant_run
  -> provider stream
  -> realtime chunks
  -> durable final/error state
```

Socket connection 不再决定任务是否存在。Run ID 关联 user message、assistant placeholder、model/role/context snapshot、requester、attempt、lease、usage、terminal state 和 error。

## Phase 1：Assistant Run State

先引入 durable `assistant_run`，但仍由现有 handler 执行。Run state 至少包含 `queued | running | completed | failed | cancelled`，并记录 attempt、created/started/finished time、owner worker、lease expiry 和 idempotency key。

Message 是用户可见内容，run 是执行事实；两者不能混成一个状态字段。终态更新应以事务保证 run 与 AI message 不互相矛盾。

## Phase 2：Durable Outbox

在接受请求的同一事务中写 placeholder、run 与 outbox event。只有事务提交成功才广播已接受状态。Worker claim 使用原子更新/数据库锁，重复 delivery 通过 idempotency key 和 terminal-state check 变成 no-op。

Outbox 保留 attempt、next-attempt time、last error 和 dead-letter 信息。Retry 只重试可安全重放的执行边界，不能重复写 user message 或创建多个可见 assistant message。

## Phase 3：Feature Flag 后的 Worker

新增 worker 消费同一 run contract。开始可 shadow-read/claim-disabled，之后只对白名单 room 执行。Worker 持续续租；lease 过期后其他 worker 才能接管。Socket room 只是实时投递目标，final persistence 不依赖发起连接仍然在线。

取消请求设置 durable intent；执行者观察后中断 provider 并写 cancelled terminal state。Server restart 扫描 expired running leases，而不是笼统地把所有 streaming message 失败化。

## 最终切换

1. 所有新请求都创建 run + outbox；
2. 对比 handler execution 与 worker shadow metrics；
3. 小比例 room 切到 worker；
4. 验证完成率、duplicate rate、queue latency、lease recovery 与 usage accounting；
5. 全量打开 worker；
6. 删除 handler-owned execution，只保留 request acceptance 与 realtime subscription。

回滚只切回执行 owner，不删除 durable run/outbox 数据。

## 不改变的边界

- 房间 access/posting policy；
- AI role/model/context 选择语义；
- provider client 与 chunk UX；
- message history API；
- Socket.IO 作为低延迟通知层；
- provider usage/cost 最终记账要求。

## 后续工作

更长期可以加入优先级、公平调度、per-room concurrency、dead-letter operations、跨区域 worker 和 chunk checkpoint。它们不应阻塞先建立 durable run identity、outbox 与 lease。

本文是迁移设计，不代表当前生产已经完成独立 worker cutover。当前 streaming recovery 以源码和 [运行时架构](code-agent-runtime-architecture.zh.md) 中相关边界为准。
