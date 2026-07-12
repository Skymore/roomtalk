# Code Agent Static Publish Requirements

[中文](code-agent-static-publish-requirements.zh.md)

Status: Historical requirements; current behavior is in the implementation document
Reviewed: 2026-07-12

Date: 2026-06-30

## Problem

Code Agent can create static pages or small frontend demos inside an E2B sandbox, but sandbox URLs are lifecycle-bound. When the sandbox pauses, is killed, or is recreated, the URL is not a durable public artifact. RoomTalk needs a first-class publish capability so an agent can turn a sandbox-generated static site into a stable RoomTalk-hosted link.

This is a RoomTalk capability exposed to Code Agent as a tool. Code Agent core should only see a normal tool schema; RoomTalk owns authorization, persistence, object storage, and the public serving route.

## Users

- A Code Agent room owner asks the agent to create and publish a static page.
- Code Agent writes or updates files in the sandbox workspace.
- Code Agent calls `PublishStaticSite` with a directory root, entry file, title, and optional slug.
- RoomTalk returns a durable URL that can be shared outside the active sandbox session.

## V1 Scope

- Publish a static site directory from the current Code Agent sandbox workspace.
- Default to `root="."` and `entry="index.html"`, but allow another entry file.
- Store files in RoomTalk object storage under a versioned prefix.
- Maintain a manifest per published slug.
- Serve the latest published version at a stable route such as `/p/:slug/`.
- Return publish metadata to the agent: URL, slug, entry, file count, byte size, and version id.
- Protect the publish API with a per-turn scoped token issued by RoomTalk to the runner.
- Allow overwriting a slug from the same room; reject overwriting another room's slug.
- Keep the feature independent from E2B sandbox lifetime.

## Non-Goals

- Hosting server-side apps, Flask/Node processes, databases, or background jobs.
- Deploying to GitHub Pages, Vercel, Netlify, or custom domains.
- Publishing arbitrary filesystem contents outside the allowed workspace.
- Automatic conversion of an already-running sandbox URL into a hosted static site.
- Version browsing UI or rollback controls.
- Full tenant isolation for arbitrary JavaScript on the primary RoomTalk origin. A dedicated publish host is recommended for production.

## Security Requirements

- The publish API must require a scoped bearer token issued by RoomTalk for one Code Agent turn.
- The token must include room id, client id, turn id, mode, and expiry.
- The publish tool must only be exposed in edit-capable turns.
- File paths must be normalized as relative POSIX paths and must reject traversal, absolute paths, empty paths, and unsafe path segments.
- The runner must deny common secret or private files such as `.env`, keys, certificates, `.git`, `node_modules`, and virtual environments.
- Server-side validation must repeat path, file count, byte size, MIME type, and manifest checks. Runner validation is not trusted.
- Server must set `X-Content-Type-Options: nosniff` and avoid serving unknown files as executable content.
- Serve published artifacts from the configured RoomTalk public base and isolate untrusted content through the serving policy.

## Limits

Initial defaults:

- Maximum files per publish: 100.
- Maximum total payload: 5 MiB decoded bytes.
- Maximum single file: 2 MiB.
- Allowed file types: HTML, CSS, JavaScript, JSON, text, SVG, common images, icons, WASM, fonts.

These limits keep JSONL runner calls and API payloads bounded while covering the intended static demo use case.

## Acceptance Criteria

1. Code Agent can call `PublishStaticSite` after generating a static site in edit mode.
2. The returned URL loads after the E2B sandbox is paused, killed, or replaced.
3. Refreshing the published URL serves the latest manifest for that slug.
4. Publishing a bad path, oversized payload, missing entry file, or secret-like file fails with a clear tool result.
5. A token from one room cannot overwrite another room's slug.
6. Unit tests cover token validation, manifest storage, route serving, path rejection, runner tool policy, and publish tool success/failure.
