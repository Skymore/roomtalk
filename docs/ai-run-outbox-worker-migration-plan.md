# AI Run / Outbox / Worker Migration Plan

## Goal

Move RoomTalk AI generation from a socket-handler-owned process to a durable, observable, retryable run model without changing the user-facing streaming experience.

The final production cut should be a single runtime switch after all phases have shipped and been verified in shadow mode.

## Current State

- User and AI messages are durable in the room message history.
- AI placeholder messages are saved before streaming.
- Text chunks are emitted over Socket.IO and are not individually durable.
- Final AI content is saved when the stream completes.
- Startup recovery marks orphaned streaming messages as failed.

This is a reasonable AI-first design. The gap is operational: an AI request is still owned by the socket handler that accepted it, so retries, cancellation, run auditing, and future worker execution do not have a durable task record.

## Target Shape

```text
socket handler
  -> validate access/posting
  -> write user message if needed
  -> write AI placeholder
  -> create assistant_run
  -> create outbox_event
  -> ack client with aiMessageId

worker
  -> claim outbox_event
  -> mark assistant_run running
  -> stream chunks over Socket.IO
  -> save final AI message
  -> mark assistant_run complete/error
  -> mark outbox_event processed/failed
```

Streaming chunks remain low-latency transport events. They are not room history events and do not need per-chunk durable sequencing. The durable facts are the assistant run state and the final AI message.

## Phase 1: Assistant Run State

Add `assistant_runs` with:

- `queued/running/complete/error/cancelled` status.
- model/provider metadata.
- `user_message_id`, `ai_message_id`, retry/edit references.
- timestamps and error text.

Initial rollout records runs from the existing inline socket path. This is low risk because the current execution path remains unchanged.

Acceptance:

- every new AI answer has an `assistant_runs` row;
- run moves to `running`, then `complete` or `error`;
- existing AI streaming behavior is unchanged;
- startup recovery remains authoritative for orphaned streaming messages.

## Phase 2: Durable Outbox

Add `outbox_events` with claim/retry fields:

- `pending/processing/processed/failed` status;
- aggregate/event type;
- JSON payload;
- worker lock fields and retry metadata.

Initial rollout may create processed shadow events for inline runs, or pending events in staging only. The key invariant is that run creation and outbox creation can be done atomically before enabling worker execution.

Acceptance:

- workers can claim events using `FOR UPDATE SKIP LOCKED` in PostgreSQL;
- retryable failures return to `pending` after `available_at`;
- terminal failures remain inspectable;
- Redis mode has functionally equivalent development behavior.

## Phase 3: Worker Execution Behind Flag

Introduce a worker loop that claims `ai.run_requested` events and executes the existing AI stream logic. This is now implemented behind flags; keep the production default on inline execution until the worker path is observed.

Runtime flags:

- `AI_RUNNER_MODE=inline` keeps existing behavior.
- `AI_RUNNER_MODE=worker` makes handlers enqueue runs and lets workers execute them.
- `OUTBOX_WORKER_ENABLED=true` starts the worker loop in the server process.

Acceptance:

- worker mode queues `ask_ai`, `send_message_and_ask_ai`, edit retry, and A2UI follow-up through `ai.run_requested`;
- chunks still stream live;
- final content still overwrites local client content;
- failed runs are visible and retryable;
- switching back to inline mode is configuration-only.

## Final Cutover

1. Deploy code with `AI_RUNNER_MODE=inline`.
2. Verify new tables populate in production.
3. Enable `OUTBOX_WORKER_ENABLED=true` while still inline, verifying no pending-event drift.
4. Switch `AI_RUNNER_MODE=worker` for the in-process worker.
5. Exercise `ask_ai`, `send_message_and_ask_ai`, edit retry, and A2UI follow-up.
6. Observe:
   - run error rate;
   - outbox pending/failed counts;
   - AI stream completion rate;
   - Socket.IO chunk latency;
   - final message persistence.
7. Roll back by setting `AI_RUNNER_MODE=inline`.

## What This Does Not Change

- It does not make AI chunks durable.
- It does not introduce Telegram-style room event sequencing.
- It does not require message queue infrastructure on day one.
- It does not change Postgres as the durable source of room messages.

## Later Work

- Cancel run endpoint.
- Manual retry failed run endpoint.
- Admin/debug view for runs and outbox events.
- Move push notifications and transcription jobs to the same outbox worker pattern.
