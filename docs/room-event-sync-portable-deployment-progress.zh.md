# 房间事件同步与可迁移部署实施进度

[English](room-event-sync-portable-deployment-progress.md)

状态：本地实现与验证完成；未执行生产数据/DNS 切换

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

没有 push 任何 commit，也没有修改 Fly 服务、Supabase 数据库、生产 DNS 或生产数据。

## 已交付架构

- PostgreSQL 是唯一 durable serving authority；Redis 只保存可重建的 realtime/cache state。
- Canonical 表仍是事实源；`room_events` 是有界状态传输 changelog，不是完整 Event Sourcing。
- PostgreSQL trigger 在 room/message/agent-turn 原事务内原子追加 room event。
- 客户端只使用 `snapshotSeq`、`afterSeq`、`lastAppliedSeq`；Socket.IO/`NOTIFY` 只做唤醒 hint。
- `CURSOR_EXPIRED`、序列缺口和恢复旧数据库后的 `CURSOR_AHEAD` 都会安全重取 snapshot。
- 旧 history socket 返回 `UPGRADE_REQUIRED`；runtime `messageVersion` / `roomVersion` 字段和数据库列已删除。
- 每小时 retention 只清理连续旧前缀。Canonical 状态已在原事务更新，不需要定期把 event “合并回” message。
- AI 任务继续使用独立 claim/retry outbox；面向客户端的 room event 不是 Worker job。

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
- [x] 无权限用户不能读 snapshot/delta；删除前有权限用户可重放 `room.deleted` tombstone。
- [x] 房间删除 cascade 后 tombstone 仍可读，retention 后连同授权 stream 清理。

## 最终验证证据

| 验证 | 结果 |
| --- | --- |
| Server full suite | 740/740 |
| Client full suite | 985/985 |
| Event hook focused | 15/15 |
| Message socket focused | 29/29 |
| 真实 PostgreSQL event integration | 6/6 |
| PostgreSQL Playwright | 4/4 |
| Server/client production build | 通过 |
| 根 Dockerfile 独立构建 | 通过，不依赖 Compose build 输入 |
| Client ESLint / i18n | 通过 |
| PostgreSQL persistence smoke | 正向 API 通过；不可用数据库在 listen 前非零退出 |
| Compose config/build/health | 通过；status 为 PostgreSQL，app/PostgreSQL/Redis healthy |
| PostgreSQL restart persistence | marker 与 event head 保留 |
| Listener/pool restart recovery | pool 处理断连，LISTEN 1 秒内恢复，无 uncaught exception |
| Backup -> fresh restore | PostgreSQL 17 custom archive，170 TOC entries，恢复成功 |

全新恢复库中有 1 个 room、member、message、stream 和 2 个有序 event（`headSeq=2`）。九个 event trigger 与一个 room 单调时间 trigger 全部存在，退役 version column 数量为 0。验证后已删除源库 marker 和临时 restore database；最终 dump 为 ignored `backups/roomtalk-20260720T122146Z.dump`。

重启演练第一次发现 node-postgres idle client 断连会冒泡到全局 `uncaughtException`。已增加 pool-level error handler 和单测；第二次真实 PostgreSQL restart 只记录预期 handled warning，API 继续健康且 `LISTEN room_event_committed` 自动恢复。

## 尚未执行的生产操作

代码已具备维护窗口直接切换条件，但本次没有擅自切生产。真正迁移前仍需：

1. 获取当前 Supabase custom dump，并在隔离库实际 restore；
2. 单独复制/校验对象存储；
3. 冻结 Fly writer 与 worker；
4. 恢复最终 dump，执行 schema、count/invariant、integration、Playwright；
5. 通过临时 origin smoke 后再切 ingress/DNS；
6. 回滚窗口结束前保持旧 PostgreSQL 只读。

新本地目标一旦开放写入，只改 DNS 回滚会丢新增数据，必须先协调这些写入。
