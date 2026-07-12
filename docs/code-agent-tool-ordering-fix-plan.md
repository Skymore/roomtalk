# Code Agent AI/Tool Message Ordering Engineering Record

[中文](code-agent-tool-ordering-fix-plan.zh.md)

Status: Important engineering retrospective; the main design is implemented
Reviewed: 2026-07-12

## Background

Code-agent turns can interleave assistant text, tool calls, tool results, model steps, approvals, and final text. The original integration buffered or replayed some tool events after an engine phase completed. RoomTalk then persisted messages in callback arrival order, while the client sometimes sorted or grouped by timestamps. The visible transcript could therefore differ from the reasoning/tool order that actually occurred.

Typical incorrect output:

```text
assistant text A
assistant text B
tool call 1
tool result 1
tool call 2
tool result 2
```

when the real execution was:

```text
assistant text A
tool call 1
tool result 1
assistant text B
tool call 2
tool result 2
```

This is not a cosmetic sorting problem. Tool outputs provide causal context for later text; changing order changes the meaning and auditability of the turn.

## Root Cause Chain

1. The engine was the earliest layer that knew the true interleaving.
2. Its callback surface exposed text incrementally but summarized/replayed tool activity later in some serial and parallel paths.
3. The RoomTalk runner could only forward the order it received.
4. The Node server persisted callback order, sometimes with close/equal timestamps.
5. Client fallback sorting/grouping could further reorder messages when stable positions were absent.

No later layer could perfectly reconstruct information already lost at the engine boundary.

## Why Replay Existed

Replay was originally useful for compatibility with consumers that expected a completed list of tool events after an engine run. It became incorrect once RoomTalk needed a live, auditable transcript. Keeping both live callbacks and end-of-turn replay also risked duplicates.

The fix therefore required a new ordered source contract while retaining explicit compatibility behavior for older engine versions during artifact rollout.

## Ownership

| Layer | Responsibility |
| --- | --- |
| Coco/agent engine | Emit ordered text/tool/model events at the moment their causal boundary is known |
| RoomTalk Python runner | Map source events to versioned JSONL without buffering/reordering or replay duplication |
| RoomTalk Node | Persist one monotonic position per room/turn event before broadcast; close failed/pending tool calls deterministically |
| Client | Render persisted position/turn grouping; use timestamps only as legacy fallback |

## Chosen Design

Add an ordered engine callback (`on_tool_event` in the original plan) and route serial and parallel tool execution through it. Text and tool boundaries enter one ordered runner stream. The runner uses replay only when the engine does not support the ordered callback; it never emits both.

Target event sequence:

```text
status: runner starting
text_delta*
tool_call
tool_result
text_delta*
tool_call
tool_result
model_step/usage
final | error
turn_released (daemon control)
```

Parallel tool execution preserves source scheduling/completion semantics explicitly. It does not pretend that concurrent operations had one arbitrary timestamp order; stable IDs and emitted completion order remain intact.

## Engine Changes

- Introduce typed ordered tool-event callback data.
- Emit tool call before executing the tool.
- Emit exactly one terminal result/error for every emitted call.
- Cover serial and concurrent tool paths.
- Keep compatibility collection separate from live callback delivery.
- Ensure cancellation/error closes the event structure.

## Runner Changes

- Detect the ordered callback capability.
- Map each call/result immediately into RoomTalk JSONL events.
- Normalize workspace paths and bound result content/previews.
- Do not replay collected events when live delivery was used.
- Emit runner status in a deterministic position before backend output.
- Propagate mapping/handler failures so the owned runner process stops instead of continuing with a corrupt transcript.

## Node and Client Changes

- Persist tool messages with stable turn identity and monotonic position.
- Broadcast only after durable write succeeds.
- Group adjacent tool structures by turn without changing persisted order.
- On error/interruption/finalization, synthesize failed results only for still-open calls.
- Client summaries and workspace activity consume the same canonical sequence.
- Legacy messages without position may use timestamp/index fallback but never rewrite current events.

## Compatibility and Artifact Rollout

The engine and RoomTalk runner live in the pinned E2B artifact. Source changes alone do not fix production. The rollout requires:

1. commit/push engine changes;
2. update RoomTalk engine source ref and runner package/version;
3. bump artifact metadata and build a new E2B template;
4. update production pins;
5. run a real interleaved text/tool smoke;
6. verify existing/paused sandboxes migrate or are replaced as intended.

During mixed rollout, capability detection prevents duplicate live+replay delivery.

## Verification Matrix

- Engine unit tests for serial, parallel, failure, cancellation, and callback absence.
- Runner tests for mapping, chunked JSONL, compatibility fallback, and no duplicates.
- Node session tests for interleaved persistence, handler failure, interruption, and open-tool closure.
- Client tests for canonical position/turn rendering and legacy fallback.
- Real sandbox smoke where text appears both before and after one or more tool calls.

## Historical Data

The fix does not rewrite old transcripts whose true source order was already lost. Historical messages retain their stored order and are treated as legacy evidence. New turns use the canonical ordered protocol.

## Risks

- Double delivery during mixed engine versions.
- Parallel tool semantics accidentally serialized or nondeterministically grouped.
- A terminal event emitted before pending persistence completes.
- Client code continuing to sort by timestamp.
- Production sandboxes remaining on the old artifact after source merge.

## Final Lesson

Ordering belongs to the earliest layer that knows causality. Persistence should make that order durable, and the client should display it—not infer it.
