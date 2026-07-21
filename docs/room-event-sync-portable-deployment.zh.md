# RoomTalk 房间事件同步与可迁移部署架构

[English](room-event-sync-portable-deployment.md)

状态：已完成 `room.ruit.me` 生产切换

更新：2026-07-21

## 最终方案

RoomTalk 采用“PostgreSQL 物化状态 + 每房间有界增量日志”：

```text
rooms / room_messages / room_agent_turns  当前 canonical 状态
room_event_streams                       headSeq、retention 下界、删除授权
room_events                              有界、不可变的 after-image 重放日志
outbox_events                            单 Worker claim/retry 后台任务
Redis                                    presence、Socket.IO adapter、短缓存
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

`readRoomEvents()` 直接解码已保存 payload，绝不会用当前 canonical 行 hydrate 旧事件，所以后来编辑为 B 不会把早先记录的 A 改写掉。每种 V1 event type 都有严格 discriminated payload schema；字段缺失、类型错误或出现意外字段时返回 `EVENT_PAYLOAD_INVALID`，绝不会把坏数据变成空事件并确认。客户端不会跨过该事件推进 cursor，而是从 canonical snapshot 替换状态，再从 `snapshotSeq` 继续。Message after-image 包含稳定 media ID 与元数据，但不包含内部 object key、uploader/stream owner 或会过期的签名 URL；`room.updated` 保存 SafeRoom，绝不保存 `password_hash`。

实际事件类型为：

- `messages.upserted`、`messages.deleted`；
- `agent_turns.upserted`、`agent_turns.deleted`；
- `members.changed`，payload 永远为空；
- `room.updated`、`room.deleted`。

公共事件流绝不包含 member ID、离线成员列表、joined timestamp 或 owner/admin role。`members.changed` 只表示“成员关系发生变化”；完整成员投影继续通过现有 `room.manageMembers` 鉴权和 `get_room_role_members` 请求读取。

Typing、presence、`ai_chunk`、voice level 与 WebRTC signalling 继续保持 transient。AI chunk、A2UI update 或 stream end 可能抢在 durable placeholder 通知前到达，因此浏览器按 `messageId` 临时缓存未匹配事件，placeholder 出现后按到达顺序 drain。上限为 64 个 message ID、512 个事件、512 KiB 与 60 秒 TTL。未来 durable reaction mutation 应把 `reactions.upserted` / `reactions.deleted` 加入同一 room sequence；本次切换不凭空实现 reaction 数据模型。

## 快照与增量

`get_room_snapshot` 使用 repeatable-read 事务，同时返回完整 room、最近有界 message/turn 窗口、历史分页信息和 `snapshotSeq`。

`get_room_events` 接收 `afterSeq`、条数上限和字节上限，返回有序 events、`headSeq`、`minAvailableSeq` 与 `hasMore`。

- 收到 `NOTIFY` 后，每个 app 从 PostgreSQL 读取精确、不可变的已提交 sequence；完整通知不超过 `ROOM_EVENT_FAST_PATH_MAX_BYTES`（默认 256 KiB）时，Socket.IO 直接携带 `events`，否则只发 `headSeq`。
- 客户端只在 fast path 恰好是下一个连续前缀并以 `headSeq` 结束时直接应用；成功后推进 `lastAppliedSeq`，无需再调用 `get_room_events`。
- cursor 落后于 retention：`CURSOR_EXPIRED -> snapshot`；
- 数据库恢复点落后于浏览器 cache：`CURSOR_AHEAD -> snapshot`；
- 严格 decoder 失败：返回 `EVENT_PAYLOAD_INVALID`，客户端不跨过坏事件推进 cursor，直接以 canonical snapshot 恢复；
- page 不连续：整页不应用，重新快照；
- 先做一次有界 probe 识别可能的终态删除 tombstone；若保留窗口内仍落后超过 500 events，则不应用/重放最多 100 个默认 page，而是直接 snapshot，再只排空 `snapshotSeq` 之后的 tail；
- IndexedDB v4 保存消息窗口和 `lastAppliedSeq`；
- `beforeMessageId` 只 prepend 旧历史，不移动实时 cursor。

Fast path 只改变延迟，不改变正确性边界。PostgreSQL 把 hint fan-out 到每个 app listener，每个 listener 再用 `io.local` 只通知本机 sockets；Redis adapter 不会放大这条 durable 通知。客户端仍忽略已应用 seq，并从 PostgreSQL 补任何 gap。精确事件读取失败或超限时自动回到同一套 durable head-only 路径。

`NOTIFY` 本身不持久，所以 listener 成功 re-LISTEN 后会向本机发送 `room_sync_required {reason: "postgres_listener_reconnected"}`。客户端保留已渲染窗口，从 `lastAppliedSeq` replay；同时到达的 fast-path event 仍由同一 seq 幂等规则合并。

## 一次性不可变事件边界

Migration `0003_room_events_immutable_after_images` 持有表锁，保证替换 writer 与清理旧 ID-only events 之间不会夹入业务写。多个 app 同时启动由 transaction-scoped advisory lock 和 migration record 二次检查串行化。Migration 保留每条 stream 的 `head_seq`，清除不可确定历史，并把 active stream 的 `min_available_seq` 设为 `head_seq + 1`；旧 cursor 只需 snapshot 一次，不重置 sequence。

Migration `0004_public_member_change_events` 修复已经运行过 pre-production V1 member after-image writer 的数据库：所有保留的 `members.upserted` / `members.deleted` 原地改为 `members.changed {}`，随后收紧公共 type constraint；之后的成员变化也只写空 signal。这是在事件流向客户端开放前执行的一次性隐私修复。

Deleted room 无法再取 snapshot。因此 migration 为这些 stream 追加新的 V1 `room.deleted` tombstone，保留 `deleted_reader_ids`，并把 retention floor 指向 tombstone。即使 cursor 早于已清理前缀，服务端仍返回这个终态事件，客户端只对 deletion 允许这一次 seq 跳跃，从而避免 `CURSOR_EXPIRED → 无法取得 snapshot` 死循环。系统不长期维护双格式 decoder。

## Retention，而不是定期合并

不需要把事件“合并”回 messages：当前状态已经在原事务里同步改变。每小时任务只删除连续旧前缀并推进 `minAvailableSeq`。

默认保留 7 天且每房间最多 10,000 个事件。Operator 可通过 `ROOM_EVENT_RETENTION_DAYS`、`ROOM_EVENT_MAX_PER_ROOM` 与 `ROOM_EVENT_PRUNE_INTERVAL_MS` 覆盖；`ROOM_EVENT_FAST_PATH_MAX_BYTES` 独立控制 Socket fast-path 上限，Compose example 已暴露这四个变量。删除房间的全部事件过期后，对应独立 stream/授权 tombstone 也会删除。

## 房间事件与 AI Outbox

两者消费者不同，不能合并：

| | `room_events` | `outbox_events` |
| --- | --- | --- |
| 消费者 | 每个有权限客户端 | 一个抢占任务的 Worker |
| 投递 | cursor 可重复读取 | claim、lease、retry |
| 目的 | 恢复可见状态 | 可靠执行一次副作用 |
| 清理 | retention 连续前缀 | processed/failed 策略 |

例如“发送并询问 AI”可以在一个事务里提交用户消息、room event、assistant run 与 AI job outbox；Worker 完成后再提交最终 AI 消息并生成下一条 room event。

因此 Socket delivery 本身不需要 durable outbox：room data 已能通过 cursor 恢复，每个授权客户端都是 fan-out reader，不是 competing worker；重试 Socket 通知只是在重复事件日志已经解决的工作。`messageVersion` 同样没有必要，因为 room seq 已经同时表达顺序和精确缺失区间。

## 可迁移运行环境

当前 Mac 生产、保留的 Fly 回滚目标与未来 AWS 使用同一个根 `Dockerfile`，差异只来自环境变量：

| 当前 Mac 生产 | 保留的云端回滚目标 | AWS 目标 |
| --- | --- | --- |
| app container | Fly Machine | ECS Fargate 或 EKS |
| PostgreSQL 17 volume | Supabase/托管 PostgreSQL | RDS PostgreSQL |
| Redis 7，可重建 | 托管 Redis | ElastiCache |
| SeaweedFS 4.29 S3-compatible store | Tigris/S3-compatible | S3 |

Kubernetes 是可选项，不是单台 MacBook 的前置条件。K8s 无法让一台物理机变成高可用；真正可迁移的是镜像、PostgreSQL schema/dump/WAL 合约、Redis 可丢弃定位和 S3 边界。当前生产使用 SeaweedFS，回滚部署使用 Tigris，未来 AWS 使用 S3，应用 object key 与 API 不变。

本地启动与备份：

```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose --profile ops run --rm postgres-backup
```

必须带 `--env-file`，Compose interpolation 才会使用配置的端口和 PostgreSQL 凭据。本地 S3 凭据由 `scripts/local-production.mjs` 从 macOS Keychain 注入，不写入仓库。SeaweedFS 与 S3 端口只对 Compose 私网和 loopback 开放；`MEDIA_STORAGE_ENDPOINT` 让服务端流量留在 Compose 网络，`MEDIA_STORAGE_PUBLIC_ENDPOINT` 为 edge hostname 生成浏览器上传/下载签名。

运行 `node scripts/backup-local-production.mjs` 可生成一致的维护备份：脚本会短暂停止 edge、app 与 object store，同时输出 PostgreSQL custom archive 和 SeaweedFS data snapshot，然后恢复服务。本地 `backups/` 仍不等于异地备份，生产必须有加密外部副本和实际 restore 演练。

长期运行的 Compose 服务使用有界 JSON 日志轮转（单文件 10 MB、保留 5 份）。数据库里的 observability、outbox 与 turn 记录仍是 PostgreSQL durable data；这个限制只作用于进程 stdout/stderr。

## 尚未执行的不可变事件生产 migration

`0003` / `0004` 是直接协议边界，不能让旧、新 App 混合滚动运行。当前单实例 Compose 的正确步骤是：先生成并验证备份，停止全部旧 App process，只启动新 image 并等待 migration 完成，再 smoke snapshot、delta、AI streaming、member authorization 与 deletion replay。仅推送源码不会执行这个 migration。

未来 AWS 多实例要么采用同样的维护窗口 stop-the-world，要么先设计真正的两阶段兼容协议再滚动发布。新 payload writer 生效后绝不能再运行旧 image；回滚必须恢复匹配的数据库备份，不能只把旧 binary 启回来。

## 已执行的生产切换

2026-07-20 已在一个维护窗口完成直接切换：

1. 把 Supabase `public` dump 恢复到隔离 PostgreSQL 17 并应用当前 migrations；
2. 把 2,857 个 Tigris objects 全部复制校验到 SeaweedFS，并恢复同时间戳维护备份；
3. 禁用定时 Fly workflow、归档 Fly logs、把 Fly writer/worker 缩到零；
4. 获取最终 dump、重跑幂等 S3 copy、恢复本地生产库；
5. 核对表 count、删除退役 version columns、初始化 98 个 event streams；
6. 通过 Cloudflare Tunnel 路由 `room.ruit.me`、兼容域名 `roomtalk.ruit.me` 与 `roomtalk-objects.ruit.me`；
7. 验证 TLS、HTTP、Socket.IO/WebSocket、snapshot/delta event、公开 presigned PUT/GET 与删除 tombstone。

回滚窗口内继续保留 Fly、Supabase 与 Tigris。一旦本地开放写入，只改 DNS 回滚会丢本地新增数据；必须先把增量重新协调到云端目标。

实际实施证据见[进度账本](room-event-sync-portable-deployment-progress.zh.md)，恢复细节见[房间可靠性架构](room-reliability-architecture.zh.md)。
