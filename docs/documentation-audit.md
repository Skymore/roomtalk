# Documentation Audit

[中文](documentation-audit.zh.md)

Status: Current documentation inventory
Audit date: 2026-07-13

This audit classifies repository documentation and records quality controls. It does not replace the [documentation index](README.md), current architecture, runbooks, source, or tests.

## Documentation Contract

- Current documents carry an `Updated` or `Verified` date and identify their source of truth.
- Historical plans and retrospectives preserve unique context and evidence when they remain useful. Obsolete current-looking design series may be removed after their valid contract is consolidated into a current reference; Git history remains the archive.
- Human-facing documents have English and Chinese editions with language links. The bilingual interview HTML remains one file.
- `CLAUDE.md`/`AGENTS.md` remain one machine-instruction source; human contribution rules live in bilingual `CONTRIBUTING` files.
- The top-level README presents important technical design directly and links only to deeper evidence or procedures.

## Current Entry Points

| Document | Role |
| --- | --- |
| `README.md` / `README.zh.md` | Product, technical highlights, architecture, local development, persistence, release model, selected retrospectives, and concise navigation. |
| `docs/README.md` / `docs/README.zh.md` | Complete categorized bilingual documentation index. |
| `docs/room-reliability-architecture*.md` | Current room-session ownership, message/media continuity, room-version convergence, acknowledgement, posting-boundary, diagnostics, and backend ordering contract. |
| `docs/code-agent-runtime-architecture*.md` | Current code-agent control/execution plane, lifecycle, security, workspace, recovery, persistence, and release boundaries. |
| `DeploymentGuide.md` / `部署指南.md` | Current GitHub Actions/Fly production runbook. |
| `docs/configuration*.md` | Operator-facing configuration groups and source-of-truth boundaries. |
| `CONTRIBUTING*.md` | Human development, validation, artifact, commit, and release contract. |
| `SECURITY*.md` | Identity, authorization, scoped capabilities, credential, media, and sandbox trust boundaries. |
| `docs/code-agent-sandbox-artifact*.md` | Pinned E2B artifact build/acceptance/release contract. |
| `docs/postgres-rollout-runbook*.md` | Complete `R` to `R+P` cutover procedure and rollback boundary. |

## Current Subsystem References

- room-context CLI and restricted shell;
- sandbox daemon runtime/protocol;
- static publishing implementation;
- code-agent model access;
- PostgreSQL application role;
- legacy media migration;
- media-viewer gesture requirements.

These remain discoverable through the docs index and contextual README/architecture links without being duplicated in every navigation section.

## Engineering Retrospectives

The following are important evidence, not disposable stale docs:

- PostgreSQL production migration;
- code-agent text/tool ordering;
- A2UI streaming;
- mobile viewport and keyboard behavior;
- CI/CD build optimization;
- Codex app-server integration;
- GitHub connector research.

Historical counts, machine sizes, file lines, branch names, and commit IDs are labeled as snapshots. Current operations always defer to current runbooks and code.

## Completed Plans and Reports

Original sandbox phases, backend spikes, workspace UI plans, identity/permission plans, outbox migration, PostgreSQL design/test plans, E2E plans, code reviews, commit reviews, design references, and UI/UX audits remain indexed under Historical Plans or Reports. Their value is the reasoning and review record, not current configuration.

## Corrected Drift in This Pass

- Replaced the generic/manual Fly deployment tutorial with the current scheduled/manual-dispatch GitHub Actions workflow.
- Corrected the production VM declaration to the 1024 MB value in `fly.toml`.
- Separated canonical repository examples from environment-specific browser-origin aliases.
- Made current vs historical status explicit instead of relying on a generic disclaimer.
- Kept key retrospectives visible from the README.
- Added bilingual configuration, contribution, security, architecture, runbook, subsystem, retrospective, plan, and report editions.
- Retained the historical `sandbox-daemon-plan.md` filename for link stability while labeling it as current runtime documentation.
- Consolidated the Room Session Controller and the still-valid room consistency rules into one bilingual Room Reliability Architecture, then removed the obsolete restore/review series from the current tree.

## Known Product/Protocol Follow-Ups

- Replace room socket string/regex error handling with stable error codes, especially `ROOM_NOT_FOUND`.
- Complete automated media-viewer coverage for pinch, zoomed-image swipe suppression, edge resistance, velocity-only commits, keyboard controls, and single-tap delay.

These are product/test follow-ups, not reasons to mark the documentation incomplete.

## Validation Requirements

- Every index link resolves.
- Every human document has the expected language counterpart or is explicitly single-file bilingual.
- English/Chinese current documents agree on status, date, commands, environment names, and architecture facts.
- Package commands, `fly.toml`, workflow triggers, artifact lock values, and source identifiers referenced by docs match repository state.
- Markdown/HTML parses and `git diff --check` succeeds.

## Earlier Audit Record (2026-06-18)

The earlier pass found and resolved CI secret validation, legacy media-table duplication, missing tracked Agent instructions, a broken media-migration package entrypoint, and accidental local Claude settings scope. It also verified media environment renames, i18n language coverage, the unified `media` message type, provider descriptions, PostgreSQL CA handling, and Redis/PostgreSQL smoke/E2E coverage as they existed at that time.

Those findings are retained as a dated report; current verification is recorded above.
