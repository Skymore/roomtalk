# A2UI Streaming Rendering Integration Record

[中文](a2ui-streaming-implementation.zh.md)

Status: Important implementation retrospective
Reviewed: 2026-07-12

## Goal

Integrate A2UI into the existing AI message stream so a model can push structured UI updates through tool/function calls before `ai_stream_end`, rather than hydrating one final JSON blob after text completion.

## Design Decisions

- A2UI is a structured payload on the ordinary durable AI message, not a second unsynchronized message system.
- Provider-specific streaming shapes are normalized into one A2UI tool contract.
- Every update is validated against the supported A2UI v0.9 schema and catalog; malformed model output is rejected or repaired only through explicit compatibility aliases.
- The browser can render incremental updates, while the final normalized payload is persisted so refresh/rejoin produces the same UI.
- Follow-up actions are opt-in through `context.followUp`; arbitrary A2UI actions do not silently send new model turns.
- Derived display values are recomputed from source data rather than trusting stale model-generated summaries.

## Event Flow

```text
provider stream
  -> OpenAI-compatible tool-call delta or Anthropic tool_use block
  -> normalize/repair/validate A2UI messages
  -> emit incremental A2UI socket update
  -> render/update the current streaming AI message
  -> persist final ui_payload with the completed message
  -> hydrate the same surface after reload/history read
```

Text and structured UI can coexist. A2UI updates do not create duplicate AI placeholders and do not bypass final message persistence.

## Key Implementation Boundaries

- Prompt/tool schema advertises the supported catalog and data-first examples.
- Provider adapters assemble fragmented tool arguments and surface complete structured calls.
- Server normalization repairs only documented aliases, enforces depth/size/catalog rules, and strips unsafe plumbing.
- Socket events update the active streaming message.
- PostgreSQL reads include `ui_payload`; this was a critical persistence fix because streaming UI initially appeared live but disappeared after room reload.
- Client rendering uses the official schema and routes only explicitly wired follow-up actions back to AI.

## Demo and Evidence

The local demo role can opt into an automatic “hi” A2UI example; the default assistant does not receive this trigger. The record includes a screenshot under `docs/assets/a2ui-streaming-demo.png` showing the structured surface in the ordinary chat timeline.

## Tests

- Valid message arrays and wrapper shapes.
- Official v0.9 component catalog coverage and examples.
- Compatibility alias repair and malformed-output rejection.
- OpenAI-compatible and Anthropic streaming updates before stream end.
- Persistence/hydration through PostgreSQL message reads.
- Follow-up opt-in, context sanitization, derived-value recomputation, and payload bounds.
- No automatic demo behavior for ordinary roles.

## Lessons

Structured streaming is an end-to-end contract: provider fragments, server validation, socket ordering, durable schema/select columns, and client hydration must all agree. A live UI that is not present in durable history is a correctness bug, not a minor reload issue.
