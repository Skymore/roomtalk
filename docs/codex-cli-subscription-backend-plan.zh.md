# Codex CLI Subscription Backend 分阶段实施计划

[English](codex-cli-subscription-backend-plan.md)

Reviewed: 2026-07-12

> 状态：路线已收敛为实现路线 1：同一个 Code Agent engine / E2B template 内并行 `code_agent_cli` 与 `codex_cli`。独立 Codex worker artifact 及早期 POC/smoke 脚本已从本分支清理。Phase 5/6 的本地实现已完成：template 双 CLI skeleton、`codex_cli` wrapper、artifact metadata、context 校验、server-side Codex auth 注入和 refreshed auth 回写链路都已接上；本地 Docker build 和真实 Codex subscription smoke 已通过，真实 E2B template build/smoke 待本机 E2B 登录、临时 `E2B_API_KEY`，或 CI/生产侧凭据环境。
> 日期：2026-07-04
> 分支：`codex/codex-cli-integration-plan`
> 范围：第一批只接 Codex CLI，走用户自己的 ChatGPT/Codex 订阅登录态；不接 Claude Code / Qoder / ZCode。

## 目标形态

```text
RoomTalk app server
  -> Code Agent engine / E2B sandbox runtime
       -> code_agent_cli backend
       -> codex_cli backend
```

关键决策：

- 保留 RoomTalk 里的 `codeAgent` 房间类型、UI 名称、消息结构和 `CodeAgentRunnerEvent` 协议。
- `code_agent_cli` 和 `codex_cli` 是同一个 Code Agent engine template 里的并行 backend，不再做独立 Codex worker template。
- Codex 登录走 `codex login --device-auth`，前端只展示 OpenAI device URL 和一次性 code。
- 后端把 Codex CLI 写出的 `auth.json` 当 opaque secret 加密持久化。
- Codex task 运行时，RoomTalk 把用户的 encrypted `auth.json` 注入 Code Agent engine 内的 `codex_cli` 私有运行目录；任务结束后取回 refreshed `auth.json` 并重新加密保存。
- 不支持 Business / Enterprise access token。
- 不支持 OpenAI Platform API key billing path；`CODEX_API_KEY` / `OPENAI_API_KEY` 不允许成为 Codex subscription backend 的认证方式。

## 当前完成情况

### Phase 0: POC

已完成：

- 本机一次性验证 Codex CLI device auth、subscription `auth.json` 恢复、`codex exec --json` 输出形态。
- 验证结果已沉淀到正式 service、mapper、runner 单测；早期 POC 脚本不再保留。

验证结论：

- `codex login --device-auth` 可以在隔离 `CODEX_HOME` 下产出 OpenAI device URL/code。
- 非 TTY `spawn('codex', ['login', '--device-auth'])` 只打印 code 后退出，不会等待授权，也不会写 `auth.json`；真实 driver 需要 PTY。
- 已登录的 Codex subscription `auth.json` 可作为 opaque blob 加密、恢复，并跑通 `codex exec --json`。
- Codex stdout JSONL 可映射成现有 `CodeAgentRunnerEvent`。
- stdout JSONL 和 stderr diagnostics 必须严格分流；stderr 只进 diagnostics tail，不进入消息流。

### Phase 1: Codex connection store/service

已完成：

- `server/src/services/codexConnection.ts`
- `server/src/services/codexConnectionStore.ts`
- `server/src/services/codexConnectionConfig.ts`
- 对应单测
- Postgres / Redis connection store
- `codex_connections` Postgres schema

能力：

- 加密保存 opaque `auth.json`。
- 查询公开连接状态，不泄漏 token/auth JSON。
- disconnect 清除连接。
- `withCodexAuth(clientId, runId, fn)` 在运行期间加锁，向运行逻辑提供 decrypted auth，并保存 refreshed auth。
- Codex child env 会剥离 API key / token / secret 类环境变量。

### Phase 2: Connection API/UI

已完成：

- `GET /api/codex/connection`
- `POST /api/codex/connection/device-auth`
- `DELETE /api/codex/connection/device-auth`
- `DELETE /api/codex/connection`
- `CodexCliDeviceAuthDriver`：通过 PTY 跑 `codex login --device-auth`
- `CodexDeviceAuthSessionManager`：后台等待授权，前端先拿 URL/code
- Settings 页 Codex connection UI
- feature flag：`codex.connections.enabled`
- fake Codex CLI route tests
- browser fake CLI E2E

本阶段可独立部署：

- 默认 `CODEX_CONNECTIONS_ENABLED=false`，UI 不显示，routes 不暴露。
- 打开 `CODEX_CONNECTIONS_ENABLED=true` 后，只启用“连接 Codex 账号”，不会启用 Codex task execution。

额外修复：

- Server CORS allow methods 补上 `DELETE`，否则浏览器 cancel/disconnect 会被 preflight 拦截。
- Settings 页 Codex section 移除自身底部分割线，避免和 Notifications section 顶部分割线形成双分割线。

### Phase 3: Codex JSONL adapter

已完成：

- `server/src/services/codexCliEventMapper.ts`
- `server/src/services/codexCliEventMapper.test.ts`
- 早期 message-format POC 已替换为 production mapper 单测

能力：

- 只解析 Codex `codex exec --json` 的 stdout JSONL。
- malformed stdout fail fast。
- stderr 只作为 bounded diagnostics tail。
- `thread.started`、`turn.started/completed/failed`、`agent_message`、`command_execution`、`file_change` 映射为现有 `CodeAgentRunnerEvent`。
- workspace 绝对路径会在 agent text、shell output、file changes、final answer 中归一化成相对路径。

### Phase 4: codex_cli backend startup gate

已完成：

- `server/src/services/codexCliRunnerConfig.ts`
- `server/src/services/codexCliRunnerConfig.test.ts`

当前边界：

- `CODE_AGENT_BACKEND=codex` 只有在 `CODEX_CLI_BACKEND_ENABLED=true`、`CODEX_CONNECTIONS_ENABLED=true` 且 connection service 配置成功时才允许启动。
- `CODEX_CLI_BACKEND_ENABLED=true` 不要求独立 worker 证明文件；Codex backend 复用 Code Agent engine / E2B sandbox runtime。

本阶段可独立部署：

- 默认 `CODE_AGENT_BACKEND=code-agent`、`CODEX_CLI_BACKEND_ENABLED=false`。
- 误设 `CODE_AGENT_BACKEND=codex` 但没有打开连接服务或 CLI backend flag 时，startup gate 会拒绝启动。

## 剩余阶段

### Phase 5: Unified Code Agent engine template with both CLIs

目标：在现有 Code Agent engine / E2B template 里加入 `codex_cli` backend，让 `code_agent_cli` 和 `codex_cli` 并行存在。

已完成：

- 更新 `ops/code-agent-sandbox`，在同一个 template 中安装/pin Codex CLI。
- 增加 `codex_cli` runner entrypoint 或 wrapper。
- wrapper 接收 RoomTalk 的 run request，恢复本次运行的 Codex subscription `auth.json`，调用 `codex exec --json`，把 stdout JSONL 转成 RoomTalk `CodeAgentRunnerEvent`。
- `auth.json` 只在 Code Agent engine 内的本次运行私有目录存在，不进入 workspace，不写日志，不进入 stdout/stderr/message。
- 任务结束后，wrapper 把 refreshed `auth.json` 以受控方式交回 RoomTalk server，由 server 重新加密保存。
- 同一个 template 继续保留 `code_agent_cli`，默认 backend 仍是 Code Agent。
- `server/src/services/codeAgentRuntimeConfig.ts` 会在 `CODE_AGENT_BACKEND=codex` 时默认选择 `python -m roomtalk_code_agent_runner.codex_cli`。
- `scripts/code-agent/prepare-sandbox-context.mjs` 会校验 `runner.backends.codex_cli` 存在且 Codex CLI 版本固定。
- `scripts/code-agent/build-e2b-template.mjs` 会生成 build context 并通过 `npx --yes @e2b/cli template create` 调用 E2B CLI；支持 `--dry-run`、`--publish`、`--no-cache`。
- `server/src/scripts/codexE2BSmoke.ts` / `npm run smoke:codex:e2b` 可对真实 E2B template 跑 Codex subscription smoke。

待做：

- 生产启用前再用生产 gateway 路径做一次端到端房间级验证：用户发起 Code Agent room turn，RoomTalk 注入短期 gateway token / Codex auth，E2B dual-cli template 完成任务并回写消息。

已验证：

- `scripts/code-agent/prepare-sandbox-context.mjs --output /tmp/roomtalk-code-agent-dual-cli-context-check` 通过。
- `docker build -t roomtalk-code-agent-dual-cli:local-poc /tmp/roomtalk-code-agent-dual-cli-context-check` 通过。
- Docker image 内 `codex --version` 输出 `codex-cli 0.142.5`，`roomtalk_code_agent_runner.runner` 与 `roomtalk_code_agent_runner.codex_cli` 均可 import。
- Docker image 内挂载本机 Codex ChatGPT subscription `auth.json` 后，`python -m roomtalk_code_agent_runner.codex_cli` 跑通真实 `codex exec --json`，输出 Code Agent JSONL `status` / `text_delta` / `final`，final answer 为 `codex smoke ok`。
- 裸容器 smoke 需要先初始化 `/workspace` git repo；生产 E2B 路径已有 `initializeWorkspaceVersionControl` 前置步骤。
- `node scripts/code-agent/build-e2b-template.mjs --dry-run --context /tmp/roomtalk-code-agent-dual-cli-context-check --template roomtalk-code-agent-2026-07-04-dual-cli-candidate --publish` 输出的 E2B create/publish 命令正确。
- `npx e2b ...` 会解析到 SDK 包并报 “could not determine executable to run”；本机登录要直接运行已安装的 `e2b auth login`，或运行 `npm exec --yes @e2b/cli -- auth login`。
- 真实 E2B template `roomtalk-code-agent-2026-07-04-dual-cli-candidate` 已构建并 publish；E2B template ID 为 `rgeqrltyo3gwsx2ie22n`，发布名为 `realruitao/roomtalk-code-agent-2026-07-04-dual-cli-candidate`。
- 第一版真实 E2B smoke 暴露 `/run/roomtalk-codex` 不适合存 secret file：E2B runtime 的 `/run` 是运行时 tmpfs，镜像 build 阶段创建的目录不会保留，普通 `roomtalk` 用户也不能在 `/run` 下新建目录。secret root 已改为 workspace 外的 `/tmp/roomtalk-codex`。
- `RUN_CODEX_E2B_SMOKE=true npm run smoke:codex:e2b` 已在真实 E2B template 上通过：`codex_cli` 成功读取注入的 subscription `auth.json`，输出 `status` / `text_delta` / `final`，并返回 refreshed auth。
- `RUN_CODE_AGENT_E2B_SMOKE=true npm run smoke:code-agent:e2b` 已在真实 E2B template 上通过：本机从主 checkout `server/.env` 读取 E2B/DeepSeek 配置，只在 smoke 子进程中临时收紧为 plan-only、关闭 shell/write/gateway，使用 direct DeepSeek provider key 验证 `code_agent_cli` 未回归。

验收：

- `code_agent_cli` 在新 template 中保持现有 E2B smoke 通过。已通过。
- `codex_cli` 在同一 template 中能使用注入的 subscription auth 跑通一条真实 `codex exec --json`。已通过。
- `codex_cli` 输出仍能映射到现有 Code Agent 消息流。已通过。
- 公开 API、浏览器、消息持久化中不出现 `auth.json`、access token、refresh token、device code。

### Phase 6: Wire codex_cli into CodeAgentSessionService

目标：真正让同一个 Code Agent room 根据 backend 选择 runner command。

已完成：

- `CodeAgentSessionService` 根据 backend 选择 `code_agent_cli` 或 `codex_cli` runner command。
- Codex backend turn 开始前必须要求当前 client 已连接 Codex subscription。
- 把 encrypted auth 解密后写入 sandbox 内 `/tmp/roomtalk-codex/...` secret file；runner env 只传 path，不传明文。
- 从 `codex_cli` 取回 refreshed auth 并保存。
- 保持现有 `CodeAgentRunnerEvent`、message segmentation、tool_call/tool_result、workspace snapshot 逻辑不变。
- E2B/fake sandbox service 都支持 secret file 写、读、删，并限制路径只能在 `/tmp/roomtalk-codex` 下。
- `CodeAgentRunner` 的 `codex` backend 复用共享 JSONL runner client，实际 CLI 由 runner command 决定。

验收：

- 单测证明 Codex backend 会写入 auth secret、启动 `python -m roomtalk_code_agent_runner.codex_cli`、读取 refreshed auth、清理 secret 文件。
- 同一用户 Codex connection 由 `withCodexAuth` lock 保护，同一时间只允许一个 active run。
- Code Agent backend 仍可回退，且默认仍为 Code Agent。
- 真实 E2B 中跑一条 Codex subscription task 已通过；后续仍要补有模型访问配置的 `code_agent_cli` smoke。

### Phase 7: Rollout

需要做：

- Product flag / allowlist。
- 连接状态和 reauth_required UI。
- 失败恢复：auth 过期、Codex CLI exit、template 缺 Codex CLI、auth refresh 失败。
- 监控：Codex CLI version、backend、exit code、stderr diagnostics size、usage、run duration。
- 文案：明确“使用你的 ChatGPT/Codex subscription”。

## 当前验证

```bash
cd server
node -r ts-node/register --test src/services/codexConnection.test.ts src/services/codexConnectionStore.test.ts src/services/codexConnectionConfig.test.ts src/services/codexDeviceAuthSession.test.ts src/routes/codexConnectionRoutes.test.ts src/routes/apiRoutes.test.ts
node -r ts-node/register --test src/services/codexCliEventMapper.test.ts src/services/codeAgentEventMapper.test.ts src/services/codeAgentWorkspace.test.ts
node -r ts-node/register --test src/services/codexCliRunnerConfig.test.ts src/services/codeAgentRunner.test.ts src/services/codeAgentRuntimeConfig.test.ts src/services/codeAgentSessionService.test.ts src/services/e2bCodeAgentSandboxService.test.ts src/services/fakeCodeAgentSandboxService.test.ts
npm run smoke:codex:e2b
npm run build
cd roomtalk_code_agent_runner && PYTHONPATH=. pytest
cd ../.. && node scripts/code-agent/prepare-sandbox-context.mjs --output /tmp/roomtalk-code-agent-dual-cli-context-check
node scripts/code-agent/build-e2b-template.mjs --dry-run --context /tmp/roomtalk-code-agent-dual-cli-context-check --template roomtalk-code-agent-2026-07-04-dual-cli-candidate --publish

cd ../client-heroui
npx vitest run src/utils/features.test.ts src/utils/codexConnection.test.ts src/components/SettingsView.test.tsx --reporter verbose
npm run test:e2e:codex
npm run build
```

最近结果：

- Backend targeted tests passed。
- Codex session wiring / sandbox secret-file targeted tests passed。
- `npm run smoke:codex:e2b` skipped safely without `RUN_CODEX_E2B_SMOKE=true`。
- `RUN_CODEX_E2B_SMOKE=true npm run smoke:codex:e2b` passed on published E2B template `roomtalk-code-agent-2026-07-04-dual-cli-candidate`。
- `RUN_CODE_AGENT_E2B_SMOKE=true npm run smoke:code-agent:e2b` passed on published E2B template `roomtalk-code-agent-2026-07-04-dual-cli-candidate` with local plan-only/direct DeepSeek smoke env。
- Frontend Codex tests passed。
- `npm run test:e2e:codex` passed。
- Server full `npm test` passed: 557 tests。
- Server/client builds passed。
- Python runner tests passed: 29 tests。
- `docker build -t roomtalk-code-agent-dual-cli:local-poc /tmp/roomtalk-code-agent-dual-cli-context-check` passed。
- Docker real Codex subscription smoke passed after initializing `/workspace` git baseline.

## 下一步

下一步做生产启用前验证：生产 Fly app `message-system` 已有 `E2B_API_KEY`、`CODE_AGENT_E2B_TEMPLATE_ID`、`CODE_AGENT_ARTIFACT_VERSION`、`CODE_AGENT_SOURCE_REF` secrets，但 Fly secret 不能反向读回本机。真实 dual-cli template 已发布，Codex E2B smoke 与 Code Agent E2B smoke 都已通过；下一步是决定 rollout 方式，更新 production `CODE_AGENT_E2B_TEMPLATE_ID` / `CODE_AGENT_ARTIFACT_VERSION` 到 dual-cli candidate，并新增 Codex 连接相关 secret/flag。不要再新增独立 Codex worker template，也不要恢复独立 worker / 本机运行相关 smoke。

生产启用 Codex 还需要新增并确认：

- `CODEX_AUTH_ENCRYPTION_KEY`：用于加密持久化用户 Codex subscription `auth.json`。
- `CODEX_CONNECTIONS_ENABLED=true`：只打开 Settings 里的 Codex 账号连接和连接 API。
- `CODEX_CLI_BACKEND_ENABLED=true` + `CODE_AGENT_BACKEND=codex`：在 dual-cli E2B template 验证通过后再切 Codex backend。
