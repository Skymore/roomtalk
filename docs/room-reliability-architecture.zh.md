# RoomTalk 房间可靠性架构

[English](room-reliability-architecture.md)

状态：已实现的运行时架构

更新：2026-07-21

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
rooms / room_messages / room_agent_turns / room_members / media_assets
  当前规范化状态
          │ 同一 PostgreSQL 事务；deferred writer 构造安全 after-image
          ▼
room_event_streams + room_events
  有界、不可变的 schemaVersion=1 可重放窗口
          │ commit 后 NOTIFY hint；每个 app 读取指定 seq
          ▼
每个 app 的本地 Socket.IO adapter
  io.local event fast path 或 head-only hint
          │
          ▼
客户端 reducer + IndexedDB v4 cursor/window
```

Redis 只负责 presence、Socket.IO adapter 和短 TTL 最近消息缓存，不再承载不可恢复业务数据。服务端启动时必须连接 PostgreSQL。

## 快照与增量恢复

冷启动或重置时，`get_room_snapshot` 在一个 repeatable-read 事务中读取房间、最近有界消息、相关 agent turn 与事件 head，返回 `snapshotSeq`。

如果内存/IndexedDB 已有窗口，客户端先即时显示。`room_event_available` 通常携带精确的已提交不可变 event；当 event list 以 `headSeq` 结束且正好从 `lastAppliedSeq + 1` 连续开始时，reducer 直接应用并推进 cursor，不再额外请求。Payload 缺失、超限、重复或不连续仍然安全，因为 `headSeq` 会触发 `get_room_events(afterSeq=lastAppliedSeq)`。

小 gap 默认按每页 100 events / 256 KiB 追赶。客户端先做一次有界 delta probe（用于识别 deleted-room 终态 tombstone）；若保留窗口内仍落后超过 500 events，则不应用这页中间状态，直接加载新的 repeatable-read snapshot，再只排空 `snapshotSeq` 之后的 tail。更旧历史继续独立使用 `beforeMessageId` 懒加载。

Reducer 只接受连续前缀：

- `seq <= lastAppliedSeq`：重复，忽略；
- `seq === lastAppliedSeq + 1`：应用并推进；
- 发现缺口：不应用该页，重新加载有界快照；
- 保留的终态 `room.deleted` tombstone 可以跨过已清理前缀，因为删除覆盖中间状态，而且该房间已无法 snapshot；
- 保留窗口内落后超过 500 个事件：跳过逐页 replay，重新加载有界快照；
- `CURSOR_EXPIRED`：旧前缀已清理，重新快照；
- `CURSOR_AHEAD`：数据库恢复点落后于浏览器 cache，重新快照。

更早历史仍用 `beforeMessageId` 分页；prepend 旧页不能推进实时事件 cursor。

## 事件语义

这里是有界、不可变的 after-image changelog，不是审计日志，也不是完整 Event Sourcing。Canonical 表仍是事实源，但每个保留事件自身可以确定性重放：`readRoomEvents()` 严格解码已保存的 `schemaVersion: 1` discriminated payload，绝不会再用当前 `room_messages`、`room_agent_turns` 或 `rooms` 行替换旧事件内容。字段缺失、类型错误或意外字段会触发 `EVENT_PAYLOAD_INVALID`；客户端不跨过该 cursor，而是从 canonical snapshot 替换状态。Message after-image 保存稳定 media asset ID 与必要元数据，但排除内部 object key、uploader ID、stream owner、password hash 和会过期的签名 URL。

| 事件 | 客户端动作 |
| --- | --- |
| `messages.upserted` | 按 ID upsert 已保存的 Message after-image 并恢复 canonical 顺序 |
| `messages.deleted` | 删除 ID，并清理对应媒体 cache |
| `agent_turns.upserted` | upsert 已保存的 RoomAgentTurn after-image |
| `agent_turns.deleted` | 删除 turn ID |
| `members.changed` | 不暴露任何成员数据；有权限的管理界面通过 `room.manageMembers` 鉴权重新读取 |
| `room.updated` | 把已保存的完整 SafeRoom after-image 交给正常 room commit guard |
| `room.deleted` | 清理本地房间/消息 cache |

clear、truncate、retry、edit-and-ask 会表现为一个或多个有序批量 upsert/delete 事件。因此“一次业务操作恰好一个事件”不是约束；真正约束是：每个已提交的可见行变化与事件同事务，事务回滚时两者都不存在。

AI chunk 和增量 UI 更新仍是临时 Socket fast path。它们可能抢在 placeholder 的独立 PostgreSQL 通知前到达，因此浏览器按 `messageId` 缓存未匹配的 `ai_chunk`、`a2ui_update` 与 `ai_stream_end`，placeholder 出现后按到达顺序 drain。缓存上限是 64 个 message ID、512 个事件、512 KiB 和 60 秒 TTL。Placeholder 已存在后，每个 transient handler 分别更新 canonical projection，并对当前 React state 应用相同 reducer，而不是整体替换，因此并发加入的 pending/failed optimistic send 不会消失。持久 placeholder 与最终/错误消息提交后进入 room-event fast path，并可在漏投递后重放。

Typing、presence、voice level 和 WebRTC signalling 同样属于 transient，不消耗 durable room sequence。未来如果 reaction 成为持久产品模型，它的 `reactions.upserted` / `reactions.deleted` after-image 应进入这条 sequence，而不是引入第二套 version counter。

## 删除权限与 retention

删除房间前，PostgreSQL 在独立 stream 行记录当时有权访问的用户 ID，并写入 `room.deleted` tombstone。房间和成员行 cascade 删除后，原有成员仍能读取删除事件，无关用户不能读取。

后台任务默认每小时执行，保留 7 天且每房间最多 10,000 个事件。它只删除连续旧前缀并推进 `minAvailableSeq`；删除房间的事件全部过期后再移除 stream。事件无需“合并”回 messages，因为当前状态已在原写事务中同步更新。

## 多实例通知

每个 app 实例都 `LISTEN room_event_committed`，从 PostgreSQL 读取精确的已提交 `(roomId, seq)`，再用 `io.local.to(roomId)` 发送 `room_event_available {roomId, headSeq, events?}`。完整通知只有在序列化后不超过 `ROOM_EVENT_FAST_PATH_MAX_BYTES`（默认 256 KiB）时才携带 event；读取失败或超限会退化为 head-only hint。同房间读取在单实例内串行，保持 emit 顺序。

PostgreSQL 负责跨实例 fan-out；每个 listener 只通知连接到本实例的 sockets。Redis adapter 继续服务那些确实只从一个实例产生、但需要跨实例投递的 transient/user-scoped 路径。这样无需 leader election，也不会出现旧设计的 N 个 listener 再各自做一次全局 Redis 广播。客户端 seq 检查仍是最终幂等保护。

`NOTIFY` 本身不持久。实例重新成功建立 `LISTEN` 后，而且必须在成功之后，向本机 socket 发 `room_sync_required {reason: "postgres_listener_reconnected"}`。Active client 保留现有 UI，从自己的 `lastAppliedSeq` replay。Socket reconnect、`focus` 和 `pageshow` 检查构成第二层反熵。

## 协议切换边界

Migration `0003_room_events_immutable_after_images` 持表锁安装 deferred after-image writer，并移除旧 ID-only triggers。Migration runner 用 PostgreSQL transaction advisory lock 串行化多个 app 同时启动。在同一 migration 事务中，旧的非确定性事件被清除，但 stream head 不重置。Active stream 把 `minAvailableSeq` 推到 `headSeq + 1`，旧 cursor 得到 `CURSOR_EXPIRED` 后 snapshot。Deleted stream 会得到一条新的 V1 `room.deleted` tombstone，并保留 `deleted_reader_ids`。即使 cursor 早于已清理前缀，服务端也直接返回这个终态事件；客户端只对这个 terminal event 允许一次 seq 跳跃，因此原成员不会进入无法完成的“删除房间 snapshot”循环。

Migration `0004_public_member_change_events` 会把 pre-production member after-image 全部改为无内容的 `members.changed`，并替换 member writer，从而消除成员隐私泄漏。公共事件流永远不包含离线成员 ID、角色或 joined time。直接的 `0003` / `0004` 边界要求维护窗口内停止所有旧 App instance；未来 AWS 若要滚动发布，必须先设计明确的两阶段兼容协议。

这是明确的直接切换，不长期维护双 decoder。它也不需要 realtime outbox：outbox 解决 competing worker 的副作用与重试，而 room replay 是已经与 canonical mutation 同事务持久化的 fan-out state transfer。`messageVersion` 同样只会重复 room seq，又不能表达漏掉了哪些提交。

## 验证证据

当前实现由以下层次保护：

- store、socket unit/contract tests；
- 精确已提交 payload、local-only fan-out、listener reconnect 反熵、字节超限 fallback、同房间顺序、fast path 零补拉、大 gap snapshot、cache 恢复、过期、数据库回退、坏 payload snapshot、删除、turn、room metadata、提前到达 AI transient buffer，以及 transient AI 更新期间保留 optimistic send 的 tests；
- 不依赖数据库的严格 V1 payload 单测覆盖全部 event type、空 AI/media content、缺失/额外字段、room 绑定、重复 ID 与退役 ID-only payload；
- 真实 PostgreSQL 的不可变 message/room/turn/media after-image、空公共成员 signal、旧成员事件隐私修复、严格 payload 拒绝、secret 排除、migration 切换、快照、幂等、回滚、并发、room metadata 单调性、retention 与删除授权测试；
- PostgreSQL Playwright：刷新/新 context、媒体/AI/分享、双客户端、离线追赶；
- Compose health、重启持久化与 backup/restore。

部署与迁移细节见 [房间事件同步与可迁移部署架构](room-event-sync-portable-deployment.zh.md)。
