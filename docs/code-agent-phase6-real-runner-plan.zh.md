# Code Agent Phase 6 真实 Runner 方案

[English](code-agent-phase6-real-runner-plan.md)

状态：已完成的历史阶段方案
复核：2026-07-12

## 目标

在文件/进程沙盒里运行已有 Code Agent，而不是由 RoomTalk 重写 agent loop。

RoomTalk 负责：

- 房间与权限校验；
- sandbox 生命周期；
- JSONL runner 协议；
- 消息持久化与 UI replay；
- feature flag、灰度与回滚。

Code Agent 负责：

- model/tool loop；
- tool 执行语义；
- permission mode；
- session 与上下文管理。

## 当时的能力检查

本地 Code Agent 已经有 provider/model 选择、会话、tool loop、权限模式与 command/file tools，但缺少稳定的非交互协议边界。Phase 6 的工作不是复制这些能力，而是把它们封装为可测试、可版本化、可在 E2B 中运行的 adapter。

## 架构决策

```text
CodeAgentSessionService
  -> CodeAgentRunnerClient
       -> sandbox stdin/stdout JSONL
            -> roomtalk_code_agent_runner
                 -> Code Agent engine
```

Node 控制面不 import Python agent 内核。Runner request 携带显式 protocol version、request/turn ID、workspace、prompt、mode、model 和有限上下文；runner event 统一为 text/tool/approval/usage/result/error。

stdout 只允许协议事件，日志写 stderr。每个请求必须产生唯一终态。格式错误、超时、进程退出和 sandbox 丢失都转换为 RoomTalk 可持久化的结构化错误。

## 安全决策

- Agent 只能在 room-scoped sandbox workspace 中执行。
- provider credential 不进入浏览器或 room message。
- RoomTalk 只注入本 turn 所需的短期/有界凭据。
- mode 和审批策略由 server 校验，runner 不接受浏览器自报权限。
- 命令时间、输出、路径和事件 payload 都有上限。
- sandbox image 与 runner source 必须固定版本，不能运行主机 checkout 的漂移代码。

## 分阶段实施

### 6.1 Runner Adapter Package

建立 Python package、request/event schema、CLI entrypoint、stdin loop、stderr logging 与 fake model/tool fixtures；用 contract test 固定成功、异常和 malformed input 行为。

### 6.2 Node JSONL Runner Client

实现子进程启动、逐行 encode/decode、请求关联、超时、中断、退出清理和 bounded diagnostics。把 runner-specific 事件映射为 RoomTalk 的中立事件。

### 6.3 Sandbox Wiring

由 sandbox service 启动 runner，设置 workspace 与 scoped env，确认 cwd、依赖和健康状态；sandbox 创建/重连后都执行兼容性检查。

### 6.4 Image / Artifact

把 runner、Code Agent engine、系统依赖和 metadata 打进不可变 artifact。构建产物记录 source ref、runner version、protocol version 和 smoke 结果。生产只引用已验证的 E2B template ID。

### 6.5 Model Access

模型访问由 RoomTalk 选择并审计。原方案允许 sandbox 内最小化注入 provider key；当前实现进一步使用 model gateway 与 turn-scoped token，详见 [模型访问](code-agent-model-access.zh.md)。

## 验证

- Python contract tests：协议、事件顺序、异常与中断；
- Node tests：parser、timeout、exit、cleanup；
- sandbox smoke：真实文件修改、命令、tool event 与最终结果；
- artifact smoke：固定 template 中从零启动；
- RoomTalk integration：权限、持久化、replay 与失败恢复；
- rollout：feature flag、可观测性与回滚。

## 结果与当前指向

Phase 6 建立的边界仍是现行设计的基础，但一次一进程的 runner 已演进为可复用 sandbox daemon，并新增 Codex app-server、room context broker、model gateway、workspace UI 与 artifact migration。当前事实源：

- [Code Agent 运行时架构](code-agent-runtime-architecture.zh.md)
- [Sandbox daemon](sandbox-daemon-plan.zh.md)
- [Sandbox artifact 合约](code-agent-sandbox-artifact.zh.md)
