# GitHub Connector Research and Implementation Recommendation

[中文](github-connector-research.zh.md)

Status: PAT + agent-shell MVP implemented; GitHub App remains the long-term direction
Reviewed: 2026-07-12

## Current Product Decision

Ship the smallest useful path first: each user may connect a GitHub personal access token. RoomTalk validates the token, stores only encrypted material, returns a safe account summary, and materializes turn-scoped secret files for that user's authorized agent run. `gh` and HTTPS Git operate inside the E2B sandbox without placing the PAT in prompts or browser state.

This MVP fits the current product because:

- user identity and room authorization already exist;
- agents already have a controlled shell in a per-room sandbox;
- branch/commit/PR workflows are naturally available through `gh` and Git;
- RoomTalk does not need to reimplement the GitHub API surface;
- the encrypted-connection pattern already exists for Codex auth.

The tradeoff is that PAT scope, rotation, expiry, and organization policy remain user-managed.

## Long-Term Direction: GitHub App

A GitHub App is preferable for a mature connector because installations provide repository/org-level consent, short-lived installation tokens, auditable permissions, centralized revocation, webhook identity, and better enterprise policy fit.

It requires more product/infrastructure work:

- app registration and private-key management;
- installation/callback state and account linking;
- repository selection and permission UX;
- installation-token minting and refresh;
- webhook verification, delivery storage, retry, and deduplication;
- organization/enterprise approval handling.

The MVP should not pretend a PAT is equivalent to this model.

## Recommended Authorization Experience

### MVP

1. User opens their personal GitHub connection settings.
2. UI explains required PAT type/scope and that the token is used only for their turns.
3. Server validates with GitHub and records a safe account summary.
4. Raw token is encrypted at rest and never returned.
5. Each authorized turn receives a secret token path and Git configuration.
6. Disconnect deletes the connection and prevents future materialization.

### GitHub App

1. User chooses Connect GitHub.
2. RoomTalk redirects to installation/authorization.
3. Callback binds installation/account/repository access to the RoomTalk user.
4. UI displays selected repositories and permissions.
5. Each turn mints a short-lived installation token for the selected repository.

## Permission Guidance

Start least-privilege:

- metadata read;
- contents read for inspection/clone;
- contents write only for explicit branch/commit workflows;
- pull request read/write when PR creation/review is enabled;
- issues/actions/checks only when a concrete feature requires them.

Room membership does not grant use of another member's GitHub connection. The requesting user and repository action must be explicit.

## Agent Tool Surface

Prefer standard tools already understood by coding agents:

- `gh repo view`, `gh pr view/list/create`, `gh issue view/list`;
- `git clone/fetch/branch/status/diff/commit/push` over HTTPS;
- bounded RoomTalk prompts/capabilities for selecting the intended repository and operation.

Do not expose raw PAT text or build a broad generic GitHub proxy before there is a product need. High-impact actions such as force push, default-branch mutation, secret changes, workflow dispatch, merge, release, or destructive repository settings need explicit authorization boundaries.

## RoomTalk Architecture

- Connection routes authenticate the RoomTalk client and never trust a browser-supplied account summary.
- GitHub validates the PAT/app token; RoomTalk encrypts raw material with a dedicated/reused configured key.
- PostgreSQL/Redis connection stores persist versioned encrypted records.
- Session service loads only the current user's connection after room/mode authorization.
- Sandbox service writes token and Git-config files under a protected secret root outside the workspace.
- Runner passes paths/minimal environment, not token content, to the backend.
- Cleanup removes files after the turn; logs/prompts/tool previews redact credential-shaped values.

## Sandbox Boundary

The sandbox is untrusted relative to RoomTalk infrastructure but necessarily receives a usable GitHub credential for the authorized operation. Limit blast radius with least-privilege tokens, short lifetimes where possible, repository selection, per-user isolation, no host credential forwarding, bounded logs, and explicit mode/approval policy.

## Existing Implementations

- GitHub's official MCP server offers a broad structured tool surface but adds another server/tool-lifecycle boundary. It can be reconsidered when structured operations beat `gh`/Git for a concrete workflow.
- `@octokit/app` is appropriate for installation-token and webhook implementation.
- Probot can accelerate webhook/event apps but may be heavier than the existing Express control plane needs.
- Nango can externalize OAuth/connection management but introduces another trust/dependency boundary.

## Phases

1. **PAT + read shell:** account validation, encrypted storage, status/disconnect, `gh`/Git read workflows.
2. **Branch + PR:** explicit write mode/approval, push a non-default branch, create/update PR, record safe results.
3. **Trusted Git transport:** stronger repository selection, token scoping/rotation, audit events, organization policy.
4. **GitHub App / connector platform:** installation tokens, webhooks, connector abstraction if multiple external systems justify it.

## Main Lesson

The connector is primarily an identity, authorization, and credential-lifecycle design. The GitHub API call itself is the easy part.
