# Coco Model Access Strategy

## Goal

Coco runs inside a file/process sandbox. When the sandbox can write files or run shell commands, RoomTalk must not inject long-lived provider API keys into that process.

Phase 6.5 supports two approved contracts for JSONL Coco runner mode:

1. Model proxy
2. Scoped provider key provisioned out of band

Direct provider keys are allowed only for `plan` mode, where the runner exposes read-only tools.

## Model Proxy Contract

Use this when the sandbox should call a RoomTalk-controlled model gateway instead of receiving provider keys.

Required env:

```bash
COCO_MODEL_ACCESS_STRATEGY=proxy
COCO_MODEL_PROXY_URL=https://model-proxy.internal
COCO_MODEL_PROXY_TOKEN=<short-lived-turn-token>
```

`COCO_MODEL_PROXY_URL` must be an HTTPS URL. When Coco is enabled, setting
`COCO_MODEL_PROXY_URL` or `COCO_MODEL_PROXY_TOKEN` without
`COCO_MODEL_ACCESS_STRATEGY=proxy` is rejected, including in `plan` mode, so a
direct provider key cannot coexist accidentally with a runner that will route
through the proxy.

Behavior:

- RoomTalk forwards only `COCO_MODEL_PROXY_URL` and `COCO_MODEL_PROXY_TOKEN` to the runner.
- RoomTalk does not forward `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `DEEPSEEK_API_KEY`.
- The Python runner uses the proxy URL as Coco's provider `base_url`.
- Provider SDKs do not all use the same base URL convention. OpenAI-compatible
  SDKs expect a `/v1` base URL and call `chat/completions`; Anthropic's SDK
  appends `/v1/messages` itself. The RoomTalk runner strips a trailing `/v1`
  only for Anthropic so both SDK families can share one proxy contract.
- The Python runner uses the short-lived proxy token as Coco's provider `api_key`.
- The proxy service owns provider keys, room/turn authorization, budget checks, redaction, and audit logging.

The current code validates the runner-side contract. The actual proxy service can be added behind `COCO_MODEL_PROXY_URL` without changing the runner protocol.

## Scoped Provider Key Contract

Use this when the sandbox image/session already has a short-lived provider key provisioned outside RoomTalk.

Required env:

```bash
COCO_SCOPED_PROVIDER_KEY=true
COCO_SCOPED_PROVIDER_KEY_TTL_SECONDS=900
COCO_SCOPED_PROVIDER_KEY_BUDGET_USD=0.25
COCO_SCOPED_PROVIDER_KEY_AUDIT_ID=<room-turn-audit-id>
```

Behavior:

- RoomTalk treats this as an out-of-band credential contract.
- RoomTalk does not forward long-lived provider keys to the runner.
- The provider-key issuer must enforce TTL, budget, provider/model scope, and audit logging.
- `COCO_SCOPED_PROVIDER_KEY_AUDIT_ID` must map the external credential to a RoomTalk room/turn.

## Startup Refusals

Production JSONL `acceptEdits`, write-tool, or Shell mode refuses to start unless one of the approved contracts is complete.

Invalid examples:

```bash
# Missing proxy token
COCO_MODEL_ACCESS_STRATEGY=proxy
COCO_MODEL_PROXY_URL=https://model-proxy.internal

# Proxy must be HTTPS
COCO_MODEL_ACCESS_STRATEGY=proxy
COCO_MODEL_PROXY_URL=http://model-proxy.internal
COCO_MODEL_PROXY_TOKEN=<short-lived-turn-token>

# Proxy settings require explicit strategy
COCO_MODEL_PROXY_URL=https://model-proxy.internal
COCO_MODEL_PROXY_TOKEN=<short-lived-turn-token>

# Missing scoped-key budget/audit metadata
COCO_SCOPED_PROVIDER_KEY=true
COCO_SCOPED_PROVIDER_KEY_TTL_SECONDS=900
```

Valid examples:

```bash
# Proxy
COCO_MODEL_ACCESS_STRATEGY=proxy
COCO_MODEL_PROXY_URL=https://model-proxy.internal
COCO_MODEL_PROXY_TOKEN=<short-lived-turn-token>

# Scoped key
COCO_SCOPED_PROVIDER_KEY=true
COCO_SCOPED_PROVIDER_KEY_TTL_SECONDS=900
COCO_SCOPED_PROVIDER_KEY_BUDGET_USD=0.25
COCO_SCOPED_PROVIDER_KEY_AUDIT_ID=room-123-turn-456
```

## Verification

Covered by tests:

- `acceptEdits` without proxy/scoped contract is rejected.
- proxy mode without token is rejected.
- proxy URL without HTTPS is rejected by both Node config and Python runner.
- proxy URL/token without `COCO_MODEL_ACCESS_STRATEGY=proxy` is rejected.
- scoped-key mode without TTL, budget, and audit id is rejected.
- proxy/scoped mode suppresses direct provider env forwarding.
- runner proxy env overrides direct provider credentials.
- Coco runner subprocess environments are explicit and do not inherit host provider keys.
