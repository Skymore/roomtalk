# RoomTalk Security

[中文](SECURITY.zh.md)

Status: Current
Updated: 2026-07-20

## Trust Boundaries

RoomTalk separates a trusted control plane from untrusted execution:

- The Node control plane owns identity, room authorization, durable records, scoped capability issuance, object metadata, and sandbox lifecycle.
- PostgreSQL or Redis owns durable application facts; Redis also owns realtime coordination and bounded cache state.
- E2B sandboxes own mutable workspace files, processes, PTYs, dev servers, and agent execution. Sandbox output is untrusted.
- Coco and Codex own their reasoning/tool loops but receive only the capabilities needed for the current turn.
- The browser receives public state and user-authorized signed URLs, never infrastructure credentials.

## Identity and Room Authorization

Room access combines client identity, optional password/token authentication, Google-linked accounts, durable room membership, and owner/admin/member roles. Code-agent access is a separate room policy and defaults to owner-only. Every HTTP/socket workspace read, mutation, PTY, preview, artifact, and agent action must recheck access; possession of an old token or URL is not permanent authorization.

## Scoped Capabilities

RoomTalk issues short-lived, purpose-specific credentials for model access, room-context reads, static publishing, workspace assets, and Codex auth refresh. Claims bind the operation to the authorized client, room, turn, mode, model, budget, or path as applicable. Plan mode does not receive write/shell capabilities.

## User-Owned Connections

Codex subscription auth and GitHub personal access tokens belong to individual users. RoomTalk encrypts them at rest, never returns raw material to the browser, and materializes secret files only for that user's authorized sandbox turn. Refresh/update paths use version checks and leases to prevent stale concurrent writes. Secret files are removed after use.

## Media and Published Artifacts

Private media bodies live in S3-compatible object storage (SeaweedFS in current production); durable stores hold metadata and object keys. Reads use short-lived signed URLs after room authorization. Upload completion verifies metadata and object existence before creating the durable message. Public static artifacts are validated, versioned, and associated with an existing room; public routes apply bounded paths, MIME handling, and defensive response headers.

## Input and Resource Limits

Server and runner boundaries limit payload bytes, message/context counts, archive sizes, path traversal, file counts, terminal/preview sessions, model requests, usage budgets, sandbox counts, and active/idle lifetimes. Untrusted paths are resolved against canonical workspace roots and checked again after symlink resolution where mutation is possible.

## Secret Handling

- Keep secrets in the platform secret manager or ignored local environment files.
- Never commit `.env`, auth JSON, PATs, provider keys, database URLs, E2B credentials, private certificates, or generated secret files.
- Only browser-safe identifiers may use `VITE_*`.
- Logs and observability payloads must redact message content, tokens, auth material, object signatures, and prompt-sensitive data.

## Reporting

Do not open a public issue containing credentials, private room data, exploit details, or signed URLs. Contact the repository owner privately with the affected boundary, reproduction conditions, and the minimum evidence needed to investigate. Rotate exposed credentials immediately.
