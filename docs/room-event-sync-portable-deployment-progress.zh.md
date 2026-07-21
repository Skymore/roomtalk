# 房间事件同步与可迁移部署实施进度

[English](room-event-sync-portable-deployment-progress.md)

状态：不可变事件源码实现已完成；尚未执行生产 migration

原基础设施切换：2026-07-20；不可变事件实现验证：2026-07-21

事实源设计：[目标架构](room-event-sync-portable-deployment.zh.md)

## 当时使用的切换规则

- 直接切换系列在生产证据完成前先保留本地，验证完整后把整组提交发布到 `origin/master`。
- 直接替换旧协议，不增加 `messageVersion` 兼容层。
- 本地 Compose、Fly 与未来 AWS 使用同一个应用镜像，只通过环境配置区分。
- 完成标准必须包含真实 PostgreSQL、浏览器、容器、重启与恢复证据。

## 基线与证据 commit

实施从干净的本地 `master` `d94d2cd0` 开始。旧客户端通过 `baseMessageVersion` 比较恢复；写入同时推进 `message_version` / `room_version`；Redis cache generation 使用 `messageVersion`；仓库当时没有 Compose runtime。

| 阶段 | 范围 | 状态 | 证据 commit |
| --- | --- | --- | --- |
| 1 | 架构决策、进度账本、初版 Compose runtime | 完成 | `ec0ac9af` |
| 2 | PostgreSQL event stream、Socket/client 直接切换、version 退役、integration/E2E | 完成 | `d2c051ab` |
| 3 | 运维演练、当前文档清理、最终证据 | 完成 | `63ef29bc` |
| 4 | 完成性审计：本地持久媒体、签名 URL、env interpolation、成对恢复 | 完成 | `77a5826c` |
| 5 | Mac 生产 runtime、SeaweedFS S3 目标、源数据演练、tunnel、备份恢复 | 完成 | `bdad6d2f`、`94d7feed`、`f878752d` |
| 6 | 最终停写、日志归档、数据恢复、DNS route、公开 HTTP/WebSocket/S3 smoke 与显式凭据 | 完成 | `a554554c`、`56871060` |
| 7 | 已提交事件 Socket fast path、有界 payload fallback 与大差距 snapshot 恢复 | 完成 | 当前发布；聚焦证据见下文 |
| 8 | 不可变 after-image event、listener local-only fan-out、重连反熵与一次性旧事件边界 | 源码完成，未部署 | 当前工作发布；验证见下文 |
| 9 | 公共成员隐私、严格 payload 拒绝与 placeholder 前 AI 有界缓冲 | 源码完成，未部署 | 当前工作发布；验证见下文 |

定时 Fly workflow 已禁用，Fly app 已缩到零；Supabase 与 Tigris 完整保留为回滚源。`room.ruit.me`、兼容域名 `roomtalk.ruit.me` 与 `roomtalk-objects.ruit.me` 已通过专用 Cloudflare Tunnel 指向 Mac。runtime 同时接受 `ai-chat.wenlin.dev`，该域名可在原有 DNS zone 中单独切换。

## 已交付架构

- PostgreSQL 是唯一 durable serving authority；Redis 只保存可重建的 realtime/cache state。
- Canonical 表仍是事实源；`room_events` 是有界、不可变的 `schemaVersion: 1` after-image changelog，不是完整 Event Sourcing。
- PostgreSQL row trigger 收集 room/message/agent-turn/media mutation，deferred writer 在原事务内追加完整安全 after-image。成员 mutation 只追加空的公共 `members.changed` signal；ID 与角色仍由 `get_room_role_members` 保护。Delta read 直接解码保存 payload，不 hydrate 当前 canonical 行。
- 客户端只使用 `snapshotSeq`、`afterSeq`、`lastAppliedSeq`。PostgreSQL `NOTIFY` 只是 commit 后 hint；每个 app 读取精确 sequence，再用 `io.local` 通知本机 sockets。
- 客户端只有在 Socket payload 与 `lastAppliedSeq` 严格连续时才直接应用。Payload 缺失、超限、重复或有 gap 仍然安全，因为 `headSeq` 会驱动 durable replay。
- PG listener 成功 re-LISTEN 后，本实例发送 local `room_sync_required`；客户端保留 UI，从当前 cursor replay。
- 差距不超过 500 events 时按每页 100 / 256 KiB replay；更大的保留窗口内差距直接切 repeatable-read snapshot，再只排空 snapshot 后的 tail。
- `CURSOR_EXPIRED`、无法收敛的序列缺口和恢复旧数据库后的 `CURSOR_AHEAD` 都会安全重取 snapshot。严格 V1 decoder 会把字段缺失、类型错误或意外字段拒绝为 `EVENT_PAYLOAD_INVALID`；客户端不确认该 seq，改用 canonical snapshot 替换状态。
- 旧 history socket 返回 `UPGRADE_REQUIRED`；runtime `messageVersion` / `roomVersion` 字段和数据库列已删除。
- 每小时 retention 只清理连续旧前缀。Canonical 状态已在原事务更新，不需要定期把 event “合并回” message。
- AI 任务继续使用独立 claim/retry outbox；面向客户端的 room event 不是 Worker job。
- 抢在 durable placeholder 前到达的 `ai_chunk`、`a2ui_update` 与 `ai_stream_end` 按 `messageId` 暂存；上限为 60 秒、64 个 message、512 events、512 KiB。Durable final after-image 优先于更早的缓冲数据。
- 旧 `new_message`、`message_edited`、`message_deleted`、`messages_cleared` durable broadcast 已移除；user-scoped `room_updated` 继续服务 room list 与 permission invalidation。
- Migration `0003_room_events_immutable_after_images` 串行化并发启动、安装新 writer、保留 stream head、让 active 旧历史过期，并为 deleted stream 追加带授权的 V1 tombstone。Migration `0004_public_member_change_events` 清洗可能存在的预生产成员 after-image，并安装空公共 signal。两者都已在 disposable PostgreSQL 运行通过；本轮没有对生产执行 migration，也没有部署应用。
- 生产必须使用维护窗口：停止所有旧 app、做成对 database/media backup，再只启动新镜像，避免 `0003`/`0004` 与旧 decoder/writer 重叠。未来 AWS 多实例发布需要两阶段兼容迁移，或同样的 stop-the-world cutover；只 push source 不会迁移数据库。
- 本地生产 Compose 在现有 S3 adapter 后运行 SeaweedFS 4.29，并继续使用带过期时间的 SigV4 URL；Tigris 与未来 AWS S3 共用相同 object key 和 SDK 边界，`/api/status` 会报告媒体是否就绪。
- Compose 命令强制带 `--env-file .env.compose`，确保 app 与 PostgreSQL 使用同一份配置凭据，而不是各自落到无关默认值。

## 服务端交付清单

- [x] `room_event_streams` / `room_events` schema、函数、trigger 与 migration。
- [x] `RoomEvent`、snapshot、delta store contract。
- [x] 同房间原子单调 sequence，事务 rollback 时 event 同步 rollback。
- [x] `get_room_snapshot` / `get_room_events` 与旧协议 upgrade fence。
- [x] `CURSOR_EXPIRED`、`CURSOR_AHEAD`、条数/字节分页限制。
- [x] PostgreSQL `LISTEN/NOTIFY` 跨 app instance 唤醒。
- [x] 每实例 `LISTEN` + `io.local`，避免 Redis adapter 把同一 durable hint 放大 N 份。
- [x] Listener re-LISTEN 后发送 local `room_sync_required` 反熵。
- [x] 不可变 Message/Room/RoomAgentTurn/media after-image、空公共 `members.changed` signal 与严格 `schemaVersion: 1` decoder。
- [x] 非法 payload 返回 `EVENT_PAYLOAD_INVALID`，不会作为空事件确认。
- [x] 并发安全 legacy-event migration boundary，active cursor expiry 与 deleted-room V1 tombstone。
- [x] 删除服务端运行协议与 cache 对 message/room version 的依赖。
- [x] Redis recent-message cache 改用 durable event head 守卫。
- [x] 默认 7 天、每房间 10,000 events 的 retention；删除房间 tombstone 过期后清理 stream。
- [x] Runtime 拒绝 Redis durable 模式；PostgreSQL 不可用时启动 fail closed。

## 客户端交付清单

- [x] IndexedDB v4 保存 recent window 与 `lastAppliedSeq`。
- [x] snapshot/live race 收敛，重复 event/wake-up 幂等。
- [x] 只应用连续序列；gap、expired、ahead 统一 snapshot fallback。
- [x] `beforeMessageId` 只 prepend 旧历史，不移动实时 cursor。
- [x] message/agent-turn upsert/delete 与 room update/delete reducer。
- [x] 删除 `messageVersionRef`、`mutationRevision` 与 version reconciliation retry。
- [x] 完整 room ack/broadcast 以 canonical `updatedAt` 防止旧对象回踩。
- [x] `updatedAt` 由数据库 trigger 严格单调盖章，只是完整对象的 last-write guard，不是第二套同步 version。
- [x] placeholder 前 AI chunk/A2UI/end 有界暂存并按序 drain；durable final 始终优先。
- [x] AI transient 更新分别处理 canonical 与当前 UI state，不覆盖动态加入的 pending/failed optimistic message。
- [x] 旧 IndexedDB cache 通过数据库名升级不再读取。

## 常见用例自动化矩阵

- [x] 首次进入房间得到 repeatable-read snapshot 与一致 `snapshotSeq`。
- [x] 在线连续发送、刷新和第二客户端无需刷新实时收敛；连续 Socket payload 无需再发 replay request。
- [x] 浏览器离线期间产生三条消息，恢复后只补缺失 events，无需 reload。
- [x] 重复通知/事件不重复 UI；oversized payload 退化为 head-only；乱序或小 gap 补拉，超过 500 events 的 gap 直接 snapshot。
- [x] retention 后旧 cursor 返回 `CURSOR_EXPIRED`；恢复较旧数据库返回 `CURSOR_AHEAD`。
- [x] 八个 PostgreSQL concurrent writer 得到无缺口 room sequence。
- [x] 更早开启但更晚写入的事务仍得到更大的 room `updatedAt`，不会旧对象回踩。
- [x] client-message 幂等重试不产生重复 canonical message/event。
- [x] 写入失败与事务 rollback 不留下 event，也不广播 ghost state。
- [x] edit、单条 delete、clear、truncate before/after、retry、edit-and-ask 收敛。
- [x] AI streaming 临时 chunk 不入日志；placeholder 前事件不会丢，final/error 与 agent turn 可恢复。
- [x] media completion、图片刷新、Code Agent tool/final 路径使用有界 canonical event。
- [x] 生产 local media 的签名/过期/method 约束、浏览器上传刷新、app restart 后字节持久化，以及 database/media 成对恢复。
- [x] 无权限用户不能读 snapshot/delta；删除前有权限用户可重放 `room.deleted` tombstone。
- [x] 房间删除 cascade 后 tombstone 仍可读，retention 后连同授权 stream 清理。
- [x] 两个 Store 同时初始化同一 schema 时，immutable-event migration 只应用一次；显式 DTO allowlist 不会泄漏后来新增的内部列。
- [x] 公共成员 event 不含 member ID/role；`0004` 会清洗旧 payload；坏 event 不推进 cursor，合法空内容 AI placeholder 可严格解码。
- [x] 普通 Server test 不依赖 PostgreSQL 即覆盖全部 V1 event type、空 AI/media content 与各类非法 payload。

## 最终验证证据

| 验证 | 结果 |
| --- | --- |
| Server full suite | 763/763 |
| Client full suite | 1,000/1,000 |
| Event hook + pending-AI-buffer focused | 30/30 |
| Broadcaster + listener focused | 7/7 |
| Message socket focused | 30/30 |
| 真实 PostgreSQL event integration | 全新 disposable database 15/15 |
| PostgreSQL Playwright | 4/4 |
| Server/client production build | 通过 |
| 根 Dockerfile 独立构建 | 通过，不依赖 Compose build 输入 |
| Client ESLint / i18n | 通过 |
| PostgreSQL persistence smoke | 正向 API 通过；不可用数据库在 listen 前非零退出 |
| Compose config/build/health | 全新隔离栈与标准栈均通过；status 为 PostgreSQL、Redis 与 configured media |
| PostgreSQL restart persistence | marker 与 event head 保留 |
| Listener/pool restart recovery | pool 处理断连，LISTEN 1 秒内恢复，无 uncaught exception |
| Backup -> fresh restore | 同时间戳 PostgreSQL 17 custom archive（170 TOC）与 media tarball 均恢复到全新目标 |
| 生产 PostgreSQL 演练 | Supabase `public` dump 恢复到隔离 PostgreSQL 17；当前 migrations 和 event schema 均成功启动 |
| 生产 S3 演练 | 2,857 个 Tigris objects / 1,302,853,579 bytes 已复制并在 SeaweedFS 校验 |
| SeaweedFS 维护恢复 | 同时间戳数据库 dump 可恢复；原始对象快照启动成隔离 S3 后完整读取全部对象和字节 |
| 公开 edge | TLS、首页/status HTTP 通过；Socket.IO polling 与 WebSocket upgrade 返回有效 session / `101 Switching Protocols` |
| 生产端到端 smoke | 注册/建房/加入、文本 snapshot、room-event delta、公开 presigned S3 PUT/GET 字节一致、删除 tombstone 与清理全部通过 |

Event schema 演练的全新恢复库中有 1 个 room、member、message、stream 和 2 个有序 event（`headSeq=2`）。九个 event trigger 与一个 room 单调时间 trigger 全部存在，退役 version column 数量为 0。后续成对演练把 `backups/roomtalk-20260720T123725Z.dump` 恢复到全新数据库，并把 `backups/roomtalk-media-20260720T123725Z.tar.gz` 恢复到全新 volume；room/media/message 关系一致，媒体对象 SHA-256 与源文件逐字节相同。临时数据库、volume、marker 和隔离 Compose 项目均已删除。

完成性审计还使用自定义 `.env.compose` 密码渲染 Compose，证明 PostgreSQL service password 与 app `DATABASE_URL` 一致。当前 Fly secrets 已导入 macOS Keychain，本地生产配置再改写为 `room.ruit.me`、Compose PostgreSQL/Redis 与 SeaweedFS；credential 没有写入 tracked file。

生产数据演练恢复了 `backups/roomtalk-supabase-public-precutover-20260720T1958Z.dump`；停写后的正式切换恢复了 `backups/roomtalk-supabase-public-final-20260720T2019Z.dump`。两者都与源端一致：98 rooms、7,939 messages、179 members、404 media assets、6,361 observability events、28 outbox events、60 room-agent turns。启动后退役 version columns 已删除、98 个 room streams 已建立、全部 room-event triggers 存在。历史行继续作为 snapshot state，不伪造 event；切换后的新写入才追加 event。

Tigris 全量预复制覆盖 private room media、published sites 和 stickers，共 2,857 objects、1,302,853,579 bytes。`node scripts/backup-local-production.mjs` 随后停止 edge/app/object storage，生成同一时间戳的 PostgreSQL archive 与 SeaweedFS snapshot，再自动恢复健康栈。两份 artifact 都恢复到隔离目标；S3 inventory 完全一致，临时目标已经删除。

重启演练第一次发现 node-postgres idle client 断连会冒泡到全局 `uncaughtException`。已增加 pool-level error handler 和单测；第二次真实 PostgreSQL restart 只记录预期 handled warning，API 继续健康且 `LISTEN room_event_committed` 自动恢复。

## 回滚与持续运维

Fly 运行日志已在停机前归档；数据库内的 observability/outbox/turn 日志随最终 dump 迁移。回滚窗口结束前保留 Fly、Supabase 与 Tigris。新本地目标开放写入后，只改 DNS 回滚会丢新增数据，必须先协调这些写入。定期运行成对维护备份并复制到异机；Mac 保持接电，Docker Desktop 必须持续运行。
