# Code Agent Sandbox Artifact

[English](code-agent-sandbox-artifact.md)

状态：当前 release 合约
已按 `master` 和生产非 secret runtime pin 核对：2026-07-12

## 用途

RoomTalk 在 room-scoped file/process sandbox 里运行 Coco 和 Codex app-server。生产必须使用固定 artifact，不能使用开发机 path。遗留 Codex CLI adapter 只为兼容/迁移保留。

Artifact 包含：

- 固定 commit 的 Coco engine source；
- `roomtalk_code_agent_runner` JSONL adapter 和可复用 daemon；
- hash-verified Python dependency；
- 固定 Codex CLI/app-server 和 Python SDK；
- Chromium/Playwright、常见 toolchain、`gh`、Git LFS、`roomtalk` CLI 和 PTY shell environment。

## 当前 Lock

事实源是 `ops/code-agent-sandbox/artifact.lock.json`，当前生产快照：

```text
artifactVersion: roomtalk-code-agent-2026-07-12-coco-permissions-v3
codeAgentEngine.sourceRef: 0b5e44eb29ad1bec89b2143737f6917aafa79359
roomtalk-code-agent-runner: 0.1.31
openai-codex: 0.144.1
openai SDK: 0.1.0b3
playwright: 1.61.1
```

版本数值会变化；操作前始终读 lock，不要从本文复制旧 pin。

## Build Context

`scripts/code-agent/prepare-sandbox-context.mjs` 构建最小、可重现 context，包含 RoomTalk runner package、固定 engine archive、dependency lock/hash 和 artifact metadata。`ops/code-agent-sandbox/Dockerfile` 只从这个 context 构建。

准备 context：

```bash
node scripts/code-agent/prepare-sandbox-context.mjs
```

构建前需验证：

- engine source ref 已提交并可从配置 remote 获取；
- archive/hash 与 lock 匹配；
- runner package version、Dockerfile metadata 和 artifact version 一致；
- context 不包含 `.env`、auth JSON、provider key、GitHub PAT 或开发机绝对 path。

## 生产配置

生产 control plane 使用 E2B、daemon 和 Codex app-server，关键 pin 包括：

```text
CODE_AGENT_SANDBOX_PROVIDER=e2b
CODE_AGENT_RUNNER_CLIENT=daemon
CODE_AGENT_BACKEND=codex-app-server
CODE_AGENT_E2B_TEMPLATE_ID=<template>
CODE_AGENT_ARTIFACT_VERSION=<artifactVersion>
CODE_AGENT_SOURCE_REF=<engine sourceRef>
```

当前 lifecycle 使用 2 分钟 idle TTL 和 1 小时 active TTL。具体配置仍以生产 secret/env 为准。

## 开发模式

本地 source mount 只能在显式 development artifact mode 使用，不得带入 production。开发模式也不能放松生产 startup gate 对 template/artifact/source-ref 的校验。

## Acceptance

新 artifact 必须验证：

- Python runner 和 daemon 可 import/启动；
- Coco 在允许 mode 下执行 text/tool turn；
- Codex app-server 可用用户 subscription auth 执行 turn；
- image input、room context、model gateway、static publish 和 approval/interrupt/steer 的受影响边界；
- workspace Git/file/PTY/preview 基础能力；
- artifact metadata 与 production pin 完全匹配。

完成标准不是“Docker build 成功”，而是新 E2B template 已发布、被生产引用并通过真实边界验证。
