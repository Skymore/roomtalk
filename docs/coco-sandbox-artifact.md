# Coco Sandbox Artifact

## Purpose

RoomTalk runs the existing Coco coding assistant inside a file/process sandbox. The production sandbox must use a pinned artifact rather than the developer workstation path.

This artifact contains:

- the pinned Coco source checkout
- the `roomtalk_coco_runner` JSONL adapter
- hash-verified Python runtime dependencies installed into the image
- the startup command `python -m roomtalk_coco_runner`

## Locked Version

The current lock file is:

```text
ops/coco-sandbox/artifact.lock.json
```

Pinned values:

```text
artifactVersion: roomtalk-coco-2026-06-28-a4e70e6
cocoSourceRepo: https://github.com/Venti0325/Coco.git
cocoSourceRef: a4e70e674e46d59a63874371276f5fec0fcd3f41
cocoPackageVersion: 0.1.3a0
runnerPackageVersion: 0.1.0
pythonVersion: 3.12
baseImage: python:3.12-slim-bookworm@sha256:42ada43c4265e1ed6db62ad8df62af99a4abb9a9d49622032522ac76efb0bcef
requirementsLock: ops/coco-sandbox/requirements.lock
```

## Build Context

Prepare a clean Docker/E2B build context from the pinned remote Coco commit:

```bash
node scripts/coco/prepare-sandbox-context.mjs --output /tmp/roomtalk-coco-sandbox-context
```

By default, the script fetches `cocoSourceRef` from `cocoSourceRepo`, verifies that the fetched commit exactly matches the pinned commit SHA, and exports that source tree into the build context. This keeps artifact builds independent of a developer workstation checkout.

For development-only testing, a local checkout can still be supplied with `--coco-repo <path>` or `COCO_LOCAL_PATH=<path>`. In that override mode, the script verifies that the local checkout's `HEAD` exactly matches the pinned Coco commit before exporting it.

The output directory is intentionally restricted to `/tmp` or `/private/tmp` unless `ROOMTALK_ALLOW_ARTIFACT_OUTPUT_OUTSIDE_TMP=true` is set. This prevents accidental recursive deletion of a project directory.

The context contains:

```text
Dockerfile
artifact.lock.json
BUILD-METADATA.json
requirements.lock
coco/
roomtalk_coco_runner/
```

Build the container image from that context:

```bash
docker build -t roomtalk-coco:roomtalk-coco-2026-06-28-a4e70e6 /tmp/roomtalk-coco-sandbox-context
```

Publish that image as the E2B template named by `COCO_E2B_TEMPLATE_ID`.

For the Codex dual-CLI template, use the helper so the build context, E2B create command, and optional publish step stay consistent:

```bash
node scripts/coco/build-e2b-template.mjs \
  --clean \
  --template roomtalk-coco-2026-07-04-dual-cli-candidate \
  --publish
```

The helper defaults the template name from `COCO_E2B_TEMPLATE_ID` or `ops/coco-sandbox/artifact.lock.json`'s `artifactVersion`. Use `--dry-run` to print the `prepare-sandbox-context`, `npx --yes @e2b/cli template create`, and `npx --yes @e2b/cli template publish` commands without requiring E2B auth. For interactive login, run `e2b auth login` if the CLI is installed globally, or `npm exec --yes @e2b/cli -- auth login`; `npx e2b ...` resolves to the SDK package and has no executable.

The Dockerfile installs Python dependencies from `requirements.lock` with `--require-hashes`, then loads the pinned Coco and `roomtalk_coco_runner` source trees through `PYTHONPATH`. This avoids implicit build-isolation downloads for local source packages. The base image is pinned by digest and the container runs as the non-root `roomtalk` user. RoomTalk also passes `PYTHONPATH=/opt/coco/src:/opt/roomtalk_coco_runner` explicitly when starting the E2B command, because E2B command-level envs do not reliably inherit image-level `ENV` values.

## Production Config

Production E2B JSONL mode must use the pinned artifact and must not pass `COCO_SOURCE_DIR`:

```bash
COCO_ENABLED=true
COCO_SANDBOX_PROVIDER=e2b
COCO_RUNNER_CLIENT=jsonl
COCO_MODE=plan
COCO_E2B_TEMPLATE_ID=roomtalk-coco-2026-06-28-a4e70e6
E2B_API_KEY=...
COCO_ARTIFACT_MODE=production
COCO_ARTIFACT_VERSION=roomtalk-coco-2026-06-28-a4e70e6
COCO_SOURCE_REF=a4e70e674e46d59a63874371276f5fec0fcd3f41
# Optional, only for custom image layouts:
# COCO_RUNNER_PYTHONPATH=/opt/coco/src:/opt/roomtalk_coco_runner
```

RoomTalk validates these values at startup. If production E2B JSONL mode is enabled without `COCO_ARTIFACT_VERSION` and `COCO_SOURCE_REF`, or if it tries to use `COCO_SOURCE_DIR`, startup fails.

## Development Config

Local smoke work may mount the developer Coco checkout, but only in development artifact mode:

```bash
COCO_ENABLED=true
COCO_SANDBOX_PROVIDER=e2b
COCO_RUNNER_CLIENT=jsonl
COCO_MODE=plan
COCO_ARTIFACT_MODE=development
COCO_E2B_TEMPLATE_ID=roomtalk-coco-dev
E2B_API_KEY=...
COCO_SOURCE_DIR=/Users/sky/projects/coco/src
```

This is intentionally not accepted as production config.

## Acceptance

- Artifact build instructions are documented here.
- Artifact version, Coco source repository, and Coco source commit are pinned in `ops/coco-sandbox/artifact.lock.json`.
- Python dependencies are pinned and hash-verified in `ops/coco-sandbox/requirements.lock`.
- `server/roomtalk_coco_runner` has package metadata and is loaded from a fixed source tree in the artifact.
- Production E2B JSONL startup requires pinned artifact metadata.
- E2B JSONL startup requires either `E2B_API_KEY` or `E2B_ACCESS_TOKEN`.
- Development mode is the only mode allowed to use the local Coco source path.
- Real sandbox smoke is available through `cd server && npm run smoke:coco:e2b`; the script loads `server/.env`, skips unless `RUN_COCO_E2B_SMOKE=true`, and then requires E2B/model credentials.
- To run the real smoke with credentials already stored in `server/.env`, use `cd server && RUN_COCO_E2B_SMOKE=true npm run smoke:coco:e2b`.
- Codex dual-CLI sandbox smoke is available through `cd server && npm run smoke:codex:e2b`; it skips unless `RUN_CODEX_E2B_SMOKE=true`, then requires E2B credentials, a dual-CLI template, and `CODEX_E2B_SMOKE_AUTH_JSON_PATH` or `~/.codex/auth.json`.
- 2026-06-26 validation confirmed the real E2B smoke creates a sandbox, streams JSONL runner events, completes with `deepseek-v4-pro`, and cleans up the sandbox.
