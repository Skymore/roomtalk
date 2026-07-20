# Redis/PostgreSQL 持久化重构计划

[English](postgres-persistence-plan.en.md)

Reviewed: 2026-07-12

> 状态：已完成的历史计划。本文保留迁移设计和阶段验收记录；当前可操作步骤以
> [postgres-rollout-runbook.md](./postgres-rollout-runbook.md)、`server/.env.example`
> 和 `server/src/repositories/postgresSchema.ts` 为准。当前 PostgreSQL schema
> 已扩展到 room members/saves、auth/account、push subscriptions、`media_assets`、
> `pending_media_uploads` 和 audio transcriptions 等表。
>
> 2026-07-20 补充：本文中的 Redis durable fallback 和消息版本缓存属于历史迁移阶段，
> 已被[房间事件同步方案](./room-event-sync-portable-deployment.zh.md)取代。当前运行时强制
> PostgreSQL，并以 `snapshotSeq/afterSeq` 和 room-event head 作为同步/缓存边界。

## 目标

把当前单 Redis 存储拆成两个明确职责：

- PostgreSQL：持久事实来源，保存房间、消息、AI 用量/成本、可恢复的消息状态。
- Redis：实时协作状态，保存 socket 会话、在线成员、Socket.IO adapter、短 TTL 缓存和流式生成中的临时 buffer。

第一版必须保持 Redis 默认路径可用；PostgreSQL 通过配置启用，便于灰度和回滚。

## 核心原则

1. 持久业务数据以 PostgreSQL 为准。Redis 不能成为房间、历史消息、成本账本的唯一来源。
2. 正在进行的 AI 回复不能只存在 Redis。PostgreSQL 至少要有 `streaming` 占位消息，Redis 只保存流式增量或短期加速数据。
3. Socket 推送是性能优化，不是可靠投递。客户端重连后以持久层的消息历史补齐状态。
4. 写入路径先完成持久层事务，再刷新/失效 Redis 缓存，最后广播 socket 事件。
5. 若 Redis 缓存失效失败，PostgreSQL 仍是正确数据；TTL 用于限制最长脏读窗口。

## 数据分工

### PostgreSQL

- `rooms`：房间元数据、创建者、创建时间、最后活跃时间。
- `room_messages`：房间消息历史，包含用户消息、图片消息、AI 消息、`streaming/complete/error` 状态、usage/cost metadata。
- `room_ai_cost_totals`：房间级 AI 成本累加值。
- 后续可扩展 `message_events` / `outbox_events`，用于可靠 socket 重放和异步缓存失效。

### Redis

- `socket:clients`：socketId 到 clientId。
- `socket:rooms`：socketId 当前加入的房间。
- `room:{roomId}:members`：在线成员计数。
- Socket.IO Redis adapter pub/sub。
- 后续可扩展：
  - `cache:room:{roomId}:messages:v{version}`：短 TTL 最近消息缓存。
  - `stream:message:{messageId}`：AI 流式 chunk buffer，TTL 30 分钟。
  - `lock:room:{roomId}:ai`：可选的同房间 AI 生成并发控制。

## “正在进行”的判定

不使用“用户在线”判断对话是否正在进行。在线只说明 realtime session 活跃，不说明有未完成持久事务。

第一版判定规则：

- 消息级进行中：PostgreSQL 中存在 `room_messages.status = 'streaming'` 的 AI 消息。
- 房间级进行中：该房间存在上述未完成 AI 消息。
- 实时活跃：Redis 中存在在线成员或 socket 房间关系。

这三者互不替代：

- 用户离线但 AI 还在生成：消息仍是进行中。
- 用户在线但没有 AI 生成：只是实时活跃。
- 服务重启后 Redis 丢失临时 buffer：PostgreSQL 的 `streaming` 占位消息用于恢复或标记失败。

## 缓存一致性策略

第一版采用 cache-aside + 写后失效：

1. 读消息：先读 Redis 短 TTL 缓存；miss 时读 PostgreSQL 并回填。
2. 写消息/编辑/删除/清空/AI 完成：PostgreSQL 事务提交后删除相关 Redis 缓存。
3. Socket 广播发生在持久事务成功之后。
4. 如果缓存删除失败，记录 error，依赖 TTL 收敛；不回滚 PostgreSQL。

后续增强：

- 在 `rooms` 增加 `message_version`，缓存 key 带版本号，避免删除失败导致旧缓存被命中。
- 引入 transactional outbox，事务内写业务表和 outbox，后台 worker 负责 socket 发布与缓存失效。

## 分阶段实施

### 阶段 1：计划和接口拆分

范围：

- 增加本计划文档。
- 增加存储接口，把 durable store 与 realtime store 分开。
- `RedisStore` 实现两个接口，保持默认行为不变。
- socket/API 依赖接口，而不是具体 `RedisStore` 类。

验收标准：

- `npm test` 通过。
- `npm run build` 通过。
- Redis 默认模式不需要任何新环境变量。
- 所有现有用户操作链路行为不变。

### 阶段 2：PostgreSQL durable store

范围：

- 新增 PostgreSQL schema 初始化。
- 新增 `PostgresDurableStore`：
  - 房间 CRUD。
  - 消息 append/read/save/clear。
  - AI 成本 read/increment。
  - 删除房间。
- 新增 `CompositeRoomStore`：durable 方法走 PostgreSQL，realtime 方法走 Redis。
- 通过 `PERSISTENCE_STORE=postgres` 和 `DATABASE_URL` 启用。

验收标准：

- Redis 默认模式仍通过全部测试和 build。
- PostgreSQL store 单元测试覆盖：
  - room 保存/读取/删除。
  - message append/read/save/clear。
  - AI cost 累加。
  - transaction rollback 路径。
- PostgreSQL schema 初始化幂等。
- 未配置 `DATABASE_URL` 但选择 PostgreSQL 时启动失败并给出明确日志。

### 阶段 3：AI streaming 持久化边界

范围：

- 发起 AI 请求时先写入 PostgreSQL `streaming` 占位消息，再广播 `new_message`。
- stream chunk 可继续只走 socket；后续再接 Redis chunk buffer。
- stream 正常结束时事务更新为 `complete`，写入 content/usage/cost。
- stream 异常时更新为 `error`。

验收标准：

- AI 回复过程中刷新/重连，至少能看到 `streaming` 占位消息。
- AI 完成后历史只保留最终 `complete` 消息，不重复。
- retry/edit 仍按当前上下文裁剪规则工作。
- E2E fake AI 流程通过。

### 阶段 4：缓存和恢复增强

范围：

- 引入最近消息 Redis cache。
- 写后失效和 TTL。
- 可选添加 stale streaming 兜底：超过阈值的 `streaming` 标记为 `error`。

验收标准：

- 缓存 miss/hit 都返回相同消息顺序和 metadata。
- 编辑、删除、清空后不会读到旧消息。
- Redis 故障不影响 PostgreSQL durable 写入。
- stale streaming 恢复逻辑有测试。

### 阶段 5：迁移和部署

范围：

- 编写 Redis 到 PostgreSQL 的一次性迁移脚本。
- 支持 dry-run、幂等执行、迁移统计。
- 更新部署文档和环境变量说明。

验收标准：

- dry-run 不写入 PostgreSQL。
- 重复执行不会重复插入房间或消息。
- 迁移后房间数量、消息数量、成本总额一致。
- 支持先在 Redis 默认模式运行，再切换到 PostgreSQL 模式。

### 阶段 6：上线运行手册和回滚保护

范围：

- 更新 README、部署指南和 `.env.example`，明确 PostgreSQL 模式、迁移命令、缓存 TTL 和 TLS 配置。
- 增加上线 runbook，覆盖 dry-run、迁移、切换、验证、回滚和清理时机。
- 保持 Redis-only 默认路径，确保旧部署不因缺少 PostgreSQL 环境变量而中断。

验收标准：

- 文档包含生产切换命令、状态检查和回滚命令。
- 文档明确切换验证前不能清理 Redis 原始数据。
- `npm run build`、`npm test`、E2E 仍通过。

## 本轮执行范围

已完成阶段 1、阶段 2、阶段 3、阶段 4、阶段 5 和阶段 6。

## 本轮执行结果

- 阶段 1：已完成。
  - socket/API 已从具体 `RedisStore` 改为依赖 `RoomStore` 抽象。
  - Redis 默认模式保持不变。
  - `/api/status` 通过 store 统计房间数，并返回当前 `persistenceStore`。
- 阶段 2：已完成。
  - 新增 PostgreSQL schema 初始化。
  - 新增 PostgreSQL durable store，覆盖 room/message/AI cost。
  - 新增 Composite store：PostgreSQL 负责 durable 数据，Redis 负责 realtime 数据。
  - 通过 `PERSISTENCE_STORE=postgres` + `DATABASE_URL` 启用；未配置 `DATABASE_URL` 时启动失败。
- 阶段 3：已完成。
  - AI 请求开始时先保存 `streaming` 占位消息，再广播 `new_message`。
  - AI 正常完成时先保存 `complete` 终态，再广播 `ai_stream_end`。
  - AI 失败或空上下文时保存 `error` 终态。
  - 占位消息保存失败时不开始流式输出。
- 阶段 3 复审修正：已完成。
  - AI placeholder/final/error 改用 `upsertMessage`，不再用请求开始时的历史快照覆盖整个房间。
  - retry/edit 仍会在生成前显式截断历史，以保留原有用户语义。
  - Postgres 启动时会把遗留 `streaming` 消息标记为 `error`。
  - Redis 连接失败现在会中止启动，不再静默进入不可用状态。
  - Postgres SSL 默认验证证书，只有显式 `POSTGRES_SSL_REJECT_UNAUTHORIZED=false` 才关闭。
  - Redis `saveMessageHistory` 和 `upsertMessage` 改为 Lua 脚本单命令执行，避免 `DEL`/`RPUSH` 窗口丢消息。
  - retry 第一条历史消息时不再先清空房间历史。
  - API、文本 socket、图片 socket 在持久化 append 失败时不再广播未落库的消息。
  - Redis append/upsert/saveHistory 写消息前会在同一条 Lua 命令里确认房间存在并更新 `lastActivityAt`，避免缺失房间留下孤儿 message list。
  - AI 终态保存失败后的 error fallback 会重试并发出 `ai_persistence_error`，避免持久化失败被静默吞掉。
- 阶段 4：已完成。
  - Postgres 模式下 `CompositeRoomStore` 使用 Redis 作为短 TTL room message cache。
  - 缓存 miss 时读取 durable store 并回填；缓存 hit 直接返回同序消息和 metadata。
  - append/upsert/saveHistory/clear/delete 成功后失效对应 room cache。
  - startup stale streaming recovery 后会清理相关缓存；全量失效支持 `scanIterator`，不可用时降级到 `KEYS` 并记录 warning。
  - 缓存读写和失效失败不会阻塞 PostgreSQL durable 读写。
- 阶段 5：已完成。
  - 新增 Redis 到 PostgreSQL 迁移脚本：`npm run migrate:redis-to-postgres`。
  - dry-run：`REDIS_URL=... npm run migrate:redis-to-postgres -- --dry-run`，只读取 Redis，不初始化或写入 PostgreSQL。
  - 正式迁移：`REDIS_URL=... DATABASE_URL=... npm run migrate:redis-to-postgres`。
  - 迁移会逐房间保存 room、完整覆盖 message history，并用精确赋值写入 AI cost total，重复执行不会重复消息或累计成本。
  - 迁移输出统计包括 rooms/messages/costs 的读取和写入数量，以及逐房间失败列表；单房间失败不会中断后续房间。
  - 切换 PostgreSQL 模式：部署环境设置 `PERSISTENCE_STORE=postgres`、`DATABASE_URL=...`，需要 TLS 时设置 `POSTGRES_SSL=true`。
  - 可选缓存 TTL：`ROOM_MESSAGES_CACHE_TTL_SECONDS`，默认 30 秒；小于等于 0 时禁用 room message cache 写入。
- 阶段 6：已完成。
  - README / README.zh 已更新 PostgreSQL 持久化模式、迁移命令、回滚说明和当前默认模型配置。
  - DeploymentGuide / 部署指南 已增加 PostgreSQL 上线流程和环境变量。
  - `server/.env.example` 已补齐 PostgreSQL、TLS 和缓存 TTL 配置。
  - 新增 PostgreSQL rollout runbook，覆盖 dry-run、迁移、切换、验证、回滚和清理窗口。
- 验收：
  - `npm run build` 通过。
  - `npm test` 通过，86/86。
  - `npm run test:e2e` 通过，14/14。
