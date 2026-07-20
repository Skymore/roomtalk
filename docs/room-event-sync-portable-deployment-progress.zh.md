# 房间事件同步与可迁移部署实施进度

[English](room-event-sync-portable-deployment-progress.md)

状态：`room.ruit.me` 生产自托管切换完成

本地开始/完成：2026-07-20

事实源设计：[目标架构](room-event-sync-portable-deployment.zh.md)

## 实施原则

- 所有改动只保留在本地仓库，不 push。
- 直接替换旧协议，不增加 `messageVersion` 兼容层。
- 本地 Compose、Fly 与未来 AWS 使用同一个应用镜像，只通过环境配置区分。
- 完成标准必须包含真实 PostgreSQL、浏览器、容器、重启与恢复证据。

## 基线与本地 commit

实施从干净的本地 `master` `d94d2cd0` 开始。旧客户端通过 `baseMessageVersion` 比较恢复；写入同时推进 `message_version` / `room_version`；Redis cache generation 使用 `messageVersion`；仓库当时没有 Compose runtime。

| 阶段 | 范围 | 状态 | 本地 commit |
| --- | --- | --- | --- |
| 1 | 架构决策、进度账本、初版 Compose runtime | 完成 | `ec0ac9af` |
| 2 | PostgreSQL event stream、Socket/client 直接切换、version 退役、integration/E2E | 完成 | `d2c051ab` |
| 3 | 运维演练、当前文档清理、最终证据 | 完成 | 本文档 commit |
| 4 | 完成性审计：本地持久媒体、签名 URL、env interpolation、成对恢复 | 完成 | 本次收尾 commit |
| 5 | Mac 生产 runtime、SeaweedFS S3 目标、源数据演练、tunnel、备份恢复 | 完成 | 本次 self-host commit |
| 6 | 最终停写、日志归档、数据恢复、DNS route、公开 HTTP/WebSocket/S3 smoke | 完成 | 本次 cutover commit |

定时 Fly workflow 已禁用，Fly app 已缩到零；Supabase 与 Tigris 完整保留为回滚源。`room.ruit.me`、兼容域名 `roomtalk.ruit.me` 与 `roomtalk-objects.ruit.me` 已通过专用 Cloudflare Tunnel 指向 Mac。runtime 同时接受 `ai-chat.wenlin.dev`，该域名可在原有 DNS zone 中单独切换。

## 已交付架构

- PostgreSQL 是唯一 durable serving authority；Redis 只保存可重建的 realtime/cache state。
- Canonical 表仍是事实源；`room_events` 是有界状态传输 changelog，不是完整 Event Sourcing。
- PostgreSQL trigger 在 room/message/agent-turn 原事务内原子追加 room event。
- 客户端只使用 `snapshotSeq`、`afterSeq`、`lastAppliedSeq`；Socket.IO/`NOTIFY` 只做唤醒 hint。
- `CURSOR_EXPIRED`、序列缺口和恢复旧数据库后的 `CURSOR_AHEAD` 都会安全重取 snapshot。
- 旧 history socket 返回 `UPGRADE_REQUIRED`；runtime `messageVersion` / `roomVersion` 字段和数据库列已删除。
- 每小时 retention 只清理连续旧前缀。Canonical 状态已在原事务更新，不需要定期把 event “合并回” message。
- AI 任务继续使用独立 claim/retry outbox；面向客户端的 room event 不是 Worker job。
- 本地生产 Compose 在现有 S3 adapter 后运行 SeaweedFS 4.29，并继续使用带过期时间的 SigV4 URL；Tigris 与未来 AWS S3 共用相同 object key 和 SDK 边界，`/api/status` 会报告媒体是否就绪。
- Compose 命令强制带 `--env-file .env.compose`，确保 app 与 PostgreSQL 使用同一份配置凭据，而不是各自落到无关默认值。

## 服务端交付清单

- [x] `room_event_streams` / `room_events` schema、函数、trigger 与 migration。
- [x] `RoomEvent`、snapshot、delta store contract。
- [x] 同房间原子单调 sequence，事务 rollback 时 event 同步 rollback。
- [x] `get_room_snapshot` / `get_room_events` 与旧协议 upgrade fence。
- [x] `CURSOR_EXPIRED`、`CURSOR_AHEAD`、条数/字节分页限制。
- [x] PostgreSQL `LISTEN/NOTIFY` 跨 app instance 唤醒。
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
- [x] 旧 IndexedDB cache 通过数据库名升级不再读取。

## 常见用例自动化矩阵

- [x] 首次进入房间得到 repeatable-read snapshot 与一致 `snapshotSeq`。
- [x] 在线连续发送、刷新和第二客户端无需刷新实时收敛。
- [x] 浏览器离线期间产生三条消息，恢复后只补缺失 events，无需 reload。
- [x] 重复唤醒/事件不重复 UI；乱序或 gap 不应用半页并重新 snapshot。
- [x] retention 后旧 cursor 返回 `CURSOR_EXPIRED`；恢复较旧数据库返回 `CURSOR_AHEAD`。
- [x] 八个 PostgreSQL concurrent writer 得到无缺口 room sequence。
- [x] 更早开启但更晚写入的事务仍得到更大的 room `updatedAt`，不会旧对象回踩。
- [x] client-message 幂等重试不产生重复 canonical message/event。
- [x] 写入失败与事务 rollback 不留下 event，也不广播 ghost state。
- [x] edit、单条 delete、clear、truncate before/after、retry、edit-and-ask 收敛。
- [x] AI streaming 临时 chunk 不入日志；final/error 与 agent turn 可恢复。
- [x] media completion、图片刷新、Code Agent tool/final 路径使用有界 canonical event。
- [x] 生产 local media 的签名/过期/method 约束、浏览器上传刷新、app restart 后字节持久化，以及 database/media 成对恢复。
- [x] 无权限用户不能读 snapshot/delta；删除前有权限用户可重放 `room.deleted` tombstone。
- [x] 房间删除 cascade 后 tombstone 仍可读，retention 后连同授权 stream 清理。

## 最终验证证据

| 验证 | 结果 |
| --- | --- |
| Server full suite | 749/749 |
| Client full suite | 985/985 |
| Event hook focused | 15/15 |
| Message socket focused | 29/29 |
| 真实 PostgreSQL event integration | 6/6 |
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
