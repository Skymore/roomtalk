# Identity, Code-Agent Permissions, and Context Findings

[中文原文](identity-code-agent-permission-plan.md)

Status: Historical investigation and implementation record
Investigation: 2026-06-29
Reviewed: 2026-07-12

## 1. Exposing `userId` / `clientId`

At the time of the investigation, `clientId` served as both an identity credential and a value shown in some member-management UI. Owner/admin actions also asked users to type a target client ID. Knowing that value could allow impersonation, so it was not suitable as a public identifier.

The proposed correction was to expose a non-secret display identifier such as `username#xxxx`, select members through room UI, and keep the full client ID only in authenticated server operations. Lookup endpoints should return display identity and room role, never the credential-bearing identifier.

## 2. Code-Agent Room Access

Code-agent execution has greater impact than ordinary reading, so room membership alone is not enough to describe all policy. The design introduced explicit modes controlling who may view the workspace and who may start a turn: owner-only, owner/admin, members, or public-view with restricted execution, subject to the current room schema.

Every workspace read, mutation, terminal/preview session, and agent turn must re-check current access on the server. UI hiding is convenience, not authorization. Credentials and backend sessions are also scoped to the requesting client even when several users share a room.

## 3. Context-Length Enforcement

The ordinary AI path already bounded room context, while the early code-agent path could assemble transcript history differently. The correction was to share the same configured context-limit decision at the RoomTalk boundary, then convert the bounded transcript for each backend.

UI history remains complete and durable; model context is a selected window. Tool events, system metadata, and current queued inputs require explicit accounting rather than being silently appended outside the limit.

## 4. Member Actions

Promote, demote, remove, and transfer actions should start from a selected member avatar/menu. This removes manual secret-like identifiers, gives the user room-role context, and lets the server receive an authenticated target identity without exposing it as copyable text.

## 5. Plan/Edit Mode Scope

The room may store a default mode, but the effective mode is an execution fact for each turn/message. A user can choose a different mode for a turn if room policy allows it; the server persists the effective value and passes it to the runner.

Key rules:

- the room default controls new-composer initialization, not historical turns;
- an accepted turn keeps its effective mode across reconnect and replay;
- retry uses the original effective mode unless the user explicitly starts a new turn with another allowed mode;
- edit-and-ask creates a new execution decision rather than mutating the audit history;
- queued turns capture their requested mode and are revalidated when materialized;
- plan/read-only mode cannot inherit write tools from a prior edit turn.

## 6. AI Role, Model, and Context Scope

Room-level settings provide defaults. The selected role, model, context limit, backend, and mode used for an actual request belong to that run/turn and should be persisted with it. Changing the room default must not rewrite how old messages are interpreted.

Provider credentials remain server-controlled. A client may select only values allowed by configuration and room policy; a sandbox receives a scoped model-access capability rather than the provider key.

## Runner Investigation Notes

The runner starts as a JSONL process, reads versioned requests from stdin, converts RoomTalk transcript items into backend messages, executes the agent loop, and emits normalized events on stdout. Available tools depend on mode and runtime policy. This separation made it possible to fix context and permissions once at the control-plane boundary while preserving backend-specific conversion.

## Current References

This document records the reasoning that led to the implementation. Current ownership and enforcement are described in:

- [Code Agent Runtime Architecture](code-agent-runtime-architecture.md)
- [Room Context CLI](codex-room-context-cli-design.md)
- [Security](../SECURITY.md)
