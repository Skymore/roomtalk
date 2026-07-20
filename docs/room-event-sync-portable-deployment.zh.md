# RoomTalk 房间事件同步与可迁移部署架构

[English](room-event-sync-portable-deployment.md)

状态：本地实现完成；尚未执行生产数据/DNS 切换

更新：2026-07-20

## 最终方案

RoomTalk 采用“PostgreSQL 物化状态 + 每房间有界增量日志”：

```text
rooms / room_messages / room_agent_turns  当前 canonical 状态
room_event_streams                       headSeq、retention 下界、删除授权
room_events                              有界可重放增量日志
outbox_events                            单 Worker claim/retry 后台任务
Redis                                    presence、Socket.IO adapter、短缓存
对象存储                                  媒体与异地备份
```

它和读取 MySQL binlog 的相似点是“单调 cursor + 只读取缺失区间”；不同点是浏览器读取应用语义事件，而不是数据库复制日志。客户端不会绑定 PostgreSQL WAL/MySQL binlog 的内部格式。

这不是完整 Event Sourcing。规范化表仍是事实源，事件窗口可以按 retention 清理。

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

消息和 agent turn 的 insert/update/delete 由 PostgreSQL statement transition-table trigger 捕获。房间 insert/update 生成 room event；删除前的 row trigger 会先保存当时有权限的用户列表并写 `room.deleted` tombstone，再执行 cascade。

`append_room_event` 通过更新单个 stream 行分配下一个序号、插入事件并调用 `pg_notify`。Trigger 与业务写处于同一事务，因此：

- rollback 时状态和事件一起消失；
- 同一房间并发 writer 在 stream/room 边界串行分配序号；
- 幂等重试没有第二次实际写入，也没有第二个事件；
- clear/truncate/edit-and-ask 可能生成多个有序批量事件，这是正常语义。

数据库事件只存有界实体 ID；增量读取时从当前 canonical 行 hydrate upsert 内容。因此它是状态传输 changelog，不是历史审计轨迹。

实际事件类型为：

- `messages.upserted`、`messages.deleted`；
- `agent_turns.upserted`、`agent_turns.deleted`；
- `room.updated`、`room.deleted`。

## 快照与增量

`get_room_snapshot` 使用 repeatable-read 事务，同时返回完整 room、最近有界 message/turn 窗口、历史分页信息和 `snapshotSeq`。

`get_room_events` 接收 `afterSeq`、条数上限和字节上限，返回有序 events、`headSeq`、`minAvailableSeq` 与 `hasMore`。

- cursor 落后于 retention：`CURSOR_EXPIRED -> snapshot`；
- 数据库恢复点落后于浏览器 cache：`CURSOR_AHEAD -> snapshot`；
- page 不连续：整页不应用，重新快照；
- IndexedDB v4 保存消息窗口和 `lastAppliedSeq`；
- `beforeMessageId` 只 prepend 旧历史，不移动实时 cursor。

PostgreSQL `NOTIFY` 和 Socket.IO 只负责唤醒。多个 app 实例经 Redis adapter 可能产生重复提醒；客户端把它当幂等 hint，最终始终读取持久事件。

## Retention，而不是定期合并

不需要把事件“合并”回 messages：当前状态已经在原事务里同步改变。每小时任务只删除连续旧前缀并推进 `minAvailableSeq`。

默认保留 7 天且每房间最多 10,000 个事件。删除房间的全部事件过期后，对应独立 stream/授权 tombstone 也会删除。

## 房间事件与 AI Outbox

两者消费者不同，不能合并：

| | `room_events` | `outbox_events` |
| --- | --- | --- |
| 消费者 | 每个有权限客户端 | 一个抢占任务的 Worker |
| 投递 | cursor 可重复读取 | claim、lease、retry |
| 目的 | 恢复可见状态 | 可靠执行一次副作用 |
| 清理 | retention 连续前缀 | processed/failed 策略 |

例如“发送并询问 AI”可以在一个事务里提交用户消息、room event、assistant run 与 AI job outbox；Worker 完成后再提交最终 AI 消息并生成下一条 room event。

## 可迁移运行环境

本地、Fly、未来 AWS 使用同一个根 `Dockerfile`，差异只来自环境变量：

| 本地 Compose | 当前云端 | AWS 目标 |
| --- | --- | --- |
| app container | Fly Machine | ECS Fargate 或 EKS |
| PostgreSQL 17 volume | Supabase/托管 PostgreSQL | RDS PostgreSQL |
| Redis 7，可重建 | 托管 Redis | ElastiCache |
| local/S3-compatible media | Tigris/S3-compatible | S3 |

Kubernetes 是可选项，不是单台 MacBook 的前置条件。K8s 无法让一台物理机变成高可用；真正可迁移的是镜像、PostgreSQL schema/dump/WAL 合约、Redis 可丢弃定位和 S3-compatible 对象。

本地启动与备份：

```bash
cp .env.compose.example .env.compose
docker compose up -d --build
docker compose --profile ops run --rm postgres-backup
```

PostgreSQL/Redis 的维护端口只绑定 loopback。Named volume 不是备份；生产必须有加密异地副本和实际 restore 演练。

## 一次性生产切换边界

可以在一个维护窗口直接切，但“直接”仍必须包含演练：

1. 把当前生产 dump 恢复到隔离本地库；
2. 跑 schema migration、真实 PostgreSQL integration 与 Playwright；
3. 停止云端写入和 worker；
4. 生成并验证最终 custom-format dump；
5. 本地恢复、迁移、比较 counts/invariants，并通过临时入口 smoke；
6. 切 Cloudflare/DNS，再开放写入；
7. 回滚窗口结束前保留云端库只读。

一旦本地开放写入，只改 DNS 回滚会丢本地新增数据；必须先把增量重新协调到云端目标。

实际实施证据见[进度账本](room-event-sync-portable-deployment-progress.zh.md)，恢复细节见[房间可靠性架构](room-reliability-architecture.zh.md)。
