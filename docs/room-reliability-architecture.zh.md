# RoomTalk 房间可靠性架构

[English](room-reliability-architecture.md)

状态：已实现并部署到 `room.ruit.me`

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
- `CURSOR_AHEAD`：数据库恢复点落后于浏览器 cache。客户端先清除旧 `desiredHeadSeq`，再加载 snapshot；请求期间收到的新通知仍会保留。这样数据库 head 后退时，旧高水位不会让客户端反复请求同一空页。

更早历史仍用 `beforeMessageId` 分页；prepend 旧页不能推进实时事件 cursor。实时 replay 或连续 Socket fast path 一旦开始，就会立刻让在途 prepend token 失效，因此迟到的历史响应不能把刚删除的消息重新插回界面。如果 boundary message 在 PostgreSQL 返回分页前已经被删，服务端返回 `PAGINATION_BOUNDARY_EXPIRED`，客户端改做 replace snapshot，不会把空页误判成历史终点。

浏览器用一个 per-room 状态机统一协调这些路径，阶段明确为 `idle`、`replay`、`replace` 和 `prepend`。实时 replay 与 replace recovery 的优先级高于可选的历史分页：prepend 不能取消正在运行的 replace，replace 会让更早发出的 prepend response 失效。`CURSOR_AHEAD` 会同时清除旧目标 head 与 `lastGapSnapshotTarget`。如果删除事件清空了当前窗口，而此前 `hasMore=true`，或者收到 `message_history_invalidated` 表示历史被截断，控制器会重新 replace window，不会把空数组误判成“没有更早历史”。

## 事件语义

这里是有界、不可变的 after-image changelog，不是审计日志，也不是完整 Event Sourcing。Canonical 表仍是事实源，但每个保留事件自身可以确定性重放：`readRoomEvents()` 严格解码已保存的 `schemaVersion: 1` discriminated payload，绝不会再用当前 `room_messages`、`room_agent_turns` 或 `rooms` 行替换旧事件内容。字段缺失、类型错误或意外字段会触发 `EVENT_PAYLOAD_INVALID`；客户端不跨过该 cursor，而是从 canonical snapshot 替换状态。Message after-image 保存稳定 media asset ID 与必要元数据，但排除内部 object key、uploader ID、stream owner、password hash 和会过期的签名 URL。

| 事件 | 客户端动作 |
| --- | --- |
| `messages.upserted` | 按 ID upsert 已保存的 Message after-image 并恢复 canonical 顺序 |
| `messages.deleted` | 删除 ID；即使被删媒体不在当前窗口，也清理该房间的媒体 cache |
| `agent_turns.upserted` | upsert 已保存的 RoomAgentTurn after-image |
| `agent_turns.deleted` | 删除 turn ID |
| `members.changed` | 不暴露任何成员数据；刷新当前权限，有权限的管理界面再通过 `room.manageMembers` 鉴权读取 |
| `room.updated` | 把已保存的完整 SafeRoom after-image 交给正常 room commit guard |
| `room.deleted` | 清理 cache、从页面列表移除房间、退出旧 Socket room，并返回房间列表 |

clear、truncate、retry、edit-and-ask 会表现为一个或多个有序批量 upsert/delete 事件。因此“一次业务操作恰好一个事件”不是约束；真正约束是：每个已提交的可见行变化与事件同事务，事务回滚时两者都不存在。

AI chunk 和增量 UI 更新仍是临时 Socket fast path。它们可能抢在 placeholder 的独立 PostgreSQL 通知前到达，因此浏览器按 `messageId` 缓存未匹配的 `ai_chunk`、`a2ui_update` 与 `ai_stream_end`，placeholder 出现后按到达顺序排空。缓存上限是 64 个 message ID、512 个事件、512 KiB 和 60 秒 TTL。Placeholder 已存在后，每个临时 handler 分别更新规范投影，并对当前 React state 应用相同 reducer，而不是整体替换，因此并发加入的 pending/failed optimistic send 不会消失。

错误使用同一思想的确定性版本。`ai_stream_error` 必须携带 `messageId`、`error` 与 `persisted`。正常路径先持久化完整、用户可见且 `status: error` 的 Message，再发送 `{ persisted: true, message }`，其中 Message 就是同一条安全 after-image。如果请求路径耗尽即时持久化重试，服务端发送 `{ persisted: false }`；浏览器会立刻把已有 placeholder 改成终态 error，并把本地 error overlay 保留到 replace snapshot 之后，而不是让 UI 永远停在 `streaming`。

这个失败不会一直等到下次重启。进程内 terminal-persist reconciler 保存同一条终态 Message，并用有界指数退避持续重试，直到 PostgreSQL 接受写入并产生正常的 `messages.upserted`。每个 stream owner 同时在 PostgreSQL 续租；周期性的 singleton recovery 只有在 owner lease 缺失或过期时，才会把 `streaming` placeholder 改为 `error`，因此新实例不会终止另一台活实例仍在生成的内容。错误若早于 placeholder 到达，仍按 `messageId` 暂存；后续 durable terminal after-image 会清除 overlay 并重新成为事实源。`aiStreamOwnerId` 等内部恢复字段在 fast path 发出前会被删除。

Message identity 还有一条数据库级 invariant：message ID 创建后不能更换 `room_id`。PostgreSQL 会拒绝跨房间冲突 upsert，因此“移动”不会在源房间留下 ghost after-image。未来若产品真的需要移动消息，应显式建模为源房间 delete 与目标房间 upsert，而不是放松这个约束。

Typing、presence、voice level 和 WebRTC signalling 同样属于 transient，不消耗 durable room sequence。未来如果 reaction 成为持久产品模型，它的 `reactions.upserted` / `reactions.deleted` after-image 应进入这条 sequence，而不是引入第二套 version counter。

## 删除权限与 retention

删除房间前，PostgreSQL 在独立 stream 行记录当时有权访问的用户 ID，并写入 `room.deleted` tombstone。房间和成员行 cascade 删除后，原有成员仍能读取删除事件，无关用户不能读取。

后台任务默认每小时执行，保留 7 天且每房间最多 10,000 个事件。`room_events.created_at` 使用 `clock_timestamp()`，所以 retention 依据事件真正 materialize 的时间，而不是长事务开始时间。任务只删除连续旧前缀并推进 `minAvailableSeq`；删除房间的事件全部过期后再移除 stream。PostgreSQL advisory lock 保证多副本中只有一个实例执行 retention。事件无需“合并”回 messages，因为当前状态已在原写事务中同步更新。

## 多实例通知

每个 app 实例都 `LISTEN room_event_committed`，再用 `io.local.to(roomId)` 发送 `room_event_available {roomId, headSeq, events?}`。实例会先检查本机是否真的有该房间订阅者；没有本地 socket 时不读取 PostgreSQL payload。同房间通知只保留固定大小的 min/max pending state，因此突发通知不会为每条 event 各排一个 waiter、数据库读取和 broadcast promise。只有完整连续 range 的序列化结果不超过 `ROOM_EVENT_FAST_PATH_MAX_BYTES`（默认 256 KiB）时才带 payload；读取不完整、失败或超限时统一退化为一个最高水位 head-only hint。`get_room_events` 对第一条 event 也执行 byte budget；若单条就超限，返回 `EVENT_TOO_LARGE`，客户端改走有界 snapshot，不会悄悄突破调用方声明的内存上限。

任何完整 durable payload 发出前，实例先解析本机 socket 的 client ID。认证/注册成功后写入服务端持有的 `socket.data`，它在该连接生命周期内是权威身份；Redis session map 只是可重建的跨实例索引。Redis row 缺失时继续使用本机身份，并在 PostgreSQL 重新确认每个候选房间的 membership 后异步重建 session、rooms 和 presence；Redis 存在非空冲突身份时 fail closed，并只发送一次 `registration_required`。随后对去重后的 client ID 做 PostgreSQL membership 查询。结果分三种：authorized 可以收完整 payload；明确 unauthorized 的 socket 先收到 `room_removed` 并离开；身份无法解析、身份冲突或 PostgreSQL 授权不可用时，不移除任何连接，只把这次投递降级为 head-only，并记录 authorization-unavailable metric。客户端对 `ROOM_AUTH_UNAVAILABLE` / `NOT_REGISTERED` 使用单定时器指数重试，短暂索引故障不会让已挂载房间永久停止 replay。

PostgreSQL 负责跨实例 fan-out；每个 listener 只通知连接到本实例的 sockets。Redis adapter 继续服务那些确实只从一个实例产生、但需要跨实例投递的 transient/user-scoped 路径。这样无需 leader election，也不会出现旧设计的 N 个 listener 再各自做一次全局 Redis 广播。客户端 seq 检查仍是最终幂等保护。

`NOTIFY` 本身不持久。失效 listener generation 会被显式关闭，也不能再投递通知。新 generation 成功建立 `LISTEN` 后，而且必须在成功之后，才向本机 socket 发 `room_sync_required {reason: "postgres_listener_reconnected"}`。Active client 保留现有 UI，从自己的 `lastAppliedSeq` replay。Socket reconnect、`focus` 和 `pageshow` 检查构成第二层反熵。

Realtime 与任务恢复也按实例划分。每个进程生成唯一 runtime instance ID，在 Redis 续租 TTL heartbeat，并记录自己拥有的 sockets。Heartbeat 和实例注册在同一段 Lua 内完成；清理也在 Lua 内重新检查 heartbeat，并且只删除 `socket:instances` 仍指向目标实例的记录，避免“清理检查后旧实例复活”的 TOCTOU 竞态。若一个仍有本机连接的进程发现自己曾失去、现在重新取得 lease，它会重新校验 PostgreSQL membership，再重建本机 socket session、room member set 和 browser presence。滚动启动不会清空其他实例的 presence。Code Agent turn 与 sandbox recovery 查询会排除仍受未过期 fenced room lease 保护的记录。Recovery 与 retention loop 都用 PostgreSQL advisory lock，因此所有副本可以运行同一镜像，但每轮只有一个实例执行维护。若某进程暂停到 lease 过期，它就被视为失去所有权；权威依据是 lease，不是进程内存或 hostname。

AI side effect 和最终消息状态也使用 generation fencing。`outbox_events.attempts` 在 claim 时递增，`workerId + attempt` 构成 claim token；长任务周期续租，续租失败会 abort provider 调用，旧 token 不能 mark processed/failed。相同 attempt 同时写入 AI placeholder 的 `ai_stream_fence`。最终 `complete/error` 只能条件更新仍为 `streaming` 且 owner/fence 完全相同的现有行；placeholder 已删除、已完成或已被更高 fence 接管时返回 obsolete，不插入、不覆盖。进程内 terminal reconciler 也携带同一个 ownership token。`ai_stream_owner_id/ai_stream_fence` 只是并发控制元数据，单独变化不会生成公开 room event；真正内容/status 终态只产生一个 immutable after-image。

## 协议切换边界

Migration `0003_room_events_immutable_after_images` 持表锁安装 deferred after-image writer，并移除旧 ID-only triggers。Migration runner 用 PostgreSQL transaction advisory lock 串行化多个 app 同时启动。在同一 migration 事务中，旧的非确定性事件被清除，但 stream head 不重置。Active stream 把 `minAvailableSeq` 推到 `headSeq + 1`，旧 cursor 得到 `CURSOR_EXPIRED` 后 snapshot。Deleted stream 会得到一条新的 V1 `room.deleted` tombstone，并保留 `deleted_reader_ids`。即使 cursor 早于已清理前缀，服务端也直接返回这个终态事件；客户端只对这个 terminal event 允许一次 seq 跳跃，因此原成员不会进入无法完成的“删除房间 snapshot”循环。

Migration `0004_public_member_change_events` 会把 pre-production member after-image 全部改为无内容的 `members.changed`，并替换 member writer，从而消除成员隐私泄漏。公共事件流永远不包含离线成员 ID、角色或 joined time。生产在 2026-07-21 完成 PostgreSQL/SeaweedFS 成对备份并停止全部旧 app 后执行了 `0003` 和 `0004`。未来 AWS 若要滚动发布，仍需先设计明确的两阶段兼容协议。

Migration `0005_message_room_immutability_and_event_clock` 会拒绝修改 `room_messages.room_id`，并把 room event 的时间戳切换到 wall-clock materialization time。它不改变 V1 payload 结构，因此当前 reader 可以直接应用，不需要双 decoder。

Migration `0006_ai_stream_owner_leases` 增加 AI 终态恢复使用的 PostgreSQL owner/instance heartbeat 表。它虽然不改变 room-event payload，但首次部署不兼容 pre-`0006` binary 的滚动混跑：旧进程不会写新 lease，新进程可能把它仍在生成的 placeholder 误判成 orphan。引入 `0006` 前必须停止全部旧 App；所有副本都能续租后，后续协议兼容版本才可正常滚动。

Migration `0007_ai_stream_fencing` 给每个 AI placeholder 增加单调 generation；Migration `0008_ai_stream_internal_event_filter` 把 ownership-only UPDATE 从公开 room seq 中排除。二者分开是为了保持已经记账的 `0007` 永远不可变。引入时必须确保旧 App/Worker 已全部停止，因为旧 binary 仍能使用无 fence 的 upsert 写终态；只有所有副本都使用条件 finalize 和 fenced outbox ack 后，才恢复滚动发布。

这是明确的直接切换，不长期维护双 decoder。它也不需要 realtime outbox：outbox 解决 competing worker 的副作用与重试，而 room replay 是已经与 canonical mutation 同事务持久化的 fan-out state transfer。`messageVersion` 同样只会重复 room seq，又不能表达漏掉了哪些提交。

## 验证证据

当前实现由以下层次保护：

- store、socket unit/contract tests；
- broadcaster/reducer/state-machine tests 覆盖精确已提交 payload、无本地订阅短路、local-only fan-out、三态成员授权、有界突发水位合并、listener generation 替换、首事件 byte rejection、fast path 零补拉、实时 replay 与 prepend 竞态、过期分页边界、窗口删空且不缓存无效状态、大 gap snapshot、cache 恢复、数据库回退时重置水位与 gap target、页面生命周期回调、删除、turn、room metadata、提前到达 AI 临时事件、AI 持久/未持久终态、数秒数据库故障后的终态重试，以及临时 AI 更新期间保留 optimistic send；
- 不依赖数据库的严格 V1 payload 单测覆盖全部 event type、空 AI/media content、缺失/额外字段、room 绑定、重复 ID 与退役 ID-only payload；
- 真实 PostgreSQL 测试覆盖不可变 message/room/turn/media after-image、message 房间不可变、wall-clock event timestamp、空公共成员 signal、旧成员事件隐私修复、严格 payload 拒绝、secret 排除、migration 切换、快照、幂等、回滚、并发、retention、跨 600 条旧事件直达 tombstone、首事件 byte limit、活跃/过期 Code Agent 与 AI owner lease，以及 singleton advisory lock。GitHub CI 在 Node 24.18 下启动 PostgreSQL 17 并强制提供 `ROOM_EVENT_TEST_DATABASE_URL`，因此该套件不能在 CI 静默 skip；
- PostgreSQL Playwright：刷新/新 context、媒体/AI/分享、双客户端、离线追赶；
- Compose health、重启持久化与 backup/restore。

健康证据会区分进程存活与可对外服务。`/api/health/live` 不依赖任何下游，只回答 Node 进程是否还能处理 HTTP；`/api/status` 与 `/api/health/ready` 会执行真实 RoomTalk 表查询、Redis `PING`、S3-compatible bucket 探测和 Socket adapter 检查。依赖失败会得到 HTTP 503、`status: "degraded"`、明确的依赖状态与 `rooms: null`，数据库故障不再折叠成合法业务状态 `rooms: 0`。Compose 使用 readiness endpoint；Kubernetes 则应分别把两个 endpoint 配给对应 probe。

部署与迁移细节见 [房间事件同步与可迁移部署架构](room-event-sync-portable-deployment.zh.md)。
