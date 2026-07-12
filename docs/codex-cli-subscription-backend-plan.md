# Codex CLI Subscription Backend Phased Plan

[中文原文](codex-cli-subscription-backend-plan.zh.md)

Status: Historical implementation plan; CLI is now a deprecated compatibility path
Reviewed: 2026-07-12

## Target Shape at the Time

```text
RoomTalk app server
  -> shared Code Agent / E2B sandbox artifact
       -> code_agent_cli backend
       -> codex_cli backend
```

The plan kept the RoomTalk `codeAgent` room type, message model, UI, and normalized runner events. Codex CLI was treated as a peer backend inside the same sandbox artifact rather than a separate worker image.

Authentication used the user's ChatGPT/Codex subscription through `codex login --device-auth`. RoomTalk displayed only the OpenAI device URL and one-time code, stored the resulting `auth.json` as an encrypted opaque secret, injected it into a private sandbox directory for that client's turn, and wrote back a refreshed file afterward.

Business/Enterprise access tokens and OpenAI Platform API-key billing were outside the scope. `CODEX_API_KEY` and `OPENAI_API_KEY` were not valid substitutes for subscription authentication.

## Implemented Phases

### Phase 0: Proof of Concept

Validated device authorization, encrypted opaque auth storage, non-interactive CLI invocation, JSONL output, and execution inside an isolated workspace.

### Phase 1: Connection Store and Service

Added a per-client Codex connection record, encryption/decryption boundaries, status lookup, disconnect, refresh handling, and tests that kept auth material out of API responses and logs.

### Phase 2: Connection API and UI

Added endpoints and settings UI for starting device authorization, polling connection status, showing expiry/errors, and disconnecting. A connection belongs to a RoomTalk client identity, not globally to a room.

### Phase 3: JSONL Adapter

Wrapped Codex CLI output as normalized runner events and mapped text, commands, file changes, usage, errors, and final results. Parser tests covered malformed and partial output.

### Phase 4: Startup Gate

The backend remained rejected unless its feature/config gate, executable, artifact metadata, and auth prerequisites were all valid. This prevented a UI choice from enabling an incomplete runtime.

### Phase 5: Unified Artifact

Placed both CLI skeletons and their exact versions in the same Code Agent engine template, with private home directories and backend-specific startup commands. Local Docker and real subscription smoke tests passed; the plan required an authenticated E2B build/smoke before production use.

### Phase 6: Session Service Wiring

`CodeAgentSessionService` selected the backend, materialized encrypted Codex auth as a sandbox secret file, invoked the wrapper, streamed normalized events, collected refreshed auth, and cleaned the secret directory. Permission and room checks remained backend-neutral.

### Phase 7: Rollout

The proposed rollout sequence was disabled-by-default, internal account, selected rooms, monitored canary, and then broader availability with an immediate backend gate for rollback.

## Validation Contract

- encryption and API redaction tests;
- device-flow state and expiry tests;
- JSONL parser and terminal-result tests;
- sandbox secret-file permissions and cleanup tests;
- real CLI subscription smoke in Docker and E2B;
- RoomTalk turn, reconnect, interruption, and multi-client isolation tests;
- artifact metadata and production-pin verification.

## Superseding Direction

The production direction is now `codex-app-server`. The `codex` backend and `roomtalk_code_agent_runner.codex_cli` remain only for explicit compatibility or migration work. New protocol, UI, concurrency, and recovery capabilities must follow app-server semantics and must not restore CLI-era client-wide turn locks.

Current references:

- [Code Agent Runtime Architecture](code-agent-runtime-architecture.md)
- [Code Agent Sandbox Artifact](code-agent-sandbox-artifact.md)
- [Codex App-Server Integration Progress](code-agent-app-server-integration-progress.md)
