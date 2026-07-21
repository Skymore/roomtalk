# Contributing to RoomTalk

[中文](CONTRIBUTING.zh.md)

Status: Current
Updated: 2026-07-20

## Scope

RoomTalk contains a React/Vite client, a Node/Express/Socket.IO control plane, and a Python runner/daemon packaged into pinned E2B artifacts. Make changes at the owning boundary and preserve unrelated work in a dirty checkout.

## Local Development

```bash
cp server/.env.example server/.env
cd server && npm install
cd ../client-heroui && npm install
cd .. && ./start.sh
```

The client listens on `http://localhost:3011`; the server listens on `http://localhost:3012`.

## Validation

Choose checks from the actual failure modes of the diff:

- Documentation/copy only: parsing, link validation, and `git diff --check`.
- Narrow server or client changes: focused tests and the affected package build/typecheck when compilation is relevant.
- Persistence, auth, permissions, ordering, shared contracts, or cross-package changes: expand to the relevant suites and production builds.
- E2E or external-service behavior: run the matching Playwright, persistence, public-edge/Compose, or E2B smoke only when that boundary changed.

Common commands:

```bash
cd server
npm test
npm run build
npm run smoke:persistence

cd ../client-heroui
npm test
npm run lint
npm run check:i18n
npm run build
npm run test:e2e
npm run test:e2e:postgres
```

## Code-Agent Artifact Rule

Production code-agent rooms do not run runner source directly from the RoomTalk application image. Changes to any of the following require a new pinned E2B artifact:

- `server/roomtalk_code_agent_runner/`
- runner tools or system prompts
- `ops/code-agent-sandbox/Dockerfile`
- `ops/code-agent-sandbox/artifact.lock.json`
- dependencies or files copied by `scripts/code-agent/prepare-sandbox-context.mjs`
- the pinned code-agent-engine source ref

For such changes, update source and locks, build the new template, update production pins, and run the real E2B smoke or equivalent direct verification. Source merge alone is not a release.

## Persistence Changes

New runtime durable operations must be represented in the shared store contract and implemented in PostgreSQL first. Keep the legacy Redis implementation aligned only when the import/migration path still requires that operation. PostgreSQL owns durable state and room-event replay; Redis remains rebuildable realtime/cache state. Schema, event emission, retention, migration, rollback, and cache invalidation behavior must be reviewed together.

## Security and Credentials

- Never expose provider, database, E2B, Codex, GitHub, model-gateway, room-context, or publish secrets to browser code or prompts.
- Keep user-owned connections encrypted at rest and materialize them only for the authorized turn.
- Recheck room access on every workspace read, mutation, terminal, preview, and agent entry point.
- Treat paths, archive contents, object keys, uploaded metadata, and socket payloads as untrusted input.

## Commits and Release

Use short present-tense commit subjects. `master` is the release branch. A source push does not deploy the production Mac. Runtime releases use `node scripts/local-production.mjs --profile edge up -d --build` from the intended production checkout, followed by Compose and public-edge verification. The former Fly workflow is disabled and retained only for rollback history. E2B artifact changes still require their independent release contract.

Machine-agent instructions remain in `CLAUDE.md`/`AGENTS.md`; this file is the human contributor contract.
