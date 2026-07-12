# Code Agent Model Access 策略

[English](code-agent-model-access.md)

状态：当前
更新：2026-07-12

## 目标

Code Agent 在 file/process sandbox 中运行。Sandbox 可写文件或运行 shell 时，RoomTalk 不得向其注入长期 provider API key。

JSONL/daemon runner 支持两种批准合约：

1. RoomTalk model proxy/gateway：长期 provider key 保留在 Node，sandbox 只获得 turn-scoped token。
2. Scoped provider key：只在 upstream 能发放有限 TTL、budget 和 audit identity 的真正 scoped key 时使用。

未配置任一符合合约的路径时，可写 Code Agent mode 必须 startup fail closed。

## Model Proxy 合约

RoomTalk gateway 签发短期 token，绑定 client、room、turn、model、provider、request/budget limit 和 expiry。Sandbox 只获得 proxy URL/token，不获得 provider key。

Gateway 必须：

- 验证 signature、expiry、model/provider 和 per-turn limit；
- 只使用服务端选中 provider credential；
- 限制 body 大小和请求数；
- 记录 provider-reported usage，并在下次请求前执行 budget；
- 拒绝不完整 usage，不用未标记 estimate 冒充计费事实；
- 不把 upstream auth/header/error body 泄露进 room transcript。

Production proxy 必须使用 HTTPS。直接 provider key 不得通过 runner env allowlist 转发。

## Scoped Provider Key 合约

Scoped key 路径必须同时提供：

- 短 TTL；
- 明确 model/provider scope；
- 有限 budget；
- 可追溯 audit ID；
- 可撤销/轮换。

普通长期 API key 即使被换了一个环境变量名，也不是 scoped key。

## Startup Refusal

开启 Code Agent 且允许 write/Shell 时，以下情况必须拒绝启动：

- 选择 proxy strategy 但缺失 URL/token；
- production proxy 不是 HTTPS；
- 配置 proxy 值但 strategy 未显式选中；
- scoped key 缺失 budget 或 audit metadata；
- provider key 可通过通用 env 进入 sandbox；
- mode/backend/artifact 组合不受支持。

Plan 模式可在不发放 model write capability 的情况下启动，但仍不得注入不必要 provider key。

## 验证

- Runtime config test 覆盖 strategy/mode/backend/startup refusal。
- Gateway test 覆盖 model scope、usage/budget、streaming usage 和 Anthropic/OpenAI-compatible auth。
- Session test 确认只选中 provider env 且 host key 不进 runner。
- E2B smoke 确认 sandbox 能通过 scoped path 调用 model，但看不到 provider credential。
