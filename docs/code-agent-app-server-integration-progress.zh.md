# Code Agent App Server Integration Progress

## 目标

在现有 Coco 和 Codex CLI backend 之外，实现第三个并行 backend：Codex app-server。Coco、Codex CLI、Codex app-server 必须共用一套 RoomTalk code-agent runner/session 接口，避免 Codex 继续复用 Coco 专属命名。

## 提交计划

目标控制在 3 个提交内：

1. Pre-commit 1: 通用化 runner protocol、event mapper、fake/jsonl runner client 命名。
2. Pre-commit 2: 通用化 session、sandbox、runtime config 和 socket handler 注入命名。
3. App-server commit: 新增 Codex app-server backend，并通过同一套 code-agent 接口并行接入 `coco`、`codex`、`codex-app-server`。

## 当前设计约束

- 房间类型和旧数据库字段暂时保持兼容，例如 `type: 'coco'`、`cocoSessionId`、`cocoStatus`。这属于持久化兼容层，不代表内部接口继续使用 Coco 专属命名。
- 生产 code-agent runner 仍在 E2B template 内运行。涉及 `server/roomtalk_coco_runner`、runner command、Dockerfile 或 template 内容的改动，都必须 bump `ops/coco-sandbox/artifact.lock.json` 和 `ops/coco-sandbox/Dockerfile`，并在后续 rebuild E2B template。
- Codex app-server 使用 `codex app-server` 的 stdio JSON-RPC 优先；WebSocket transport 在 Codex 文档中仍标为 experimental/unsupported，不作为第一版生产依赖。
- Codex app-server backend 仍走用户 ChatGPT/Codex subscription auth，不走 OpenAI API key 或 Agents SDK。

## Codex App Server 依据

Codex manual 中 app-server 被描述为 rich client 接口，覆盖 authentication、conversation history、approvals、streamed agent events；协议是 JSON-RPC 2.0 风格，支持 stdio JSONL、WebSocket、Unix socket。第一版选择 stdio，避免暴露未受支持的远程 WebSocket transport。

## 进度

- [x] 当前 master 已有 Codex CLI subscription auth POC，可作为 `codex` backend 保留。
- [x] Pre-commit 1: runner protocol/event/client 命名通用化。
- [ ] Pre-commit 2: session/sandbox/config 命名通用化。
- [ ] Codex app-server backend 接入。
- [x] 轻量验证：TypeScript compile。
- [ ] 轻量验证：runner parser tests、Codex app-server adapter unit tests。
- [ ] 后续部署动作：E2B template rebuild、production env update、sandbox migration/restart。

## 2026-07-04 进展

- Pre-commit 1 已把 runner protocol、fake/jsonl runner client、runner event mapper 改为 `CodeAgent*` 命名。
- 保留 `CocoSandboxService`、E2B artifact、Coco model gateway、`type: 'coco'`、`cocoSessionId`、`cocoStatus` 等 Coco 语义边界，避免把持久化和产品语义误改成通用名。
- runner event mapper 支持按 backend 传入显示名；默认仍为 Coco，Codex backend 可显示 Codex。
- 已通过 `server` 目录下 `npx tsc --noEmit --pretty false`。

## 风险

- 大量历史文件、文档和数据库字段仍以 Coco 命名存在。代码内部接口先通用化，持久化命名后续再单独迁移，避免一次变更同时碰 runtime 和数据迁移。
- app-server 的部分 API 需要 `experimentalApi` capability。第一版 adapter 只使用必要的稳定 thread/turn/event 流；需要权限 profile/list 或 background terminal API 时再显式开启 experimental capability。
