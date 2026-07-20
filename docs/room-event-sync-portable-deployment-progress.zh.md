# 房间事件同步与可迁移部署实施进度

[English](room-event-sync-portable-deployment-progress.md)

状态：进行中

开始：2026-07-20

事实源设计：[目标架构](room-event-sync-portable-deployment.zh.md)

## 实施原则

- 所有代码只保留在本地仓库，不 push。
- 不提供旧 `messageVersion` 同步协议兼容层。
- 本地 Compose 和 Fly 必须运行同一应用代码；差异仅来自环境配置。
- 控制为三个左右阶段性 commit，不为每个小文件单独提交。
- 每项完成必须记录测试、build、Compose 或运行行为证据。

## 基线证据

开始时的本地 `master`：`d94d2cd0`。

- 根目录有生产 Dockerfile 和 Fly 配置，没有 Compose 配置；
- 云端 `PERSISTENCE_STORE=postgres`，Redis 用于实时状态和缓存；
- 客户端恢复仍发送 `baseMessageVersion`，服务端回传 `messageVersion`；
- 消息写入同时递增 `message_version` 和 `room_version`；
- Redis 消息 cache 使用 `messageVersion` generation；
- 当前工作树在实施前干净。

## 阶段状态

| 阶段 | 范围 | 状态 | 本地 commit | 验证证据 |
| --- | --- | --- | --- | --- |
| 1 | 最终设计、进度账本、Compose 本地运行骨架 | 已验证，待 commit | 待创建 | Compose 2.23 config/build、PostgreSQL health、restart persistence、custom dump |
| 2 | 服务端 stream/event schema、事务写入、snapshot/delta API、retention | 未开始 | 待创建 | store contract、PostgreSQL/Redis、socket tests |
| 3 | 客户端事件 reducer/cursor/cache、删除旧 version 路径、端到端验证 | 未开始 | 待创建 | hook tests、client/server build、Compose smoke |

## 阶段 1 清单

- [x] 目标架构文档落盘。
- [x] 进度文档落盘。
- [x] 增加 `compose.yaml`。
- [x] 增加无密钥 `.env.compose.example`，忽略真实 `.env.compose`。
- [x] 验证 Compose 配置解析。
- [x] 构建镜像并启动 PostgreSQL、Redis、RoomTalk。
- [x] 验证 `/api/status` 为 PostgreSQL persistence。
- [x] 执行按需 dump 并用 `pg_restore --list` 验证 archive。
- [x] 重启 PostgreSQL 后验证 marker room 仍存在，再清理 marker。
- [ ] 创建阶段 1 本地 commit；不 push。

## 阶段 2 变更清单

必须覆盖所有消息可见写路径：

- append / idempotent append / atomic-position append；
- media completion 与 media replacement；
- upsert、AI final/error、stream recovery；
- edit、delete、clear；
- truncate before/after、edit-and-ask、retry；
- Code Agent queue materialize/claim/delete；
- history replacement；
- room metadata update/delete；
- 失败事务、重复请求和批量写入。

服务端交付：

- [ ] `room_event_streams` / `room_events` schema 与迁移。
- [ ] `RoomEvent`、snapshot、delta store contract。
- [ ] PostgreSQL 原子 sequence/event 写入。
- [ ] Redis 等价原子行为。
- [ ] `get_room_snapshot` / `get_room_events`。
- [ ] live room event 带 canonical `seq`。
- [ ] cursor expiry 和 retention 前缀清理。
- [ ] 删除服务端 `baseMessageVersion` / `messageVersion` 运行时协议。
- [ ] 删除 cache 对 `messageVersion` 的依赖。

## 阶段 3 变更清单

- [ ] IndexedDB window 存储 `snapshotSeq/lastAppliedSeq`。
- [ ] snapshot/live race buffer。
- [ ] 重复、连续、缺口、expired cursor reducer。
- [ ] 旧历史分页继续使用 `oldestMessageId`。
- [ ] 删除 `messageVersionRef`、`mutationRevision` 和 version reconciliation retries。
- [ ] 更新房间对象排序为统一 `roomSeq`。
- [ ] 升级 message cache database name，旧 cache 不再读取。
- [ ] stale bundle 协议错误触发刷新。
- [ ] 更新 room reliability 文档为新事实源。

## 常见用例自动化测试矩阵

完成标准优先使用真实 PostgreSQL 集成测试和 Playwright E2E，不以 mock-only unit tests 代替跨层证据：

- [ ] 首次进入房间得到一致 snapshot 和 `snapshotSeq`。
- [ ] 在线连续消息按 seq 到达且刷新后保持一致。
- [ ] Socket 漏一条事件后通过 `afterSeq` 补齐。
- [ ] 重复事件、乱序事件不会重复或回退 UI。
- [ ] 网络断开/恢复、前后台切换、BFCache 和冷启动收敛。
- [ ] 事件 retention 后旧 cursor 返回 expired 并只重置一次。
- [ ] 两个客户端同时发送时得到无冲突的房间序列。
- [ ] 发送幂等重试不生成重复消息或重复事件。
- [ ] 编辑、单条删除、clear、truncate before/after 正确收敛。
- [ ] edit-and-ask / AI retry 的 suffix replacement 正确收敛。
- [ ] AI streaming 临时 chunk 不入日志，final/error 可在重连后恢复。
- [ ] media completion 和 Code Agent tool/final message 事件有界且可恢复。
- [ ] 服务端在状态写入与事件写入之间失败时整体回滚且不广播。
- [ ] 服务重启后事件 cursor、消息状态和客户端恢复保持一致。
- [ ] 过期/无权限客户端不能读取 snapshot 或 event delta。

## 最终验证矩阵

- [ ] server focused persistence/socket tests。
- [ ] server full test suite。
- [ ] client focused hook/state tests。
- [ ] client full test suite。
- [ ] server production build。
- [ ] client production build。
- [ ] PostgreSQL E2E。
- [ ] Compose clean-volume startup。
- [ ] Compose restart 后数据仍存在。
- [ ] backup -> fresh database restore。
- [ ] Fly Dockerfile build 不依赖 Compose。
- [ ] `git status` 只含本任务文件。
- [ ] 本地 commit 数量符合阶段规划。
- [ ] 确认没有 push。

## 进展日志

### 2026-07-20

- 确认选择“物化状态 + 事务事件日志 + snapshot fallback + retention”，不做完整 Event Sourcing。
- 确认本地使用 Compose 而非单机 Kubernetes；未来 AWS 默认映射 ECS/RDS/ElastiCache/S3。
- 用户明确要求直接替换同步协议，不实现兼容层。
- 开始阶段 1，加入设计、进度账本与 Compose 骨架。
- 当前 Docker Compose 2.23.3 成功解析配置；修正了不受该版本支持的 `env_file.required` 新语法。
- 根 Dockerfile 成功构建 `roomtalk-local:dev`；PostgreSQL、Redis 和 app health checks 通过。
- `/api/status` 返回 `persistenceStore=postgres`；PostgreSQL 重启后 marker room 保留。
- `postgres-backup` 生成 PostgreSQL 17 custom archive，`pg_restore --list` 成功读取 131 个 TOC entries。
