# RoomTalk 房间事件同步与可迁移部署架构

[English](room-event-sync-portable-deployment.md)

状态：`room.ruit.me` 基础设施与不可变事件生产切换均已完成

更新：2026-07-22

## 最终方案

RoomTalk 采用“PostgreSQL 物化状态 + 每房间有界增量日志”：

```text
rooms / room_messages / room_agent_turns  当前 canonical 状态
room_event_streams                       headSeq、retention 下界、删除授权
room_events                              有界、不可变的 after-image 重放日志
assistant_runs                           普通 Chat AI 业务生命周期与结果
task_dispatch_outbox                    事务型 BullMQ enqueue intent
Redis / BullMQ                           realtime/cache 与运行任务调度
对象存储                                  媒体与异地备份
```

它和读取 MySQL binlog 的相似点是“单调 cursor + 只读取缺失区间”；不同点是浏览器读取应用语义事件，而不是数据库复制日志。客户端不会绑定 PostgreSQL WAL/MySQL binlog 的内部格式。

这不是完整 Event Sourcing。规范化表仍是事实源；每个保留事件都是不可变的状态传输 after-image，旧前缀可按 retention 清理。

## 为什么它优于版本号比较

旧方案只能告诉客户端“消息窗口旧了”，修复动作仍然是重新比较/下载快照。事件日志能明确指出缺失的提交区间，客户端只补 `lastAppliedSeq` 之后的变化。

运行时现在只有一个持久排序边界：

- 快照：`snapshotSeq`；
- 增量请求：`afterSeq`；
- 客户端：`lastAppliedSeq`；
- 服务端窗口：`minAvailableSeq..headSeq`。

旧的房间/消息双版本列已从 PostgreSQL、TypeScript 和运行 payload 删除。房间设置的完整对象 ack/broadcast 仍用 `updatedAt` 防止旧对象回踩，但它不是第二个同步 cursor。PostgreSQL row trigger 用 `clock_timestamp()` 并保证至少比前值大 1 微秒，因此即使更早开始的事务最后写入，串行化后的 room 更新仍严格单调。`room.updated` 同时进入持久 cursor，用于修复漏掉的广播。

旧 history socket 直接返回 `UPGRADE_REQUIRED`，没有双读兼容层。

## PostgreSQL 实现机制

Row trigger 在领域事务内把 room、message、agent turn、membership 和 media 变化加入待处理集合。Deferred writer 在该事务的全部 statement 已经组装好 aggregate 后才运行，因此 media event 能同时看到先插入的 `room_messages` 与随后插入的 `media_assets`。Room before-delete trigger 还会在 cascade 前保存授权读者。

Deferred writer 构造有界、安全的 `schemaVersion: 1` after-image，再由 `append_room_event` 锁定单个 stream、分配下一个序号、插入不可变事件并调用 `pg_notify`。这一切与业务写处于同一事务，因此：

- rollback 时状态和事件一起消失；
- 同一房间并发 writer 在 stream/room 边界串行分配序号；
- 幂等重试没有第二次实际写入，也没有第二个事件；
- clear/truncate/edit-and-ask 可能生成多个有序批量事件，这是正常语义。

Message ID 会永久绑定创建时的 `room_id`。PostgreSQL trigger 会拒绝跨房间冲突 update，避免源房间保留 ghost message、而只有目标房间收到 upsert event。`room_events.created_at` 在 deferred writer materialize event 时使用 `clock_timestamp()`，retention 不会被长事务的开始时间扭曲。

`readRoomEvents()` 直接解码已保存 payload，绝不会用当前 canonical 行 hydrate 旧事件，所以后来编辑为 B 不会把早先记录的 A 改写掉。每种 V1 event type 都有严格 discriminated payload schema；字段缺失、类型错误或出现意外字段时返回 `EVENT_PAYLOAD_INVALID`，绝不会把坏数据变成空事件并确认。客户端不会跨过该事件推进 cursor，而是从 canonical snapshot 替换状态，再从 `snapshotSeq` 继续。Message after-image 包含稳定 media ID 与元数据，但不包含内部 object key、uploader/stream owner 或会过期的签名 URL；`room.updated` 保存 SafeRoom，绝不保存 `password_hash`。

实际事件类型为：

- `messages.upserted`、`messages.deleted`；
- `agent_turns.upserted`、`agent_turns.deleted`；
- `members.changed`，payload 永远为空；
- `room.updated`、`room.deleted`。

公共事件流绝不包含 member ID、离线成员列表、joined timestamp 或 owner/admin role。`members.changed` 只表示“成员关系发生变化”；完整成员投影继续通过现有 `room.manageMembers` 鉴权和 `get_room_role_members` 请求读取。

Typing、presence、`ai_chunk`、voice level 与 WebRTC signalling 继续保持临时。AI chunk、A2UI update 或 stream end 可能抢在 durable placeholder 通知前到达，因此浏览器按 `messageId` 临时缓存未匹配事件，placeholder 出现后按到达顺序排空。上限为 64 个 message ID、512 个事件、512 KiB 与 60 秒 TTL。Placeholder 已存在时，临时 reducer 分别更新规范投影与当前 React state，保留只存在于 UI 的 pending/failed optimistic message。

`ai_stream_error` 不允许自行创造规范正文，并显式携带 `persisted`。正常错误包含同一条已持久化 safe Message；若即时 projection 失败，`{ persisted: false }` 会立刻终止浏览器 placeholder，而 immutable terminal payload 仍 staged 在 `assistant_runs`，BullMQ retry 只投影同一 payload，不再次请求 Provider。PostgreSQL generation lease 会拒绝旧 Worker 写入。本地终态 overlay 会保留到 durable final after-image 覆盖它为止。未来 durable reaction mutation 应把 `reactions.upserted` / `reactions.deleted` 加入同一 room sequence；本次切换不凭空实现 reaction 数据模型。

## 快照与增量

`get_room_snapshot` 使用 repeatable-read 事务，同时返回完整 room、最近有界 message/turn 窗口、历史分页信息和 `snapshotSeq`。

`get_room_events` 接收 `afterSeq`、条数上限和字节上限，返回有序 events、`headSeq`、`minAvailableSeq` 与 `hasMore`。

- 收到 `NOTIFY` 后，每个 app 合并同房间水位并读取已提交的连续 range；完整通知不超过 `ROOM_EVENT_FAST_PATH_MAX_BYTES`（默认 256 KiB）时，Socket.IO 直接携带 `events`，否则只发最高 `headSeq`。
- 客户端只在 fast path 恰好是下一个连续前缀并以 `headSeq` 结束时直接应用；成功后推进 `lastAppliedSeq`，无需再调用 `get_room_events`。
- cursor 落后于 retention：`CURSOR_EXPIRED -> snapshot`。Deleted stream 是例外；只要 `afterSeq < headSeq`，服务端直接返回最终 `room.deleted`，因为 canonical snapshot 已不存在；
- 数据库恢复点落后于浏览器 cache：`CURSOR_AHEAD`。客户端同时清除旧目标水位与 gap-snapshot target，再请求 snapshot；请求期间到达的新通知会建立新目标，避免对恢复后的 head 无限请求同一空页；
- 严格 decoder 失败：返回 `EVENT_PAYLOAD_INVALID`，客户端不跨过坏事件推进 cursor，直接以 canonical snapshot 恢复；若第一条 event 本身就超过 `maxBytes`，返回 `EVENT_TOO_LARGE`，同样切到有界 snapshot，而不是突破请求声明的内存上限；
- page 不连续：整页不应用，重新快照；
- 先做一次有界 probe 识别可能的终态删除 tombstone；若保留窗口内仍落后超过 500 events，则不再按每页最多 100 个事件逐页追赶，而是直接 snapshot，再只排空 `snapshotSeq` 之后的 tail；
- IndexedDB v4 保存消息窗口和 `lastAppliedSeq`；
- `beforeMessageId` 只 prepend 旧历史，不移动实时 cursor。实时 replay/fast path 会让在途 prepend 失效；boundary 已删除时返回 `PAGINATION_BOUNDARY_EXPIRED`，由浏览器 replace window。

一个 per-room 状态机统一拥有 `idle`、`replay`、`replace` 和 `prepend`。Replay/replace recovery 的优先级高于可选分页，因此 prepend 不能让 recovery response 失效，迟到的 prepend 也不能把实时删除的状态插回来。如果删除清空了仍有旧历史的窗口，或者 truncate 后服务端发送 `message_history_invalidated`，控制器先清除无效 cache 再 replace window，不会持久化带旧 boundary 的空 projection。Durable `members.changed`、`room.deleted` 与 `ROOM_ACCESS_DENIED` 复用瞬时 Socket 通知的页面级权限刷新/房间移除路径。

Fast path 只改变延迟，不改变正确性边界。PostgreSQL 把 hint fan-out 到每个 app listener，每个 listener 再用 `io.local` 只通知本机 sockets；Redis adapter 不会放大这条 durable 通知。本机没有订阅者时，实例直接跳过 PostgreSQL payload 读取。完整 payload 发出前，Redis socket identity 与 PostgreSQL membership 都批量查询：明确 revoked 的成员离开；授权依赖 unavailable 时保留连接，并把本次投递降级为 head-only。客户端仍忽略已应用 seq，并从 PostgreSQL 补任何 gap。Range 读取不完整或超限时自动回到同一套 durable head-only 路径。

`NOTIFY` 本身不持久。失效 listener generation 会被关闭并忽略；替代 generation 成功 re-LISTEN 后才向本机发送 `room_sync_required {reason: "postgres_listener_reconnected"}`。客户端保留已渲染窗口，从 `lastAppliedSeq` replay；同时到达的 fast-path event 仍由同一 seq 幂等规则合并。

## 多实例 runtime ownership

滚动发布除了 room-event 投递，还需要明确 runtime ownership。RoomTalk 现在为每个进程生成唯一 runtime instance ID。Redis 保存实例 TTL heartbeat、该实例拥有的 socket ID，以及每个 socket 的 room/browser presence。启动时不再清空全局 presence；singleton reconciliation 只移除 heartbeat 已过期实例名下的记录，因此启动实例 B 不会抹掉仍由实例 A 服务的在线用户。

运行任务遵循同一规则。只有不存在未过期 fenced room lease 时，Code Agent turn 与 sandbox 才能恢复。普通 Chat AI 不再属于请求 App 实例：queued run 有 durable dispatch intent，active Worker 持有 generation lease，`finalizing` run 已保存 immutable terminal payload，因此 App 重启不能判死 job。旧 lease 消失后 BullMQ retry 或 replacement Worker 才能取得更高 generation，旧 transient/terminal write 都会被 fence 拒绝。

Recovery 与 retention loop 在每个副本中都存在，但执行前获取命名 PostgreSQL advisory lock；一轮只有一个实例做维护，其余实例跳过。Event broadcaster 也只为每个房间保存固定大小的 min/max pending state。生产路径未显式传入测试时间时，assistant-run 与 dispatch lease 都以 PostgreSQL `clock_timestamp()` 为时钟权威，避免多节点 wall-clock 偏差。

Lease schema 自己也有 cutover 边界。Pre-`0006` App 不会为 `ai_stream_owner_leases` heartbeat，因此不能与第一个理解 `0006` 的进程重叠：新进程可能恢复旧进程仍在生成的 placeholder。首次引入 `0006` 时必须停止所有旧 App。所有副本都使用 lease protocol 后，后续兼容 image 才可滚动；未来若再次改变 lease protocol，也需要维护窗口或两阶段 migration。

## 一次性不可变事件边界

Migration `0003_room_events_immutable_after_images` 持有表锁，保证替换 writer 与清理旧 ID-only events 之间不会夹入业务写。Schema 变更不再属于 App 冷启动：独立 Compose migrate service（Kubernetes 中对应 pre-deploy Job）在 transaction advisory lock 下只执行缺失的 immutable migration。`schema_migrations` 保存 SHA-256 checksum；已经记账的 SQL 被改写会直接失败。`POSTGRES_SCHEMA_SQL` 冻结为新库的 `0000` bootstrap，之后每次变更都必须新增 migration ID。App 启动只读校验 ID/checksum；漏跑 migrate job 时拒绝 readiness，而不是现场修改 schema。

Room-event migration 保留每条 stream 的 `head_seq`，清除不可确定历史，并把 active stream 的 `min_available_seq` 设为 `head_seq + 1`；旧 cursor 只需 snapshot 一次，不重置 sequence。

Migration `0004_public_member_change_events` 修复了曾运行 pre-production V1 member after-image writer 的数据库：保留的 `members.upserted` / `members.deleted` 已原地改为 `members.changed {}`，公共 type constraint 随后收紧，之后的成员变化也只写空 signal。生产环境已在 2026-07-21 维护窗口执行这次一次性隐私修复。

Migration `0005_message_room_immutability_and_event_clock` 强制 message-room invariant，并切换到 wall-clock event timestamp；V1 payload 格式不变。

Migration `0006_ai_stream_owner_leases` 增加 stream-owner 接管所需的 PostgreSQL heartbeat/expiry 表。它是 additive migration，不改变 V1 room-event 格式。

Deleted room 无法再取 snapshot。因此 migration 为这些 stream 追加新的 V1 `room.deleted` tombstone，保留 `deleted_reader_ids`，并把 retention floor 指向 tombstone。即使 cursor 早于已清理前缀，服务端仍返回这个终态事件，客户端只对 deletion 允许这一次 seq 跳跃，从而避免 `CURSOR_EXPIRED → 无法取得 snapshot` 死循环。系统不长期维护双格式 decoder。

## Retention，而不是定期合并

不需要把事件“合并”回 messages：当前状态已经在原事务里同步改变。每小时任务只删除连续旧前缀并推进 `minAvailableSeq`；命名 PostgreSQL advisory lock 保证多副本下只有一个实例执行。

默认保留 7 天且每房间最多 10,000 个事件。Operator 可通过 `ROOM_EVENT_RETENTION_DAYS`、`ROOM_EVENT_MAX_PER_ROOM` 与 `ROOM_EVENT_PRUNE_INTERVAL_MS` 覆盖；`ROOM_EVENT_FAST_PATH_MAX_BYTES` 独立控制 Socket fast-path 上限，Compose example 已暴露这四个变量。删除房间的全部事件过期后，对应独立 stream/授权 tombstone 也会删除。每小时维护日志会输出 broadcaster 的 pending/active rooms、合并通知数、batch 数、fast-path event bytes、head-only fallback、无本地订阅 skip、authorization-unavailable fallback 与最大 pending seq span。迁移 AWS 前应对持续 queue span、head-only/auth-unavailable 增长、expired-instance cleanup 与 lease-recovery 数量告警，并把 PostgreSQL 表/索引大小、dead tuples、每房间 event bytes 与 prune duration 加入平台 dashboard。

## 房间事件、AI Dispatch 与 BullMQ

三者消费者不同，不能合并：

| | `room_events` | `task_dispatch_outbox` | BullMQ |
| --- | --- | --- |
| 消费者 | 每个有权限客户端 | App dispatch relay | 一个 AI Worker |
| 投递 | cursor 可重复读取 | 带 fence 的 claim 与 enqueue ack | competing job claim、retry、stalled recovery |
| 目的 | 恢复可见状态 | 可靠桥接 PostgreSQL commit 与 Redis | 调度 Provider 执行 |
| 清理 | retention 连续前缀 | 确定性 enqueue 后 settled | completed/failed 运维保留 |

AI placeholder、`assistant_runs`、room event 与 dispatch row 在一个 PostgreSQL 事务里提交。Relay 随后用 `jobId=runId` 把最小 `{ schemaVersion: 1, runId }` job 送入 BullMQ；重复 relay 不会创建第二份任务。Queue 故障时 dispatch 回到 pending，因此已接受请求不会消失在 PostgreSQL 与 Redis 之间。独立 Worker 从 PostgreSQL 读取 request，claim 精确 run 并得到新 generation，在 Provider 执行期间持续续租 owner lease。

`assistant_runs` 是唯一业务 aggregate，拥有 request snapshot、generation、lease、immutable terminal payload、status、error 与 usage。系统不会从 BullMQ state 判断业务成功，也不使用 result backend。Retry 发现 terminal payload 已落库时只做 Message/run/cost projection，不再请求 Provider。锁定的唯一 terminal transition 已防止重复计费，因此刻意不建立第二张 `assistant_run_usage` ledger。

因此 Socket delivery 本身不需要 durable outbox：room data 已能通过 cursor 恢复，每个授权客户端都是 fan-out reader，不是 competing worker；重试 Socket 通知只是在重复事件日志已经解决的工作。`messageVersion` 同样没有必要，因为 room seq 已经同时表达顺序和精确缺失区间。

## 可迁移运行环境

当前 Mac 生产、保留的 Fly 回滚目标与未来 AWS 使用同一个根 `Dockerfile`，差异只来自环境变量：

| 当前 Mac 生产 | 保留的云端回滚目标 | AWS 目标 |
| --- | --- | --- |
| 同镜像的 app + ai-worker | Fly Machine | ECS Fargate services 或 EKS deployments |
| PostgreSQL 17 volume | Supabase/托管 PostgreSQL | RDS PostgreSQL |
| Redis 7，AOF realtime + BullMQ | 托管 Redis | ElastiCache for Redis OSS |
| SeaweedFS 4.29 S3-compatible store | Tigris/S3-compatible | S3 |

Kubernetes 是可选项，不是单台 MacBook 的前置条件。K8s 无法让一台物理机变成高可用；真正可迁移的是 App/Worker 共享镜像、PostgreSQL schema/dump/WAL、BullMQ Redis contract、可分离的 `REDIS_URL` / `QUEUE_REDIS_URL`，以及 S3 API。Realtime/cache key 可自然预热，但 active BullMQ job 必须排空或恢复。当前生产使用 SeaweedFS，回滚部署使用 Tigris，未来 AWS 使用 S3，object key 与 API 不变。

本地启动与备份：

```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose --profile ops run --rm postgres-backup
```

必须带 `--env-file`，Compose interpolation 才会使用配置的端口和 PostgreSQL 凭据。本地 S3 凭据由 `scripts/local-production.mjs` 从 macOS Keychain 注入，不写入仓库。SeaweedFS 与 S3 端口只对 Compose 私网和 loopback 开放；`MEDIA_STORAGE_ENDPOINT` 让服务端流量留在 Compose 网络，`MEDIA_STORAGE_PUBLIC_ENDPOINT` 为 edge hostname 生成浏览器上传/下载签名。

运行 `node scripts/backup-local-production.mjs` 可生成一致的维护备份：脚本会短暂停止 edge、app 与 object store，同时输出 PostgreSQL custom archive 和 SeaweedFS data snapshot，然后原样启动刚才停下的容器。恢复路径刻意使用 `compose start`，而不是 `compose up`，避免新 Compose 定义在旧镜像上被提前 reconcile，让备份意外变成部署。本地 `backups/` 仍不等于异地备份，生产必须有加密外部副本和实际 restore 演练。

长期运行的 Compose 服务使用有界 JSON 日志轮转（单文件 10 MB、保留 5 份）。数据库里的 observability、`assistant_runs`、dispatch intent 与 turn 仍是 PostgreSQL durable data；这个限制只作用于进程 stdout/stderr。Redis 使用 named volume、AOF `everysec` 与 `noeviction` 保护 active BullMQ job。

健康状态不是一个乐观 boolean。`/api/health/live` 只探测 App 进程；`/api/status` 与 `/api/health/ready` 检查真实表读取、realtime Redis、S3 与 Socket adapter。Serving dependency 失败时返回 HTTP 503 与 `rooms: null`；只有 queue 故障时 App 仍 ready，但报告 `degraded` 和 deferred dispatch。`ai-worker` 单独检查 PostgreSQL、queue Redis、transient Redis 与 worker state。AWS 还需监控磁盘和 queue backlog。

GitHub CI 使用 Node 24.18，同时启动 PostgreSQL 17 与 Redis 7，并设置 `ROOM_EVENT_TEST_DATABASE_URL` 和 `BULLMQ_TEST_REDIS_URL`。Trigger/transaction/fence 与真实 BullMQ dedupe/stalled-retry 测试都会执行，不会因为缺依赖静默 skip。

## 不可变事件生产 migration

生产在 2026-07-21 跨过 `0003` / `0004` 协议边界。发布先生成成对备份 `roomtalk-20260721T110310Z.dump` 与 `roomtalk-object-storage-20260721T110310Z.tar.gz`，再停止 `cloudflared` 和全部旧 app，只启动 commit `fbfd908b`。启动日志先记录两条 migration 成功，随后 PostgreSQL listener、Redis adapter、outbox worker 与公网 edge 才恢复 ready。

只读数据库检查确认 migration `0001` 到 `0004` 全部存在，没有非 V1 保留事件，旧流只留下经过授权的 `room.deleted` cutover tombstone。公网 WebSocket smoke 随后创建临时房间，收到已提交的 `messages.upserted` Socket payload，通过 snapshot 和 replay 读取同一消息，再删除房间并重放终态 tombstone，最后清理临时房间。

未来 AWS 多实例要么采用相同维护窗口边界，要么先设计明确的两阶段兼容协议，再做滚动发布。新不兼容 payload writer 生效后不能再运行旧镜像；跨边界回滚需要恢复匹配的数据库和对象存储备份，不能只重启旧 binary。

## 已执行的生产切换

2026-07-20 已完成基础设施与数据宿主的维护窗口切换：

1. 把 Supabase `public` dump 恢复到隔离 PostgreSQL 17 并应用当前 migrations；
2. 把 2,857 个 Tigris objects 全部复制校验到 SeaweedFS，并恢复同时间戳维护备份；
3. 禁用定时 Fly workflow、归档 Fly logs、把 Fly writer/worker 缩到零；
4. 获取最终 dump、重跑幂等 S3 copy、恢复本地生产库；
5. 核对表 count、删除退役 version columns、初始化 98 个 event streams；
6. 通过 Cloudflare Tunnel 路由 `room.ruit.me`、兼容域名 `roomtalk.ruit.me` 与 `roomtalk-objects.ruit.me`；
7. 验证 TLS、HTTP、Socket.IO/WebSocket、snapshot/delta event、公开 presigned PUT/GET 与删除 tombstone。

不可变 after-image 协议在上文所述的 2026-07-21 独立维护窗口部署。两个日期需要分开记录：前一次把 PostgreSQL 和对象迁到 Mac，后一次改变保留 room-event 的 payload 合约。

回滚窗口内继续保留 Fly、Supabase 与 Tigris。一旦本地开放写入，只改 DNS 回滚会丢本地新增数据；必须先把增量重新协调到云端目标。

实际实施证据见[进度账本](room-event-sync-portable-deployment-progress.zh.md)，恢复细节见[房间可靠性架构](room-reliability-architecture.zh.md)。
