# RoomTalk Client

[中文](README.zh.md)

Status: Current package guide
Updated: 2026-07-12

React + TypeScript + Vite frontend for RoomTalk. The app handles room discovery, realtime chat, AI streaming, media uploads, stickers, saved rooms, settings, and mobile/desktop layouts.

## Structure

- `src/components/`: shared UI and chat components.
- `src/hooks/`: stateful room, media, sticker, AI, and gesture hooks.
- `src/pages/`: page-level orchestration, mainly `MessagePage`.
- `src/utils/`: socket wrappers, API helpers, i18n, local persistence, and domain helpers.
- `public/`: PWA manifest, service worker, and static brand assets.
- `e2e/`: Playwright user-flow coverage.

## Commands

```bash
npm install
npm run dev                 # Vite dev server
npm test                    # Vitest unit/component tests
npm run lint                # ESLint
npm run build               # i18n check + TypeScript + Vite build
E2E_DATABASE_URL="postgres://localhost/message_system_e2e" npm run test:e2e
E2E_DATABASE_URL="postgres://localhost/message_system_e2e" npm run test:e2e:postgres
```

The E2E database must be disposable and its name must contain `test` or `e2e`
as a separated token. The harness rejects unsafe PostgreSQL and Redis reset
targets.

Development reads `VITE_SOCKET_URL` from `.env.development` and defaults to the local server on `http://localhost:3012`. Production uses `.env.production` with same-origin Socket.IO/API routing.
