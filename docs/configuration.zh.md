# RoomTalk 配置参考

[English](configuration.md)

状态：当前
更新：2026-07-12
事实源：`server/.env.example`、runtime config loader、`fly.toml` 和 `.github/workflows/fly-deploy.yml`

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
| `REDIS_URL` | 实时状态必需 Redis；Redis 模式下也是 durable store。 |
| `PERSISTENCE_STORE` | `redis`（`R`）或 `postgres`（`R+P`）。 |
| `DATABASE_URL` | `PERSISTENCE_STORE=postgres` 时必需。 |
| `POSTGRES_SSL` | 启用 PostgreSQL TLS。 |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | 默认保持证书校验。 |
| `POSTGRES_SSL_CA_BASE64` / `POSTGRES_SSL_CA` | 可选托管服务 CA；secret manager 中优先 base64。 |
| `ROOM_MESSAGES_CACHE_TTL_SECONDS` | PostgreSQL 模式下 Redis 最近消息 cache TTL；`0` 禁用写入。 |
| `ROOM_MESSAGES_CACHE_MAX_BYTES` | 序列化 cache payload 上限。 |

支持的模型：

- `PERSISTENCE_STORE=redis`：Redis 拥有 durable 和 realtime state（`R`）。
- `PERSISTENCE_STORE=postgres`：PostgreSQL 拥有 durable fact，Redis 拥有 realtime coordination 和有界 cache state（`R+P`）。
- 不支持纯 PostgreSQL。

## 媒体与 Artifact

| 变量 | 用途 |
| --- | --- |
| `MEDIA_BUCKET_NAME` | S3/Tigris bucket。 |
| `MEDIA_STORAGE_REGION` | 存储 region；Tigris 通常为 `auto`。 |
| `MEDIA_STORAGE_ENDPOINT` | S3-compatible endpoint。 |
| `MEDIA_STORAGE_FORCE_PATH_STYLE` | 可选 path-style addressing。 |
| `MEDIA_STORAGE_CONNECTION_TIMEOUT_MS` | 对象存储连接超时，默认 `3000`。 |
| `MEDIA_STORAGE_REQUEST_TIMEOUT_MS` | 对象存储单次请求超时，默认 `15000`。 |
| `MEDIA_STORAGE_SOCKET_TIMEOUT_MS` | 对象存储 socket 空闲超时，默认 `10000`。 |
| `MEDIA_STORAGE_MAX_ATTEMPTS` | 对象存储最大尝试次数（包含首次请求），默认 `2`。 |
| `MEDIA_STORAGE_SLOW_REQUEST_MS` | 超过该耗时的对象存储操作会记录慢请求日志，默认 `2000`。 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 存储凭据。 |
| `LOCAL_MEDIA_DIR` | 本地开发媒体目录。 |
| `DISABLE_LOCAL_MEDIA_STORAGE` | 禁用开发环境 fallback。 |
| `CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL` | 静态发布公开 base fallback。 |
| `CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET` | 签名 room/client/turn/mode-scoped publish token。 |
| `CODE_AGENT_STATIC_PUBLISH_TOKEN_TTL_SECONDS` | Publish token 生命期。 |

私有媒体和发布的 static site 共用 object-storage abstraction，但授权和 object layout 独立。

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

## Worker 与 Observability

`OUTBOX_WORKER_ENABLED` 选择 durable AI-run outbox 路径。Batch size、poll interval、lock duration、retry delay 和 maximum attempts 由对应 `OUTBOX_WORKER_*` 变量控制。`LOG_FILE_ENABLED` 控制可选文件日志；生产日志应保持结构化且不含 secret。

## 生产配置规则

- Secret 存入 Fly/GitHub/provider secret manager，不写入 `fly.toml` 或 tracked file。
- `server/.env` 保持 ignored 且只在本地使用。
- 生产 E2B 必须同时对齐 template、artifact version、source ref、runner dependency 和 smoke 证据。
- 修改 Fly secret 会重启或滚动机器；之后验证 `/api/status`。
- 定时或手动 dispatch 的 GitHub Actions workflow 拥有应用部署。不要手动执行 `fly deploy`。
