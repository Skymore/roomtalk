# RoomTalk 配置参考

[English](configuration.md)

状态：当前
更新：2026-07-30
事实源：`server/.env.example`、`.env.compose.example`、`compose.yaml`、runtime config loader 和 `scripts/local-production.mjs`

本文只整理 operator-facing 配置。Test-only 变量和每轮注入 sandbox 的 `ROOMTALK_*` 变量刻意不列入。

## HTTP 与浏览器 Origin

| 变量 | 用途 | 说明 |
| --- | --- | --- |
| `PORT` | Server 监听端口 | 默认/本地为 `3012`。 |
| `NODE_ENV` | Runtime 模式 | Production 启用 fail-closed origin 和 artifact 检查。 |
| `CLIENT_URL` | 主浏览器 origin | 也用于部分公开 callback 默认值。 |
| `CLIENT_URLS` | 逗号分隔的 browser-origin allowlist | 用于同时接受多个 origin 的部署。 |

客户端是 Vite 应用。只有可安全公开的值才能使用 `VITE_*` 前缀。

## 存储

| 变量 | 用途 |
| --- | --- |
| `REDIS_URL` | Realtime/cache、Socket.IO 与 Worker transient event 使用的 Redis。 |
| `QUEUE_REDIS_URL` | BullMQ 连接；默认回退 `REDIS_URL`，以后可只改配置迁到独立 Redis。 |
| `PERSISTENCE_STORE` | 必须为 `postgres`；其他值会启动失败。 |
| `DATABASE_URL` | 必需的 PostgreSQL durable-store URL。 |
| `MIGRATION_DATABASE_URL` | 仅供 `migrate:schema` 使用的可选 owner/DDL URL；本地 Compose 默认回退 `DATABASE_URL`。 |
| `POSTGRES_SSL` | 启用 PostgreSQL TLS。 |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | 默认保持证书校验。 |
| `POSTGRES_SSL_CA_BASE64` / `POSTGRES_SSL_CA` | 可选托管服务 CA；secret manager 中优先 base64。 |
| `ROOM_MESSAGES_CACHE_TTL_SECONDS` | PostgreSQL 模式下 Redis 最近消息 cache TTL；`0` 禁用写入。 |
| `ROOM_MESSAGES_CACHE_MAX_BYTES` | 序列化 cache payload 上限。 |
| `ROOM_EVENT_RETENTION_DAYS` | 每房间有界重放日志的保留天数，默认 `7`。 |
| `ROOM_EVENT_MAX_PER_ROOM` | 每个房间最多保留的事件数，默认 `10000`。 |
| `ROOM_EVENT_PRUNE_INTERVAL_MS` | Event prefix 清理间隔，默认 `3600000`（一小时）。 |
| `ROOM_EVENT_FAST_PATH_MAX_BYTES` | Socket 通知携带已提交 RoomEvent 的最大序列化字节，默认 `262144`；超限退化为只带 `headSeq` 的 hint。 |

唯一受支持的 serving model 是 PostgreSQL 业务状态 + Redis realtime/调度。`assistant_runs` 的业务生命周期和结果只以 PostgreSQL 为准。Realtime/cache key 可以重建，但 active BullMQ job 是需要 AOF `everysec` 与 `noeviction` 保护的运行状态；任务运行时不能随意 flush queue Redis。旧 Redis durable store 只保留给 import 与 contract coverage。

`room_event_streams` 与 `room_events` 是客户端同步边界。规范 mutation 与安全的 `schemaVersion: 1` after-image 同事务提交。`NOTIFY` 只是 hint：每个 app 读取精确不可变事件后以 `io.local` 发送；客户端只直接应用连续 fast path，否则从 `lastAppliedSeq` 补拉。保留窗口内落后超过 500 个事件会切 repeatable-read snapshot，`CURSOR_AHEAD` 会清除旧水位但保留请求期间的新通知。Event log 有界，不是完整 Event Sourcing，也不是 AI queue。普通 Chat AI 会把 placeholder、`assistant_runs` 与 `task_dispatch_outbox` 同事务提交，再由 BullMQ 调度一个 Worker；临时 Socket event 不消耗 room seq。

生产已于 2026-07-21 在所有旧 app 停止的维护窗口执行不可变事件 migration `0003` 和 `0004`。

## 媒体与 Artifact

| 变量 | 用途 |
| --- | --- |
| `MEDIA_STORAGE_MODE` | 显式存储模式。当前生产 Compose、保留的 Fly 回滚目标与 AWS 都使用 `s3`；`local` 只作为文件系统开发/恢复 fallback。显式 `s3` 未配置 bucket 时启动失败。 |
| `MEDIA_BUCKET_NAME` | S3-compatible bucket。 |
| `MEDIA_STORAGE_REGION` | 存储 region；当前 SeaweedFS 使用 `us-east-1`，Tigris 通常为 `auto`。 |
| `MEDIA_STORAGE_ENDPOINT` | S3-compatible endpoint。 |
| `MEDIA_STORAGE_PUBLIC_ENDPOINT` | 可选的浏览器侧 S3 endpoint，只用于生成 presigned URL；服务端对象操作继续使用 `MEDIA_STORAGE_ENDPOINT`。 |
| `MEDIA_STORAGE_FORCE_PATH_STYLE` | 可选 path-style addressing。 |
| `MEDIA_STORAGE_CONNECTION_TIMEOUT_MS` | 对象存储连接超时，默认 `3000`。 |
| `MEDIA_STORAGE_REQUEST_TIMEOUT_MS` | 对象存储单次请求超时，默认 `15000`。 |
| `MEDIA_STORAGE_SOCKET_TIMEOUT_MS` | 对象存储 socket 空闲超时，默认 `10000`。 |
| `MEDIA_STORAGE_MAX_ATTEMPTS` | 对象存储最大尝试次数（包含首次请求），默认 `2`。 |
| `MEDIA_STORAGE_SLOW_REQUEST_MS` | 超过该耗时的对象存储操作会记录慢请求日志，默认 `2000`。 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 存储凭据。 |
| `LOCAL_MEDIA_DIR` | 显式 local / 开发 fallback 的文件系统根目录。 |
| `LOCAL_MEDIA_SIGNING_SECRET` | 本地媒体过期 URL 的可选独立 HMAC key；生产 local 模式未设置时可从至少 16 字符的 `POSTGRES_PASSWORD` 派生。 |
| `DISABLE_LOCAL_MEDIA_STORAGE` | 禁用隐式开发 fallback；不能与显式 `local` 同时使用。 |
| `CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL` | 静态发布公开 base fallback。 |
| `CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET` | 签名 room/client/turn/mode-scoped publish token。 |
| `CODE_AGENT_STATIC_PUBLISH_TOKEN_TTL_SECONDS` | Publish token 生命期。 |

私有媒体和发布的 static site 共用 object-storage abstraction，但授权和 object layout 独立。当前生产 Compose 把 `s3` 指向 bundled SeaweedFS 并启用 path-style addressing；保留的 Fly 回滚目标指向 Tigris，AWS 映射到 S3。

## Chat AI 与可选服务

| 分组 | 变量 |
| --- | --- |
| Model 与 context | `AI_MODEL`, `AI_MAX_CONTEXT_MESSAGES`, `AI_MAX_CONTEXT_TOKENS` |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_NAME` |
| DeepSeek | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MAX_TOKENS` |
| OpenAI-compatible | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| 转写 | `ASSEMBLYAI_API_KEY` |
| Google 登录 | `GOOGLE_CLIENT_ID`，可选 `GOOGLE_CLIENT_IDS` |
| Web Push | `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` |

Provider key 保留在服务端，不会发给浏览器，也不会整体复制到 sandbox。

## Code Agent Runtime

核心选择：

| 变量 | 用途 |
| --- | --- |
| `CODE_AGENT_ENABLED` | 启用 Code Agent 产品入口。 |
| `CODE_AGENT_ALLOWED_USER_IDS` | 可选 rollout allowlist。 |
| `CODE_AGENT_ALLOWED_RUN_MODES` / `CODE_AGENT_DEFAULT_MODE` | 可用和默认 Plan/Ask/Auto/Full 模式。 |
| `CODE_AGENT_SANDBOX_PROVIDER` | 生产使用 `e2b`。 |
| `CODE_AGENT_RUNNER_CLIENT` | 生产使用可复用 `daemon`。 |
| `CODE_AGENT_BACKEND` | 默认 backend。支持 `code-agent`、`codex-app-server`、`opencode`、`hermes-agent`；已废弃的 `codex` CLI 仍单独受 gate 约束。 |
| `CODE_AGENT_DAEMON_COMMAND` | 可选 daemon command override。 |
| `CODE_AGENT_RUNNER_COMMAND` | 当前默认 backend 的可选 runner override。 |
| `CODE_AGENT_ENGINE_RUNNER_COMMAND` / `CODEX_APP_SERVER_RUNNER_COMMAND` | Coco 与 Codex app-server 的可选 runner override。 |
| `OPENCODE_RUNNER_COMMAND` / `HERMES_AGENT_RUNNER_COMMAND` | OpenCode 与 Hermes Agent ACP runner 的可选 override。 |

固定 artifact 与 E2B：

| 变量 | 用途 |
| --- | --- |
| `E2B_API_KEY` / `E2B_ACCESS_TOKEN` | E2B credential。 |
| `E2B_TEAM_ID` | 可选 E2B team。 |
| `CODE_AGENT_E2B_TEMPLATE_ID` | 固定生产 template。 |
| `CODE_AGENT_ARTIFACT_VERSION` | 预期 artifact version。 |
| `CODE_AGENT_SOURCE_REF` | 预期 code-agent-engine source ref。 |
| `CODE_AGENT_ARTIFACT_MODE` | 固定 production 或显式 development mode。 |
| `CODE_AGENT_E2B_AUTO_RESUME` / `CODE_AGENT_E2B_ON_TIMEOUT` | Pause/resume lifecycle。 |
| `CODE_AGENT_IDLE_SANDBOX_TTL_MS` / `CODE_AGENT_ACTIVE_SANDBOX_TTL_MS` | Idle 与 running-turn sandbox TTL。 |
| `CODE_AGENT_TURN_MAX_MS` | 单个 active turn 的应用层硬截止时间；默认跟随 active sandbox TTL，并始终被限制在该 TTL 之前。 |
| `CODE_AGENT_TURN_DEADLINE_SAFETY_MS` | active sandbox TTL 前预留的安全余量，使 RoomTalk 能先持久化 `turn_timeout`，而不是等待 E2B 终止 sandbox；默认 30 秒。 |
| `CODE_AGENT_SANDBOX_TTL_MS` | Idle TTL 的 legacy fallback。 |

Scoped capability：

| 变量组 | 用途 |
| --- | --- |
| `CODE_AGENT_MODEL_GATEWAY_*` | Turn-scoped model proxy、body limit、budget 和签名。 |
| `CODE_AGENT_ROOM_CONTEXT_*` | 只读 room history/search token 和生命期。 |
| `CODE_AGENT_WORKSPACE_ASSET_*` | 签名 workspace asset access。 |
| `CODE_AGENT_STATIC_PUBLISH_*` | Scoped durable static publishing。 |

## 用户自有 Codex 与 GitHub Connection

| 变量 | 用途 |
| --- | --- |
| `CODEX_CONNECTIONS_ENABLED` | 启用 Codex subscription connection route。 |
| `CODEX_AUTH_ENCRYPTION_KEY` | 加密存储的 Codex auth。 |
| `CODEX_AUTH_LOGIN_TIMEOUT_MS` | Device-auth session timeout。 |
| `CODEX_AUTH_REFRESH_LOCK_TTL_MS` / `CODEX_AUTH_REFRESH_WAIT_MS` | Refresh 串行化。 |
| `GITHUB_CONNECTIONS_ENABLED` | 启用 GitHub PAT connection route。 |
| `GITHUB_AUTH_ENCRYPTION_KEY` | 加密 GitHub token，可独立轮换。 |

不要继续为已废弃 Codex CLI 路径增加产品能力。Codex 产品能力使用
`codex-app-server`；OpenCode 与 Hermes Agent 使用共用 ACP adapter。Room 可以选择任一已启用
backend，而 room authorization、turn fencing、approval、persistence 与 model gateway 的所有权
仍然留在 RoomTalk。

## Assistant Queue、Worker 与 Observability

App 与 `ai-worker` 使用同一镜像、不同进程。App 只提交业务事务与 dispatch intent，再 relay 到 BullMQ；只有 `ai-worker` 会调用普通 Chat AI Provider。Queue payload 只有版本号与 `runId`，prompt、terminal output、usage 和业务状态留在 PostgreSQL。

| 变量 | 用途 |
| --- | --- |
| `ASSISTANT_RUN_QUEUE_NAME` | 可选 BullMQ namespace；所有 App/Worker 必须一致。 |
| `ASSISTANT_RUN_DISPATCH_POLL_INTERVAL_MS` | PostgreSQL dispatch relay 轮询间隔，默认 `1000`。 |
| `ASSISTANT_RUN_DISPATCH_RETRY_DELAY_MS` | Redis enqueue 失败后的重试延迟，默认 `5000`。 |
| `ASSISTANT_RUN_DISPATCH_LOCK_MS` | 带 fence 的 dispatch claim 时长，默认 `60000`。 |
| `ASSISTANT_RUN_DISPATCH_BATCH_SIZE` | 每 tick 最大 relay 数，默认 `20`。 |
| `ASSISTANT_RUN_RECONCILE_INTERVAL_MS` | PostgreSQL active run 与 BullMQ 对账间隔，默认 `30000`。 |
| `ASSISTANT_RUN_RECONCILE_GRACE_MS` | 已确认 dispatch 至少经过多久才检查 missing/failed job，默认 `30000`。 |
| `ASSISTANT_RUN_RECONCILE_BATCH_SIZE` | 每轮检查的 active dispatch 数，默认 `200`；满批次使用轮转 cursor。 |
| `ASSISTANT_RUN_WORKER_CONCURRENCY` | 单个 Worker 进程并发 job 数，默认 `2`。 |
| `ASSISTANT_PROVIDER_LIMITS_JSON` | 可选的 provider 级请求准入限制；普通 Chat Worker 与 Code Agent model gateway 通过 queue Redis 共享。例如 `{"openai":{"requestsPerSecond":8,"maxConcurrent":3},"anthropic":{"maxConcurrent":2}}`。未知 provider、无效值或非正整数会让进程启动失败。等待请求按账号服务优先级准入，同优先级保持 FIFO。 |
| `ASSISTANT_RUN_WORKER_LEASE_MS` | Provider 执行期间续租的 PostgreSQL run owner lease，默认 `60000`。 |
| `ASSISTANT_RUN_WORKER_MAX_ATTEMPTS` | `assistant_runs` 记录的 domain claim 上限，默认 `10`。 |
| `ASSISTANT_RUN_WORKER_HEARTBEAT_INTERVAL_MS` | AI Worker 向 queue Redis 写心跳的间隔，默认 `5000`。 |
| `ASSISTANT_RUN_WORKER_HEARTBEAT_TTL_MS` | `/api/status` 使用的“至少一个 Worker 存活”TTL，默认 `20000`。 |
| `ASSISTANT_RUN_QUEUE_ATTEMPTS` | BullMQ infrastructure attempt 上限，默认 `12`。 |
| `ASSISTANT_RUN_QUEUE_BACKOFF_MS` | BullMQ 指数退避基准，默认 `5000`。 |
| `ASSISTANT_RUN_QUEUE_LOCK_MS` | BullMQ active job lock，默认 `60000`。 |
| `ASSISTANT_RUN_QUEUE_*_RETENTION_*` | 可选 completed/failed job 的 age/count 运维保留上限。 |

App 侧 reconciler 是有界修复循环，不是第二个 scheduler。它先取得 PostgreSQL advisory lock，只读取仍未终态且 dispatch 已确认的 run：BullMQ job 缺失时按同一 `runId` 补建，failed 或业务尚未终态却提前 completed 时重新放回 waiting；waiting、delayed 与 active job 一律不动。这样 PostgreSQL 恢复到空队列后可以自动重建未完成任务，infrastructure attempts 耗尽也不会让消息永久卡住。
| `AI_WORKER_HEALTH_PORT` | Worker 专用 health endpoint；Compose 使用 `3013`。 |

Queue Redis 在 PostgreSQL 接受请求后不可用时，dispatch row 会保持 pending，relay 恢复后继续投递；App 会报告 `degraded` 与 deferred dispatch，而不是丢请求。BullMQ retry 用于基础设施中断；已经持久化的 Provider error 是业务终态，不会无限重试。`LOG_FILE_ENABLED` 控制可选文件日志，生产日志必须结构化且不包含 secret。

## 账号、会员与额度

密码登录和 Google 登录现在都归属同一个持久化 `accounts` principal。匿名 client ID 仍是访客；设置密码会把该 client 升级成账号，之后绑定 Google 只会给同一账号增加一种登录 identity，不会新建或替换账号。

| 变量 | 用途 |
| --- | --- |
| `CLIENT_AUTH_TOKEN_TTL_DAYS` | 新签发密码/Google 账号会话的有效天数；默认 `30`，范围 `1`–`365`。迁移时会给旧的无限期账号会话补上 30 天过期时间。 |
| `CLIENT_AUTH_LOGIN_WINDOW_SECONDS` | Redis 共享登录尝试窗口；默认 `900`。 |
| `CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT_IP` | 同一 User ID/IP 每窗口允许的尝试数；默认 `10`。 |
| `CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT` | 同一 User ID 跨 IP 每窗口允许的尝试数；默认 `30`。 |
| `CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_IP` | 同一 IP 跨 User ID 每窗口允许的密码尝试数；默认 `100`。 |
| `ACCOUNT_AI_USAGE_SETTLEMENT_INTERVAL_MS` | Code Agent usage 因 PostgreSQL 暂时不可用而进入 Redis 持久恢复队列后的重试间隔；默认 `5000`。 |
| `ACCOUNT_AI_USAGE_SETTLEMENT_BATCH_SIZE` | 每轮最多重试的延迟 usage 结算数；默认 `100`。 |
| `PLATFORM_ADMIN_EMAILS` | 可选的逗号分隔管理员自举白名单。匹配账号必须在数据库中拥有 `email_verified=true` 的 Google identity；最终 `admin` 角色和授权审计事件持久化到 PostgreSQL。生产值只能通过部署 secret 注入。 |

密码账号创建、密码轮换、旧会话撤销和新会话签发在同一事务内提交。账号会话有过期时间，并通过数据库外键绑定账号。认证存储异常统一返回 `503`，不会退化为匿名授权；Redis 尝试额度耗尽时，会在执行昂贵的密码校验前返回 `429` 和 `Retry-After`。

已认证账号可以调用 `DELETE /api/auth/google` 断开 Google 登录 identity，但必须先设置 User ID 密码，防止用户把自己锁在账号外。断开只删除 Google identity 与对应资料字段，不会删除账号、当前 App 会话、房间、会员、额度、用量历史或已持久化角色；同一事务还会写入不可变的 `account_identity_events` 审计记录。因此平台管理员断开 Google 后仍保留数据库中的 `admin` 角色，但在重新绑定前不能再通过 Google 登录。

平台管理员权限是 `account_roles` 中的持久数据库状态，不再存在部署级会员 Bearer secret。`PLATFORM_ADMIN_EMAILS` 只声明哪些已验证 Google identity 可以自举该数据库角色：匹配账号首次发起已认证账号请求时，会在同一事务中写入 `admin` 角色与不可变授权审计事件。只知道或声称拥有某个邮箱不能获得权限。`PUT /api/admin/accounts/:accountId/membership` 必须通过 `X-Client-Id` 和 `X-Client-Auth-Token` 提供未过期账号会话，服务端再从 PostgreSQL 检查已持久化的 `admin` 角色。

只配置一个邮箱时，也可以在用户下次登录前从生产 App 容器预先落库，不需要把邮箱写进命令行：

```bash
node scripts/local-production.mjs --profile edge exec -T app \
  node dist/src/scripts/setPlatformAdmin.js --grant
```

撤销时使用 `--revoke`；也可用 `--email` 或 `--client-id` 明确选择操作对象。把邮箱从 `PLATFORM_ADMIN_EMAILS` 删除不会暗中撤销已经落库的角色。命令会拒绝撤销最后一个管理员。角色变更与会员变更都会保留不可变数据库审计事件。普通访客功能仍允许不登录使用，但匿名身份永远无法通过管理员边界。

会员管理请求可设置 `free`、`pro`、`priority`，以及 `active`、`past_due`、`cancelled` 状态，还可携带账期、外部订阅信息和有界 `priorityOverride`；非 active 的付费会员按 Free 服务等级调度。每次变更都必须提供 `Idempotency-Key`；会员状态、可选正数 `creditGrantUsd`、credit ledger、不可变会员审计事件和操作管理员账号身份在同一事务提交，确保支付 webhook 重试不会部分生效或重复发放额度。

| 服务等级 | 额度可用 | 额度耗尽 |
| --- | ---: | ---: |
| 管理员（无限额度） | `1` | `1` |
| Priority | `1` | `10` |
| Pro | `20` | `40` |
| Free | `60` | `80` |
| Guest | `100` | `100` |

匿名访客没有账号额度，始终使用 Guest 服务等级。已登录且有效会员等级为 Free 的账号，每个 UTC 自然月获得不可结转的 `$5` 额度。PostgreSQL 会把“本月已赠送/本月剩余”与人工或付费额度分开记录：新月份第一次读取 entitlement 或发起 AI 请求时，只过期未用完的月度部分，写入不可变的 expiration/grant ledger，并在行锁保护下只发放一次新 `$5`；人工充值和付费额度不会被月度 rollover 清除。

持久化 `admin` 角色的账号始终映射到 Priority 服务等级和队列优先级 `1`，并显示无限额度。管理员的 AI 消耗仍会累计 lifetime usage、房间成本和 provider 成本，但账号额度扣减始终为 `$0`。从配置中删除管理员自举邮箱不会改变这项权益，因为角色会一直保存在数据库中，直到被明确撤销。

在账号级 usage 结算上线前已经存在的账号，可以从持久化 assistant run 和 Code Agent observability 记录回填历史累计用量。`npm run backfill:lifetime-ai-usage` 默认只做 dry-run；确认计划后用 `npm run backfill:lifetime-ai-usage -- --execute` 执行。脚本会写入确定性、不可变的 usage 记录，再按账本总额重算 `lifetime_usage_usd`，不会追扣当前额度；重复执行是安全的，并会返回 already-current。

普通 Chat AI 任务在 PostgreSQL 创建时会固化账号、有效会员级别、额度状态和 BullMQ priority；Code Agent model gateway 在准入时解析同一服务等级。数字越小，越先通过持久队列和共享 provider admission 队列。普通 Chat 任务等待 Provider 容量时会退回 BullMQ delayed 状态，不占用 Worker processor；稳定的 admission waiter 会在重试之间保留原有优先级与同级 FIFO 位置。额度用完不会拒绝请求，而是降到该会员级别的 depleted service class。普通 Chat 的 Provider 成本、用户可见消息、房间成本、账号 usage event、额度扣减和 run 终态在同一 PostgreSQL 事务内结算；Code Agent gateway 使用幂等账号 usage event，并扣同一余额、累计同一 lifetime usage。其 usage 会先写入 Redis 恢复队列，因此 Provider 返回后即使 PostgreSQL 短暂故障，也会继续重试结算而不是静默漏扣。当前 provider admission 控制每秒请求数和并发请求数；精确 token/s 仍需要 token reservation 与流式计量。

## PostgreSQL Schema 生命周期

- `npm run migrate:schema` 是唯一受支持的 schema writer；容器内编译命令是 `npm run migrate:schema:compiled`。
- Compose 在 `app` 与 `ai-worker` 前运行一次性 `migrate` service；Kubernetes/AWS 应映射为 pre-deploy Job，而不是让每个进程启动时改表。
- `schema_migrations` 为每个 immutable migration 保存 SHA-256 checksum；缺失或改写都会让部署失败。
- `POSTGRES_SCHEMA_SQL` 冻结为 `0000` bootstrap；以后只能新增 `POSTGRES_MIGRATIONS`，不能编辑已应用项。
- App 启动只执行只读 `verifySchema()`；漏跑 migration job 时拒绝 readiness。

## 生产配置规则

- 生产 Mac 把应用环境作为 JSON object 存入 macOS Keychain item `roomtalk-production-env`；`scripts/local-production.mjs` 只在 Compose 调用期间生成 mode `0600` 的临时 env file，结束后立即删除。
- 非 secret Compose interpolation 放在 ignored `.env.compose`；真实 PostgreSQL、S3、provider、OAuth、E2B、Codex 与 GitHub credential 都不能提交。
- `server/.env` 保持 ignored 且只在本地使用。
- 生产 E2B 必须同时对齐 template、artifact version、source ref、runner dependency 和 smoke 证据。
- 应用或配置变更通过 `node scripts/local-production.mjs --profile edge up -d --build` 生效。该命令先运行 migration job，再替换 App 与 Worker；随后验证 Compose health、Worker health、loopback 与公网 `/api/status`。
- `/api/health/live` 只用于进程 liveness；`/api/health/ready` 与 `/api/status` 会验证 PostgreSQL schema、realtime Redis、对象存储和 Socket adapter。Serving dependency 不可用时返回 `503` 与 `rooms: null`；只有 queue 不可用时，App 仍 ready 但状态为 `degraded`，因为 PostgreSQL 能安全延迟 dispatch。
- 主 `ruit.me` Tunnel 使用 ignored `CLOUDFLARE_TUNNEL_CONFIG_FILE` 与 `CLOUDFLARE_TUNNEL_CREDENTIALS_FILE` 路径。单独管理的 `ai-chat.wenlin.dev` Tunnel 从 Keychain 环境读取 `CLOUDFLARE_WENLIN_TUNNEL_TOKEN`；不得提交或打印该 token。
- `local-production.mjs` 会在 detached startup 后自动验证七个生产服务并报告宿主/Docker 磁盘占用。`ROOMTALK_MIN_HOST_FREE_GB`、`ROOMTALK_DOCKER_RAW_WARN_GB`、`ROOMTALK_DOCKER_RAW_PATH`、`ROOMTALK_PUBLIC_STATUS_URL` 与 `ROOMTALK_WENLIN_PUBLIC_STATUS_URL` 用于调整这项本地 operator 检查。
- 旧 Fly GitHub Actions workflow 已手工禁用，只保留为回滚历史，不再拥有当前部署。
