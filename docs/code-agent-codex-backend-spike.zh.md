# Code Agent Codex Backend Spike

[English](code-agent-codex-backend-spike.md)

状态：历史调研；Codex app-server 后续已成为受支持方向
日期：2026-05-30
复核：2026-07-12

## 调研问题

RoomTalk 是否能在不替换 Coco/Code Agent、也不削弱 sandbox 边界的前提下，支持第二种 Codex backend？调研时的候选配置是 `code-agent | codex | codex-app-server`。

## 当时结论

技术上可行，但在 2026-05-30 的检查点不应直接上线。RoomTalk 当时的 runner contract 暴露了过多 Code Agent 特有类型，也缺少 Codex runtime control、认证、恢复和 sandbox 验证。

调研后的第一条实现路线一度收敛为同一 E2B template 内并行 `code_agent_cli` 与 `codex_cli`。之后生产方向进一步收敛为 `codex-app-server`；CLI 路径只保留兼容性，不再承载新功能。当前规则以 [运行时架构](code-agent-runtime-architecture.zh.md) 和 `CLAUDE.md` 为准。

## 证据与可借鉴点

Codex app-server 提供 thread/turn 生命周期、结构化 item/event、审批、interrupt、model/reasoning 配置和 session 恢复。T3 Code 一类客户端证明 app-server 可以驱动 rich coding UI，但它的本地桌面信任模型不能直接搬到多租户 RoomTalk。

可以吸收的是协议和状态机思路：

- thread 与 RoomTalk room/agent session 显式映射；
- turn、item、tool、approval 事件保留 source order；
- interrupt 和审批是运行时控制，不是普通聊天消息；
- backend session ID 必须持久化并验证归属；
- backend-specific event 在 server 侧归一化。

不能照搬的是浏览器直接控制 app-server、在 Fly host 上执行用户代码、或让一个进程跨房间共享写权限。

## 被否决的接入方式

### Browser 直连 Codex app-server

这会绕过 RoomTalk 的权限、审计、budget、消息持久化和 scoped secret 管理，因此不可接受。

### Fly server host 上执行 Codex

这会把不可信工作区和命令带进控制面，破坏 room isolation，也让资源限制和清理难以证明。

### 以 `codex exec` 作为长期产品协议

CLI JSONL 适合早期 bridge/smoke，但不完整表达长期 thread 控制、审批、steer、interrupt 和 recovery 语义。它后来成为兼容路径，而不是新功能方向。

## 推荐架构

```text
Browser
  -> RoomTalk auth / room policy / persistence
  -> CodeAgentSessionService
  -> room-scoped E2B sandbox
  -> Codex app-server adapter
  -> normalized RoomTalk runner events
```

RoomTalk 持有 room、turn、lease、queue、budget 与 audit；sandbox 持有 workspace 和 backend process；Codex 持有自身 thread/turn/tool 协议。三层之间不能互相偷渡权限。

## 历史安全门槛

- Codex 必须运行在 room-scoped sandbox，而不是 control plane host。
- 用户订阅认证材料要加密保存，按 turn 注入，不进入 prompt、message 或日志。
- reconnect 时必须确认 backend session 属于当前 room/client。
- approval、mode、interrupt 与 budget 均由 server 重新校验。
- event payload、工具输出、路径和生命周期操作必须 bounded。
- runner/app-server 版本必须进入 artifact metadata 并经过 E2B smoke。

## 建议的实施顺序

1. 把 runner contract 中立化，移除 generic boundary 的 Code Agent 私有类型。
2. 固定 run controls：start、steer、interrupt、approval、release。
3. 添加默认关闭的 Codex adapter 与解析测试。
4. 在 sandbox 中完成真实 smoke 与 session recovery。
5. 接入 per-client 订阅认证、UI connection 状态与 rollout gates。

## 后续结果

这些门槛后来分别落在 `codexConnection*`、`CodeAgentSessionService`、sandbox daemon、artifact contract 和 app-server adapter 中。本文保留的是技术选型过程，不应被当作当前 backend 启用状态或操作 runbook。
