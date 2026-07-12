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
npm run test:e2e            # Playwright E2E
npm run test:e2e:postgres   # E2E against PostgreSQL persistence mode
```

Development reads `VITE_SOCKET_URL` from `.env.development` and defaults to the local server on `http://localhost:3012`. Production uses `.env.production` with same-origin Socket.IO/API routing.
