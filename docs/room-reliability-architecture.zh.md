# RoomTalk 房间可靠性架构

[English](room-reliability-architecture.md)

状态：已实现的运行时架构

更新：2026-07-20

## 一个持久同步边界

RoomTalk 现在每个房间只使用一个由 PostgreSQL 分配的事件序列。旧的房间/消息双版本字段不再属于运行模型。

| 值 | 含义 | 生命周期 |
| --- | --- | --- |
| `snapshotSeq` | repeatable-read 房间快照同时捕获的事件 head | 单次快照响应 |
| `afterSeq` | 客户端请求的最后一个持久事件 | 单次增量请求 |
| `lastAppliedSeq` | 本地窗口已经连续应用到的事件 | 内存与 IndexedDB v4 |
| `headSeq` | 当前已提交的 stream head | PostgreSQL |
| `minAvailableSeq` | retention 后仍保留的第一个事件 | PostgreSQL |
| `sessionEpoch`、`messageSyncRequestId` | 浏览器控制标记，不是数据版本 | 当前 tab/session |

房间设置的 ack 与 broadcast 仍传完整 canonical `Room`，用 `updatedAt` 做 last-write-wins。这个时间戳不是另一套同步版本：PostgreSQL row trigger 保证同一 room 的串行写入严格单调，包括更早开启但更晚写入的事务。快照中的 room 和 `room.updated` 事件进入同一提交入口，所以漏掉广播也能恢复。

## 事实源分层

```text
rooms / room_messages / room_agent_turns
  当前规范化状态
          │ PostgreSQL trigger 在同一事务捕获
          ▼
room_event_streams + room_events
  有界可重放窗口
          │ commit 后 NOTIFY；app 读取并 hydrate 指定 seq
          ▼
Socket.IO + Redis adapter
  有界 canonical event fast path 或 head-only hint
          │
          ▼
客户端 reducer + IndexedDB v4 cursor/window
```

Redis 只负责 presence、Socket.IO adapter 和短 TTL 最近消息缓存，不再承载不可恢复业务数据。服务端启动时必须连接 PostgreSQL。

## 快照与增量恢复

冷启动或重置时，`get_room_snapshot` 在一个 repeatable-read 事务中读取房间、最近有界消息、相关 agent turn 与事件 head，返回 `snapshotSeq`。

如果内存/IndexedDB 已有窗口，客户端先即时显示。`room_event_available` 通常携带已经提交并 hydrate 的 event；当 event list 以 `headSeq` 结束且正好从 `lastAppliedSeq + 1` 连续开始时，reducer 直接应用并推进 cursor，不再额外请求。Payload 缺失、超限、重复或不连续仍然安全，因为 `headSeq` 会触发 `get_room_events(afterSeq=lastAppliedSeq)`。

小 gap 默认按每页 100 events / 256 KiB 追赶。保留窗口内落后超过 500 个事件时，客户端不再逐页重放中间状态，而是加载新的 repeatable-read snapshot，再只排空 `snapshotSeq` 之后的 tail。更旧历史继续独立使用 `beforeMessageId` 懒加载。

Reducer 只接受连续前缀：

- `seq <= lastAppliedSeq`：重复，忽略；
- `seq === lastAppliedSeq + 1`：应用并推进；
- 发现缺口：不应用该页，重新加载有界快照；
- 保留窗口内落后超过 500 个事件：跳过逐页 replay，重新加载有界快照；
- `CURSOR_EXPIRED`：旧前缀已清理，重新快照；
- `CURSOR_AHEAD`：数据库恢复点落后于浏览器 cache，重新快照。

更早历史仍用 `beforeMessageId` 分页；prepend 旧页不能推进实时事件 cursor。

## 事件语义

这里是状态传输 changelog，不是审计日志，也不是完整 Event Sourcing。数据库事件 payload 只保存有界实体 ID；读取时从当前 canonical 行 hydrate upsert 内容。

| 事件 | 客户端动作 |
| --- | --- |
| `messages.upserted` | 按 ID upsert hydrate 后的消息并恢复 canonical 顺序 |
| `messages.deleted` | 删除 ID，并清理对应媒体 cache |
| `agent_turns.upserted` | upsert 持久 agent turn 元数据 |
| `agent_turns.deleted` | 删除 turn ID |
| `room.updated` | 把完整 room 交给正常 room commit guard |
| `room.deleted` | 清理本地房间/消息 cache |

clear、truncate、retry、edit-and-ask 会表现为一个或多个有序批量 upsert/delete 事件。因此“一次业务操作恰好一个事件”不是约束；真正约束是：每个已提交的可见行变化与事件同事务，事务回滚时两者都不存在。

AI chunk 和增量 UI 更新仍是临时 Socket fast path；持久 placeholder 与最终/错误消息提交后进入 room-event fast path，并可在漏投递后重放。

## 删除权限与 retention

删除房间前，PostgreSQL 在独立 stream 行记录当时有权访问的用户 ID，并写入 `room.deleted` tombstone。房间和成员行 cascade 删除后，原有成员仍能读取删除事件，无关用户不能读取。

后台任务默认每小时执行，保留 7 天且每房间最多 10,000 个事件。它只删除连续旧前缀并推进 `minAvailableSeq`；删除房间的事件全部过期后再移除 stream。事件无需“合并”回 messages，因为当前状态已在原写事务中同步更新。

## 多实例通知

每个 app 实例都 `LISTEN room_event_committed`，从 PostgreSQL 读取并 hydrate 指定的已提交 sequence，再通过 Socket.IO 广播 `room_event_available {roomId, headSeq, events?}`。完整通知只有在序列化后不超过 `ROOM_EVENT_FAST_PATH_MAX_BYTES`（默认 256 KiB）时才携带 event；读取失败或超限会退化为 head-only hint。同房间 hydration 在单个实例内串行，保持 emit 顺序。多实例加 Redis adapter 可能产生重复，但 `seq <= lastAppliedSeq` 会幂等忽略，任何 gap 都回到持久 replay。

## 验证证据

当前实现由以下层次保护：

- store、socket unit/contract tests；
- 已提交 payload hydration、字节超限 fallback、同房间顺序、fast path 零补拉、大 gap snapshot、cache 恢复、过期、数据库回退、删除、turn、room metadata 与 AI 临时事件 broadcaster/reducer tests；
- 真实 PostgreSQL schema、快照、幂等、回滚、并发、room metadata 单调性、retention、删除授权测试；
- PostgreSQL Playwright：刷新/新 context、媒体/AI/分享、双客户端、离线追赶；
- Compose health、重启持久化与 backup/restore。

部署与迁移细节见 [房间事件同步与可迁移部署架构](room-event-sync-portable-deployment.zh.md)。
