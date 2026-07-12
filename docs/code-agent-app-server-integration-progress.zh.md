# Code Agent App Server Integration Progress

[English](code-agent-app-server-integration-progress.md)

状态：重要实现进展记录；当前架构以 runtime architecture 为准
Reviewed: 2026-07-12

## 目标

在现有 Code Agent 和 Codex CLI backend 之外，实现第三个并行 backend：Codex app-server。Code Agent、Codex CLI、Codex app-server 必须共用一套 RoomTalk code-agent runner/session 接口，避免 Codex 继续复用 Code Agent 专属命名。

## 提交计划

目标控制在 3 个提交内：

1. Pre-commit 1: 通用化 runner protocol、event mapper、fake/jsonl runner client 命名。
2. Pre-commit 2: 通用化 session、sandbox、runtime config 和 socket handler 注入命名。
3. App-server commit: 新增 Codex app-server backend，并通过同一套 code-agent 接口并行接入 `code-agent`、`codex`、`codex-app-server`。

## 当前设计约束

- 房间类型和旧数据库字段暂时保持兼容，例如 `type: 'codeAgent'`、`codeAgentSessionId`、`codeAgentStatus`。这属于持久化兼容层，不代表内部接口继续使用 Code Agent 专属命名。
- 生产 code-agent runner 仍在 E2B template 内运行。涉及 `server/roomtalk_code_agent_runner`、runner command、Dockerfile 或 template 内容的改动，都必须 bump `ops/code-agent-sandbox/artifact.lock.json` 和 `ops/code-agent-sandbox/Dockerfile`，并在后续 rebuild E2B template。
- Codex app-server 使用 `codex app-server` 的 stdio JSON-RPC 优先；WebSocket transport 在 Codex 文档中仍标为 experimental/unsupported，不作为第一版生产依赖。
- Codex app-server backend 仍走用户 ChatGPT/Codex subscription auth，不走 OpenAI API key 或 Agents SDK。

## Codex App Server 依据

Codex manual 中 app-server 被描述为 rich client 接口，覆盖 authentication、conversation history、approvals、streamed agent events；协议是 JSON-RPC 2.0 风格，支持 stdio JSONL、WebSocket、Unix socket。第一版选择 stdio，避免暴露未受支持的远程 WebSocket transport。

## 进度

- [x] 当前 master 已有 Codex CLI subscription auth POC，可作为 `codex` backend 保留。
- [x] Pre-commit 1: runner protocol/event/client 命名通用化。
- [x] Pre-commit 2: session/runtime config/socket 注入命名通用化。
- [x] Codex app-server backend 接入。
- [x] 轻量验证：TypeScript compile。
- [x] 轻量验证：runner parser tests、Codex app-server adapter unit tests。
- [x] 后续部署动作：E2B template rebuild、production env update、sandbox migration/restart。

## 2026-07-04 进展

- Pre-commit 1 已把 runner protocol、fake/jsonl runner client、runner event mapper 改为 `CodeAgent*` 命名。
- 保留 `CodeAgentSandboxService`、E2B artifact、Code Agent model gateway、`type: 'codeAgent'`、`codeAgentSessionId`、`codeAgentStatus` 等 Code Agent 语义边界，避免把持久化和产品语义误改成通用名。
- runner event mapper 支持按 backend 传入显示名；默认仍为 Code Agent，Codex backend 可显示 Codex。
- 已通过 `server` 目录下 `npx tsc --noEmit --pretty false`。
- Pre-commit 2 已把 `CodeAgentSessionService`/`CodeAgentRuntimeConfig` 改为 `CodeAgentSessionService`/`CodeAgentRuntimeConfig`，并把 socket/server 注入点改为 `codeAgentSessionService`。
- `/api/features` 和 `/api/status` 的对外 `codeAgent` payload 保持不变；`CODE_AGENT_*` env、Code Agent model gateway、Code Agent sandbox lifecycle、E2B artifact/source ref 继续保留为兼容契约。
- App-server commit 新增 `python -m roomtalk_code_agent_runner.codex_app_server` runner，接入 `CODE_AGENT_BACKEND=codex-app-server`，并复用 Codex subscription auth 注入、E2B sandbox、JSONL runner client。
- 前端 backend selector 支持 `Code Agent CLI`、`Codex CLI`、`Codex App Server` 并行切换；Codex CLI 和 app-server 都显示 Codex 模型、思考深度、权限模式。
- 已 bump `ops/code-agent-sandbox/artifact.lock.json` 和 `ops/code-agent-sandbox/Dockerfile`，E2B template rebuild 时会验证 `roomtalk_code_agent_runner.codex_app_server`。
- E2B template 已 rebuild 并 publish 为 `realruitao/roomtalk-code-agent-2026-07-04-codex-app-server`；ready command 覆盖 `codex --version`、`codex-linux-sandbox --help`、`roomtalk --help`，以及 `roomtalk_code_agent_runner.runner`、`roomtalk_code_agent_runner.codex_cli`、`roomtalk_code_agent_runner.codex_app_server` import。
- 已修复 sandbox 内 `/usr/local/bin/roomtalk` launcher 生成问题，避免 E2B 中出现不可执行的坏 shebang。
- 生产 Fly secrets 已更新为 `CODE_AGENT_E2B_TEMPLATE_ID=roomtalk-code-agent-2026-07-04-codex-app-server`、`CODE_AGENT_ARTIFACT_VERSION=roomtalk-code-agent-2026-07-04-codex-app-server`；默认 `CODE_AGENT_BACKEND=code-agent` 保持不变。
- 生产 Codex 沙箱已通过迁移脚本做 archive/import/probe 后切换到新 template，并在成功后销毁旧 sandbox。迁移房间共 5 个：`ET08NWIhgh`、`4sPMatu90U`、`4NNTnc8b6N`、`emY9TGYwXs`、`MZPxmVYl4Y`。
- 迁移后 dry-run 复查结果：5 个候选房间全部为 `already_ready`，对应新 sandbox 分别为 `i4v6140mbqgtm61rkfs2z`、`i4jq5ty78d1fqsrnr7c9g`、`iedjesi6ls68mq10prrvd`、`ibow2snctkqnflbjmkahy`、`iytovs6qxwyarg43uylzk`。
- `master` CI/CD run `28708530641` 已通过 server build、client build、translation check 和 Fly deploy。
- app-server 一等公民第一批能力已补齐：per-room persistent Codex home、`thread/resume` 优先并在 resume 失败时 fallback 到 `thread/start`、非 ephemeral thread、`thread/tokenUsage/updated` usage 回传、command/file output delta 聚合、MCP tool item 映射、warning/error/model reroute 状态映射、server request 的 approval/user-input/elicitation/auth-refresh 响应结构。
- runner package 已 bump 到 `0.1.5`，E2B artifact version 已 bump 到 `roomtalk-code-agent-2026-07-04-codex-app-server-v2`。app-server persistent home 会在每轮结束清理 `auth.json` 和 `config.toml`，保留 Codex thread/history 数据。

## 已执行验证

- `server/roomtalk_code_agent_runner`: `pytest tests/test_codex_app_server.py`
- `server`: `npx tsc --noEmit --pretty false`
- `server`: `node -r ts-node/register --test src/services/codeAgentRuntimeConfig.test.ts src/services/codeAgentRunner.test.ts src/services/codexCliRunnerConfig.test.ts src/services/codeAgentSessionService.test.ts`
- `client-heroui`: `npm run check:i18n`
- `client-heroui`: `npx tsc --noEmit --pretty false`

## 风险

- 大量历史文件、文档和数据库字段仍以 Code Agent 命名存在。代码内部接口先通用化，持久化命名后续再单独迁移，避免一次变更同时碰 runtime 和数据迁移。
- app-server 的部分 API 需要 `experimentalApi` capability。第一版 adapter 只使用必要的稳定 thread/turn/event 流；需要权限 profile/list 或 background terminal API 时再显式开启 experimental capability。
- app-server 目前仍是后台非交互 runner，不会把 approval request 弹到 RoomTalk UI 让用户实时批准；第一批实现会以 schema-compatible 的拒绝/空权限响应处理受限请求。完整交互审批、`turn/steer`、`turn/interrupt`、thread list/read UI、permission profile UI 是后续阶段。
