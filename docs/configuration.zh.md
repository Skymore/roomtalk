# RoomTalk 配置参考

[English](configuration.md)

状态：当前
更新：2026-07-22
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
| `CODE_AGENT_BACKEND` | 默认 backend；生产使用 `codex-app-server`。 |
| `CODE_AGENT_DAEMON_COMMAND` | 可选 daemon command override。 |

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

不要继续为已废弃 Codex CLI 路径增加产品能力。`codex-app-server` 是受支持 backend。

## Assistant Queue、Worker 与 Observability

App 与 `ai-worker` 使用同一镜像、不同进程。App 只提交业务事务与 dispatch intent，再 relay 到 BullMQ；只有 `ai-worker` 会调用普通 Chat AI Provider。Queue payload 只有版本号与 `runId`，prompt、terminal output、usage 和业务状态留在 PostgreSQL。

| 变量 | 用途 |
| --- | --- |
| `ASSISTANT_RUN_QUEUE_NAME` | 可选 BullMQ namespace；所有 App/Worker 必须一致。 |
| `ASSISTANT_RUN_DISPATCH_POLL_INTERVAL_MS` | PostgreSQL dispatch relay 轮询间隔，默认 `1000`。 |
| `ASSISTANT_RUN_DISPATCH_RETRY_DELAY_MS` | Redis enqueue 失败后的重试延迟，默认 `5000`。 |
| `ASSISTANT_RUN_DISPATCH_LOCK_MS` | 带 fence 的 dispatch claim 时长，默认 `60000`。 |
| `ASSISTANT_RUN_DISPATCH_BATCH_SIZE` | 每 tick 最大 relay 数，默认 `20`。 |
| `ASSISTANT_RUN_WORKER_CONCURRENCY` | 单个 Worker 进程并发 job 数，默认 `2`。 |
| `ASSISTANT_RUN_WORKER_LEASE_MS` | Provider 执行期间续租的 PostgreSQL run owner lease，默认 `60000`。 |
| `ASSISTANT_RUN_WORKER_MAX_ATTEMPTS` | `assistant_runs` 记录的 domain claim 上限，默认 `10`。 |
| `ASSISTANT_RUN_QUEUE_ATTEMPTS` | BullMQ infrastructure attempt 上限，默认 `12`。 |
| `ASSISTANT_RUN_QUEUE_BACKOFF_MS` | BullMQ 指数退避基准，默认 `5000`。 |
| `ASSISTANT_RUN_QUEUE_LOCK_MS` | BullMQ active job lock，默认 `60000`。 |
| `ASSISTANT_RUN_QUEUE_*_RETENTION_*` | 可选 completed/failed job 的 age/count 运维保留上限。 |
| `AI_WORKER_HEALTH_PORT` | Worker 专用 health endpoint；Compose 使用 `3013`。 |

Queue Redis 在 PostgreSQL 接受请求后不可用时，dispatch row 会保持 pending，relay 恢复后继续投递；App 会报告 `degraded` 与 deferred dispatch，而不是丢请求。BullMQ retry 用于基础设施中断；已经持久化的 Provider error 是业务终态，不会无限重试。`LOG_FILE_ENABLED` 控制可选文件日志，生产日志必须结构化且不包含 secret。

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
- `local-production.mjs` 会在 detached startup 后自动验证六个生产服务并报告宿主/Docker 磁盘占用。`ROOMTALK_MIN_HOST_FREE_GB`、`ROOMTALK_DOCKER_RAW_WARN_GB`、`ROOMTALK_DOCKER_RAW_PATH` 与 `ROOMTALK_PUBLIC_STATUS_URL` 用于调整这项本地 operator 检查。
- 旧 Fly GitHub Actions workflow 已手工禁用，只保留为回滚历史，不再拥有当前部署。
