# CI/CD Build and Fly Deployment Optimization Retrospective

[中文](ci-cd-build-optimization.zh.md)

Status: Important build/release retrospective
Reviewed: 2026-07-12

This record describes the two-stage 2026-07-12 optimization of RoomTalk GitHub Actions, Docker builds, and Fly deployment. Concrete timings are dated baselines; the current workflow and Dockerfile remain authoritative.

## Original Problem

Every scheduled run paid for dependency installation and both application builds even when `master` had not changed or only documentation changed. A broad Docker context invalidated cache unnecessarily, and the runtime image contained more build material than required.

The problem was not only raw build duration. The release chain made it hard to answer:

- Did `master` change since the last successful deployment workflow?
- Did a changed file affect the runtime image?
- Which dependency layer invalidated?
- Did the client or server stage dominate?
- Was the deployed application actually healthy afterward?

## Current Shape

The workflow is scheduled every two hours and supports manual dispatch. A build-gate job compares `master` with the latest successful run:

- manual dispatch builds unconditionally;
- identical SHA skips;
- missing/incomplete/non-linear comparisons build conservatively;
- documentation and other non-runtime paths can skip;
- changes under client, server, Dockerfile, `fly.toml`, workflow, or Docker ignore trigger the production build.

The root Dockerfile uses independent client and server builder stages and a slim runtime stage.

## Key Changes

### Independent stages

Client and server dependency manifests are copied before source so dependency layers survive ordinary source edits. The client stage runs i18n validation, TypeScript, and Vite production build. The server stage runs TypeScript compilation. The runtime copies only compiled/static output and production dependencies.

### Minimal context

`.dockerignore` removes Git internals, local output, caches, node_modules, test artifacts, credentials, and unrelated development material. Context changes therefore correspond more closely to real image inputs.

### Documentation gate

The workflow classifies changed paths before paying for Docker/Fly work. It deliberately falls back to building when GitHub comparison data is unsafe rather than incorrectly skipping a release.

### Secret and health validation

Required Fly/provider/storage/runtime secrets are checked before deployment. After rollout, the public status endpoint verifies online state, PostgreSQL, Redis, and socket-adapter readiness.

## Cache Invalidation Matrix

| Change | Expected invalidation |
| --- | --- |
| README/docs only | Gate skips runtime build |
| Client source | Client source/build layers; server dependency layer remains reusable |
| Client lock/package | Client dependency and later layers |
| Server source | Server source/build layers; client dependency layer remains reusable |
| Server lock/package | Server dependency and later layers |
| Dockerfile / `.dockerignore` | Relevant image layers, often broad |
| `fly.toml` / workflow | Build/deploy path runs conservatively |

## Verification

- Local production client/server builds.
- Docker build with cold and warm cache observations.
- Changed-path gate tests for docs, client, server, workflow, and non-linear comparisons.
- Runtime image startup and `/api/status`.
- GitHub Actions conclusion, Fly machine/image state, and public health.

Current deployment is CI-first. Do not convert this optimization record into instructions to run `fly deploy` manually.

## Regression Diagnosis

When duration regresses, identify the invalidated stage before changing cache settings. Check Docker context size, lockfile churn, base-image movement, dependency install logs, Vite/TypeScript time, GitHub cache availability, Fly upload/deploy time, and whether the gate conservatively rebuilt due to rewritten/non-linear history.

The lasting lesson is to align cache boundaries with ownership boundaries and to make “skip” decisions fail safe.
