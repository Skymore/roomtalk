# RoomTalk Sandbox Daemon 运行时与协议

[English](sandbox-daemon-plan.md)

状态：当前 runtime；为保留已有链接，沿用历史文件名
已按 `master` 和生产非 secret 配置核对：2026-07-20

## 目标

每个 E2B sandbox 复用一个 sandbox-local daemon，而不是每个 Agent turn 启动新 E2B command process。RoomTalk 仍拥有 room、permission、durable turn、fenced room lease、scoped token 和 sandbox lifecycle。Daemon 只拥有 Agent backend request loop。

```text
RoomTalk server
  -> ensure/create E2B sandbox
  -> ensure daemon health
  -> send turn/control/query request
  <- persist and broadcast structured event

Sandbox daemon
  -> dispatch Coco or Codex app-server
  -> run against /workspace
  -> emit versioned JSONL events
```

PTY、preview、dev server 和 file API 是独立 sandbox service，不属于 daemon protocol state。

## 当前生产

```text
CODE_AGENT_SANDBOX_PROVIDER=e2b
CODE_AGENT_RUNNER_CLIENT=daemon
CODE_AGENT_BACKEND=codex-app-server
```

Daemon registry 每个 sandbox 串行 startup，复用已健康连接，在终止、control failure、query timeout 或 poisoned handle 时移除并重建。

## 为什么用 Daemon

- 避免每 turn 重复 E2B process startup 和 backend initialization。
- 支持 Codex app-server thread/session 续接。
- 在一个版本化 channel 上表达 run、interrupt、steer、approval、query 和 release。
- 把 backend lifecycle 与 RoomTalk durable lifecycle 分开，便于失败恢复。
- 将 sandbox-local 运行与 provider/database credential 隔离。

## Non-goals

- Daemon 不是 room/turn/message 的事实源。
- Daemon 不授权用户或 mode。
- Daemon 不拥有 E2B create/pause/resume/destroy。
- Daemon 不管理 browser PTY/preview session registry。
- Daemon 不获得长期 provider/database/RoomTalk secret。

## Backend

- `coco`：RoomTalk 自研 CLI Agent/engine。
- `codex-app-server`：当前受支持 Codex backend，使用用户连接的 subscription auth。
- `codex`：已废弃 CLI compatibility path，只在显式迁移/兼容时保留，不增加新产品能力。

Backend 由每个 run request 显式选择，同一 daemon 不依赖全局单一 backend。

## 协议

Transport 是 stdin/stdout JSONL，所有 message 带 schema version 和 request/turn identity。主要请求：

- `run`：启动一个 backend turn，携带 workspace、mode、model、prior/session state 和最小 env。
- `interrupt`：中断 active turn。
- `steer`：在 backend 支持时插入追加用户输入。
- `approval_response`：返回授权用户的 approval 决定。
- `thread_query`：查询 backend thread/session 状态。
- `shutdown`：有界关闭 daemon。

事件包括：

- `text_delta`、`tool_call`、`tool_result`、`status`、`model_step`、`usage`、`approval_request`、`final`、`error`；
- daemon control event：accepted/rejected、thread result、turn released、shutdown acknowledgement。

Runner parser 处理分片 JSONL 和无 trailing newline 的最后一行，拒绝不支持 schema 和 malformed daemon-only event。

## 生命周期

1. Lifecycle service 确保 sandbox ready。
2. Registry 确保 daemon 存在且健康；并发 startup 只创建一个 process。
3. Session service 获取 fenced lease，发送 run request。
4. Event handler 在继续读取前完成持久化/广播，保留顺序。
5. Terminal final/error 与 turn release 使用有界等待汇合。
6. 完成后保留健康 daemon；失败时终止并从 registry 移除。
7. Server shutdown 会终止所有 tracked daemon；sandbox replacement/destroy 也会清理对应 handle。

Daemon 丢失 `turn_released` 不应导致永久挂起；已收到 terminal event 时可在有界等待后完成。Thread query timeout 则意味着 control channel 不再可信，需终止 daemon。

## 实现状态

已完成：

- versioned protocol、chunk parser 和 event mapper；
- reusable daemon registry 和 concurrent startup serialization；
- Coco/Codex app-server dispatch；
- run/interrupt/steer/approval/query/release/shutdown；
- bounded query/release waits 和 poisoned-handle recycling；
- server/sandbox shutdown cleanup；
- focused unit/service/E2B verification。

保留兼容：单次 JSONL runner client 和已废弃 Codex CLI adapter。

## 发布合约

Daemon/protocol/runner/tool/prompt/dependency 变化属于 sandbox artifact 边界。必须 bump runner/artifact，重建 E2B template，同步生产 pin，并验证真实 daemon/backend turn。只部署 RoomTalk control plane 不会更新已存 artifact。
