# Code Agent Workspace UI Plan

> Status: Phase 1 accepted; Phase 2 queued
> Date: 2026-05-26
> Scope: turn RoomTalk Coco rooms into a code-agent workspace UI, while preparing a future `codeAgentBackend = coco | codex` abstraction.

## Goal

RoomTalk already has ordinary chat rooms and Coco code-agent rooms. Coco rooms currently reuse the chat UI too heavily, so code-agent work appears as a regular message stream instead of a developer workspace.

The goal is to make Coco/code-agent rooms feel like a focused coding-agent GUI:

- prompt composer optimized for coding tasks
- tool timeline and run state
- workspace/file/diff placeholders that can later be backed by real sandbox APIs
- clear plan/read-only vs edit-capable mode
- future backend switch point for Coco and Codex

RoomTalk must keep ownership of rooms, users, permissions, persistence, costs, model selection, E2B sandbox lifecycle, and mobile/desktop shell. Coco or future Codex backends own the agent loop and tool semantics.

## Coco Change Policy

Coco can be changed when the GUI needs a capability that belongs inside the agent runtime, but the browser must never control Coco directly.

Allowed control path:

```text
Browser UI -> RoomTalk API/Socket -> permission and audit checks -> sandbox runner protocol -> Coco Engine
```

Do not expose E2B sandbox credentials, provider keys, raw workspace paths, or a Coco network port to the browser.

Good Coco-side changes:

- real-time `on_tool_result` events
- structured file-tree and diff snapshots
- explicit run cancellation/abort support
- mode-aware system prompts so `plan` mode does not attempt `Write/Edit/Shell`
- structured permission prompts if a future web-safe approval mode is added
- stable session metadata for resume/replay

Bad Coco-side changes:

- browser-to-Coco direct WebSocket/HTTP control
- letting the frontend send arbitrary shell commands around RoomTalk policy
- forwarding long-lived provider keys into a write/Shell-capable sandbox
- making RoomTalk depend on Coco terminal/TUI behavior

## Design Decision

Use T3 Code and Codex as references, not as a directly embedded sub-application.

### Why not embed T3 Code wholesale

- T3 Code is a complete app with its own project, thread, WebSocket, runtime, Git, and terminal assumptions.
- RoomTalk already has room identity, Redis/PostgreSQL persistence, Socket.IO events, E2B sandbox lifecycle, feature flags, model pricing, and mobile navigation.
- Directly embedding T3 Code would create two competing product models inside one UI.

### What to absorb from T3 Code / Codex

- coding-session layout patterns
- tool timeline density
- workspace/status panels
- terminal/output panel structure
- diff/change-list presentation
- permission-mode language
- code-agent backend boundary ideas

### Copy policy

If any source code is copied or closely adapted from T3 Code, the exact files and upstream commit must be recorded in a follow-up attribution section. Until that audit is complete, implementation should use original RoomTalk components inspired by the same product patterns.

## Target Architecture

```mermaid
flowchart LR
  UI["CodeAgentRoomView"] --> MSG["RoomTalk messages/events"]
  UI --> STATE["Derived workspace state"]
  UI --> RUN["Code-agent composer"]
  UI --> CTRL["Workspace controls"]
  RUN --> SOCK["RoomTalk socket ask_ai"]
  CTRL --> SOCK
  SOCK --> SVC["CodeAgentSessionService"]
  SVC --> BACKEND["CodeAgentRunner"]
  BACKEND --> COCO["Coco runner"]
  BACKEND -. future .-> CODEX["Codex runner"]
  COCO --> E2B["Sandbox workspace"]
```

## Proposed Types

Longer term, Coco-specific naming should be hidden behind code-agent abstractions:

```ts
export type CodeAgentBackend = 'coco' | 'codex';
export type CodeAgentMode = 'plan' | 'acceptEdits';

export interface CodeAgentRoomState {
  backend: CodeAgentBackend;
  sandboxStatus: RoomSandboxStatus;
  agentStatus: RoomCocoStatus;
  sessionId?: string;
}

export interface CodeAgentFeatureFlags {
  backend: CodeAgentBackend;
  mode: CodeAgentMode;
}

export interface CodeAgentRunner {
  run(input: CodeAgentRunInput, handlers: CodeAgentEventHandlers): Promise<CodeAgentRunResult>;
}
```

For the first UI phase, persisted room fields may remain `type: 'coco'`, `cocoStatus`, and `cocoSessionId`. The UI can adapt them through a small frontend utility instead of migrating database fields immediately.

The code-agent mode is process-level configuration for now, not room-level data. Phase 1 must expose it through `/api/features` as `coco.mode` and the frontend must read it from feature flags. Do not hard-code plan/read-only text in the UI.

`CodeAgentRunner` intentionally omits `cancel()` for Phase 3. Cancellation remains handled by run-lock rejection, runner process stop, and sandbox destroy. Phase 6 must add an explicit cancel/abort contract before a Codex runner can be implemented.

## Phases

### Phase Status Notes

Phase 1 intentionally derives file/activity summaries from persisted Coco messages. File paths displayed in the workspace panel are normalized for browser display, but deeper workspace API path policy remains a Phase 4 gate because real file-tree and diff APIs do not exist yet.

Phase 1 completion record (2026-05-26):

- Implemented a dedicated `CodeAgentRoomView` and workspace activity summary for Coco rooms.
- Propagated configured Coco mode through `/api/features`, with `plan` as the fail-closed default.
- Added desktop/mobile Coco E2E coverage plus component and feature-flag tests.
- Closed Claude review findings by scoping Coco's working directory per turn, validating `COCO_WORKSPACE_ROOT`, exercising real local Coco file-tool cwd behavior, sanitizing displayed file references, and exposing file-list truncation.
- Verified client unit tests (`73/73`), server unit tests (`197/197`), Python runner tests (`16/16`), frontend/backend builds, Coco desktop E2E (`2/2`), and Coco mobile E2E (`1/1`).
- Claude Code follow-up review: no blockers; Phase 1 may proceed.

### Phase 0: Source Audit And Plan Review

Scope:

- Document this plan.
- Review T3 Code/Codex integration approach with Claude Code.
- Decide what may be copied, adapted, or only referenced.
- Confirm the current UI phase does not require new backend APIs.

Acceptance:

- Plan exists in `docs/code-agent-workspace-ui-plan.md`.
- Claude Code review has no blocking findings, or the plan is updated to address them.
- Any copied third-party code is explicitly deferred until license/attribution audit is done.

Verification:

```bash
claude -p "<plan review prompt>" --permission-mode dontAsk --tools Read,Grep,Glob,Bash --disallowedTools Edit,Write,MultiEdit
```

### Phase 1: Coco Room Workspace Shell

Scope:

- Add `CodeAgentRoomView` for `room.type === 'coco'`.
- Keep `ChatRoomView` unchanged for ordinary rooms.
- Reuse `ChatHeader` and `MessageInput` where practical, but present the center area as a code-agent workspace.
- Add a derived activity summary from existing messages:
  - tool calls
  - tool results
  - failed tools
  - touched file paths from tool args
  - latest tool
- Make plan/read-only mode visible so users understand why `Write` is unavailable.
- Surface plan/read-only mode from `/api/features.coco.mode`; no room field or database migration is allowed in this phase.
- Keep mobile layout single-column and avoid large side panels that overflow the viewport.

Acceptance:

- Chat rooms render exactly through the existing chat path.
- Coco rooms render through `CodeAgentRoomView`.
- Empty Coco rooms show a code-task oriented workspace, not a generic chat empty state.
- Tool calls/results are summarized without requiring new backend APIs.
- The displayed mode matches the server feature flag response (`plan` shows read-only, `acceptEdits` shows edit-capable).
- The user can still send a prompt and ask the agent from Coco rooms.
- Mobile viewport has no horizontal overflow and composer stays reachable.

Verification:

```bash
cd client-heroui && npm test -- --run
cd client-heroui && npm run check:i18n
cd client-heroui && npm run build
cd client-heroui && npm run test:e2e -- e2e/coco-flows.spec.ts
```

Claude gate:

- Review the Phase 1 diff with focus on UI regressions, ordinary chat isolation, mobile overflow, and stale/incorrect Coco status.

### Phase 2: Generic Code-Agent Frontend Model

Scope:

- Add frontend utilities that map a RoomTalk room to a generic code-agent model:
  - `isCodeAgentRoom(room)`
  - `getCodeAgentBackend(room)`
  - `getCodeAgentMode(featureFlags)`
  - `getCodeAgentStatus(room)`
- Keep persisted values unchanged in this phase.
- Rename only UI-level component concepts from Coco-specific to CodeAgent-specific where it reduces future churn.
- Avoid mass renames in server code.

Acceptance:

- UI components that are not Coco-runner specific consume generic code-agent helpers.
- Existing Coco tests still pass.
- No persistence migration is needed; mode remains feature/config data unless a later phase explicitly adds per-room mode.
- Frontend utilities treat `codex` as unreachable until Phase 6 and warn or assert if it appears before backend support exists.

Verification:

```bash
cd client-heroui && npm test -- --run
cd client-heroui && npm run build
```

Claude gate:

- Review whether the abstraction is real and useful, or premature/noisy.

### Phase 3: Backend Runner Abstraction

Scope:

- Introduce a server-side `CodeAgentRunner` boundary above the existing Coco runner.
- Implement `CocoCodeAgentRunner` as the only concrete backend.
- Keep config default to Coco.
- Add `CODE_AGENT_BACKEND=coco` or equivalent alias while preserving existing `COCO_*` config.
- Explicitly reject `codex` until a Codex runner is implemented.

Acceptance:

- No behavior change for current Coco rooms.
- Existing `CocoSessionService` tests either remain valid or are moved behind the new wrapper with equivalent coverage.
- Unsupported backend config fails fast at startup with a clear error.
- Direct model-key safety rules from `docs/coco-model-access.md` remain enforced.

Verification:

```bash
cd server && npm test
cd server && npm run build
python3 -m pytest server/roomtalk_coco_runner/tests
```

Claude gate:

- Review abstraction boundaries, config compatibility, and security regressions.

### Phase 4: Workspace APIs

Scope:

- Add explicit APIs/events for workspace state when the runner can provide them:
  - file tree
  - changed files
  - diff summary
  - command/output history
- Add RoomTalk-mediated controls only when each action has a clear backend policy:
  - refresh workspace snapshot
  - cancel current turn
  - reset sandbox/session
  - request diff
- Until backend support exists, continue deriving UI summaries from messages.
- Do not let RoomTalk implement the agent's file operations itself.
- If Coco needs new hooks, implement them in Coco first and expose them through the JSONL runner protocol.

Acceptance:

- APIs are read-only unless the code-agent mode and model-access contract allow writes.
- Frontend controls call RoomTalk endpoints/events, never Coco or E2B directly.
- Workspace API errors do not break message history rendering.
- Fake runner/E2E can simulate workspace snapshots.
- File path display is sanitized/truncated and tested so sandbox output cannot break layout or leak unintended path details.

Verification:

```bash
cd server && npm test
cd client-heroui && npm test -- --run
cd client-heroui && npm run test:e2e -- e2e/coco-flows.spec.ts
```

Claude gate:

- Review sandbox boundaries and data leakage risks.

### Phase 5: T3 Code UI Absorption

Scope:

- Audit selected T3 Code UI modules and styles.
- Copy/adapt only small, separable UI ideas that match RoomTalk's data model.
- Add attribution if code is copied or closely adapted.
- Keep RoomTalk's app shell and Socket.IO session model.

Acceptance:

- No iframe/sub-app embedding.
- No second WebSocket runtime competing with RoomTalk.
- Imported/adapted code has clear license attribution.
- Any copied or closely adapted T3 Code component must have its upstream file path and commit hash recorded in the attribution section before the Phase 5 commit is merged.
- Bundle impact is measured and acceptable.

Verification:

```bash
cd client-heroui && npm run lint
cd client-heroui && npm run build
cd client-heroui && npm run test:e2e -- e2e/coco-flows.spec.ts
```

Claude gate:

- Review license attribution, dependency creep, and UI maintainability.

### Phase 6: Codex Backend Spike

Scope:

- Investigate Codex app-server/CLI integration as a second backend.
- Do not replace Coco.
- Add a disabled `codex` backend path only if its sandbox/model/key boundaries are clear.

Acceptance:

- `codeAgentBackend = coco | codex` is technically feasible without changing RoomTalk rooms again.
- Codex backend remains disabled unless all security and deployment prerequisites are explicit.

Verification:

```bash
cd server && npm test
cd server && npm run build
```

Claude gate:

- Review whether the Codex integration should proceed, stay as docs, or be dropped.

## UX Requirements

Desktop:

- Preserve the existing RoomTalk sidebar and top room shell.
- Use the main area as a code-agent workspace, not a marketing page.
- Show tool/activity status without card nesting.
- Keep message content readable and code/tool output scannable.

Mobile:

- Single-column layout.
- Bottom composer must remain reachable.
- Tool/workspace panels should collapse into tabs or summary strips.
- No horizontal overflow from tool args, model menus, or file paths.

Accessibility:

- Interactive controls must have labels.
- Keyboard focus must remain visible.
- Tool/error status must not rely on color only.

## Testing Strategy

Unit/component tests:

- Coco/code-agent room selects workspace view.
- Activity summary derives tools/files/errors correctly.
- `summarizeCocoMessages` covers empty messages, missing tool args, duplicate file refs, result errors, and non-file tool calls.
- Chat room path does not render code-agent workspace.
- Read-only/plan mode copy is visible.

## Attribution

No T3 Code source has been copied into this repository as of this plan. If Phase 5 copies or closely adapts upstream code, record:

- upstream repository URL
- upstream commit hash
- source file path
- local target file path
- license notice required by the upstream license

E2E:

- Create Coco room.
- Send a code task.
- See sandbox/tool/activity status.
- Refresh and verify workspace view restores.
- Mobile viewport: composer visible, no horizontal overflow, tool summaries usable.

Regression:

- Existing room flows and message flows still pass.
- Ordinary chat AI controls are unchanged.

## Review Rule

After every implementation phase:

1. Run the phase verification commands.
2. Call Claude Code in read-only mode.
3. Fix blocking/high/medium findings before continuing.
4. Record deferrable findings in the final status for that phase.
5. Commit only when the phase is green.
