# Code Agent Sandbox Artifact

## Purpose

RoomTalk runs the existing Code Agent coding assistant inside a file/process sandbox. The production sandbox must use a pinned artifact rather than the developer workstation path.

This artifact contains:

- the pinned Code Agent source checkout
- the `roomtalk_code_agent_runner` JSONL adapter
- hash-verified Python runtime dependencies installed into the image
- the startup command `python -m roomtalk_code_agent_runner`

## Locked Version

The current lock file is:

```text
ops/code-agent-sandbox/artifact.lock.json
```

Pinned values:

```text
artifactVersion: roomtalk-code-agent-2026-07-05-naming-v7
codeAgentEngineSourceRepo: https://github.com/Venti0325/Coco.git
codeAgentEngineSourceRef: a4e70e674e46d59a63874371276f5fec0fcd3f41
codeAgentEnginePackageVersion: 0.1.3a0
runnerPackageVersion: 0.1.9
pythonVersion: 3.12
baseImage: python:3.12-slim-bookworm@sha256:42ada43c4265e1ed6db62ad8df62af99a4abb9a9d49622032522ac76efb0bcef
requirementsLock: ops/code-agent-sandbox/requirements.lock
```

## Build Context

Prepare a clean Docker/E2B build context from the pinned remote Code Agent commit:

```bash
node scripts/code-agent/prepare-sandbox-context.mjs --output /tmp/roomtalk-code-agent-sandbox-context
```

By default, the script fetches `codeAgentEngineSourceRef` from `codeAgentEngineSourceRepo`, verifies that the fetched commit exactly matches the pinned commit SHA, and exports that source tree into the build context. This keeps artifact builds independent of a developer workstation checkout.

For development-only testing, a local checkout can still be supplied with `--engine-repo <path>` or `CODE_AGENT_ENGINE_LOCAL_PATH=<path>`. In that override mode, the script verifies that the local checkout's `HEAD` exactly matches the pinned Code Agent commit before exporting it.

The output directory is intentionally restricted to `/tmp` or `/private/tmp` unless `ROOMTALK_ALLOW_ARTIFACT_OUTPUT_OUTSIDE_TMP=true` is set. This prevents accidental recursive deletion of a project directory.

The context contains:

```text
Dockerfile
artifact.lock.json
BUILD-METADATA.json
requirements.lock
code-agent-engine/
roomtalk_code_agent_runner/
```

Build the container image from that context:

```bash
docker build -t roomtalk-code-agent:roomtalk-code-agent-2026-06-28-a4e70e6 /tmp/roomtalk-code-agent-sandbox-context
```

Publish that image as the E2B template named by `CODE_AGENT_E2B_TEMPLATE_ID`.

For the Codex dual-CLI template, use the helper so the build context, E2B create command, and optional publish step stay consistent:

```bash
node scripts/code-agent/build-e2b-template.mjs \
  --clean \
  --template roomtalk-code-agent-2026-07-04-dual-cli-candidate \
  --publish
```

The helper defaults the template name from `CODE_AGENT_E2B_TEMPLATE_ID` or `ops/code-agent-sandbox/artifact.lock.json`'s `artifactVersion`. Use `--dry-run` to print the `prepare-sandbox-context`, `npx --yes @e2b/cli template create`, and `npx --yes @e2b/cli template publish` commands without requiring E2B auth. For interactive login, run `e2b auth login` if the CLI is installed globally, or `npm exec --yes @e2b/cli -- auth login`; `npx e2b ...` resolves to the SDK package and has no executable.

The Dockerfile installs Python dependencies from `requirements.lock` with `--require-hashes`, then loads the pinned Code Agent and `roomtalk_code_agent_runner` source trees through `PYTHONPATH`. This avoids implicit build-isolation downloads for local source packages. The base image is pinned by digest and the container runs as the non-root `roomtalk` user. RoomTalk also passes `PYTHONPATH=/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner` explicitly when starting the E2B command, because E2B command-level envs do not reliably inherit image-level `ENV` values.

## Production Config

Production E2B JSONL mode must use the pinned artifact and must not pass `CODE_AGENT_SOURCE_DIR`:

```bash
CODE_AGENT_ENABLED=true
CODE_AGENT_SANDBOX_PROVIDER=e2b
CODE_AGENT_RUNNER_CLIENT=jsonl
CODE_AGENT_MODE=plan
CODE_AGENT_E2B_TEMPLATE_ID=roomtalk-code-agent-2026-07-05-naming-v7
E2B_API_KEY=...
CODE_AGENT_ARTIFACT_MODE=production
CODE_AGENT_ARTIFACT_VERSION=roomtalk-code-agent-2026-07-05-naming-v7
CODE_AGENT_SOURCE_REF=a4e70e674e46d59a63874371276f5fec0fcd3f41
# Optional, only for custom image layouts:
# CODE_AGENT_RUNNER_PYTHONPATH=/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner
```

RoomTalk validates these values at startup. If production E2B JSONL mode is enabled without `CODE_AGENT_ARTIFACT_VERSION` and `CODE_AGENT_SOURCE_REF`, or if it tries to use `CODE_AGENT_SOURCE_DIR`, startup fails.

## Development Config

Local smoke work may mount the developer Code Agent checkout, but only in development artifact mode:

```bash
CODE_AGENT_ENABLED=true
CODE_AGENT_SANDBOX_PROVIDER=e2b
CODE_AGENT_RUNNER_CLIENT=jsonl
CODE_AGENT_MODE=plan
CODE_AGENT_ARTIFACT_MODE=development
CODE_AGENT_E2B_TEMPLATE_ID=roomtalk-code-agent-dev
E2B_API_KEY=...
CODE_AGENT_SOURCE_DIR=/Users/sky/projects/code-agent-engine/src
```

This is intentionally not accepted as production config.

## Acceptance

- Artifact build instructions are documented here.
- Artifact version, Code Agent engine source repository, and Code Agent engine source commit are pinned in `ops/code-agent-sandbox/artifact.lock.json`.
- Python dependencies are pinned and hash-verified in `ops/code-agent-sandbox/requirements.lock`.
- `server/roomtalk_code_agent_runner` has package metadata and is loaded from a fixed source tree in the artifact.
- Production E2B JSONL startup requires pinned artifact metadata.
- E2B JSONL startup requires either `E2B_API_KEY` or `E2B_ACCESS_TOKEN`.
- Development mode is the only mode allowed to use the local Code Agent source path.
- Real sandbox smoke is available through `cd server && npm run smoke:code-agent:e2b`; the script loads `server/.env`, skips unless `RUN_CODE_AGENT_E2B_SMOKE=true`, and then requires E2B/model credentials.
- To run the real smoke with credentials already stored in `server/.env`, use `cd server && RUN_CODE_AGENT_E2B_SMOKE=true npm run smoke:code-agent:e2b`.
- Codex dual-CLI sandbox smoke is available through `cd server && npm run smoke:codex:e2b`; it skips unless `RUN_CODEX_E2B_SMOKE=true`, then requires E2B credentials, a dual-CLI template, and `CODEX_E2B_SMOKE_AUTH_JSON_PATH` or `~/.codex/auth.json`.
- 2026-06-26 validation confirmed the real E2B smoke creates a sandbox, streams JSONL runner events, completes with `deepseek-v4-pro`, and cleans up the sandbox.
