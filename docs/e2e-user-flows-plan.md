# E2E User Flows Plan

## Goal

Build browser-level regression coverage for the user flows that must not break in production. The E2E suite complements the existing unit, component, API, and socket tests; it is not a replacement for them.

The E2E suite must catch failures where the UI looks correct but a real user cannot complete a task, such as a room card that renders but does not open, a modal that closes itself, socket events that do not update the page, or an AI stream that finishes without showing metadata.

## Test Strategy

- Use Playwright for real browser tests.
- Start a real backend and real frontend for E2E runs.
- Use an isolated Redis database for E2E data.
- Generate unique room names and client IDs per test to keep tests independent.
- Add a guarded E2E AI test provider so AI flows do not call real external APIs.
- Keep E2E tests focused on user-observable outcomes instead of implementation details.

## Stage 1: E2E Harness

### Scope

- Add Playwright configuration and scripts.
- Start backend and frontend through Playwright `webServer`.
- Configure E2E-specific ports and Redis DB.
- Add shared helpers for pages, room creation, and common selectors.
- Add a guarded backend test mode for deterministic AI responses.

### Acceptance Criteria

- `npm run test:e2e` runs from `client-heroui`.
- Playwright starts both app servers automatically.
- E2E tests use isolated test data and do not require real AI provider keys.
- Existing client lint, client unit tests, client build, server tests, and server build still pass.

## Stage 2: Batch 1 - Core Room And Message Flows

### Scope

1. Room card navigation:
   - Load Home with existing rooms.
   - Click a room card.
   - Verify the chat room view opens.

2. Create room:
   - Open Create Room.
   - Enter a name.
   - Create the room.
   - Verify the app enters that room.

3. Join room by ID:
   - Create a room through one browser context.
   - Join it from another context using the room ID field.
   - Verify the second context enters the room.

4. Send message:
   - Enter a room.
   - Type a message.
   - Send it.
   - Verify the message appears in the chat.

5. Edit and delete message:
   - Send a message.
   - Edit it and save.
   - Verify updated content appears.
   - Delete it.
   - Verify it disappears.

6. Clear chat:
   - Send messages.
   - Clear room messages.
   - Verify the list is cleared.

### Acceptance Criteria

- Tests cover the full UI path, not only component calls.
- Tests fail if room card clicks stop navigating.
- Tests fail if message edit/delete/clear socket updates stop changing the UI.
- Tests are deterministic and can run repeatedly against the isolated Redis DB.

## Stage 3: Batch 2 - AI, Media, Sharing, And Reconnection Flows

### Scope

1. Premium model confirmation:
   - Open AI settings.
   - Select a premium GPT/Claude/Gemini model.
   - Confirm pricing step.
   - Confirm final switch step.
   - Verify the selected model changes.

2. AI streaming and metadata:
   - Send a user prompt.
   - Ask AI using the guarded E2E AI provider.
   - Verify streaming content appears.
   - Verify stream end shows model metadata, cost, and cache hit rate.

3. AI retry:
   - Complete an AI response.
   - Trigger retry.
   - Verify the old AI response is replaced by a new response.

4. Edit and ask AI:
   - Edit a user message.
   - Save and ask AI.
   - Verify following history is truncated and a new AI answer appears.

5. Image upload:
   - Upload a generated small image.
   - Send it.
   - Verify the image renders in the message list.

6. Share link confirmation:
   - Open a URL with `?room=<id>` from a fresh context.
   - Confirm joining the room.
   - Verify the chat view opens.

7. Reconnection or visibility refresh:
   - Enter a room.
   - Simulate page visibility returning.
   - Verify the app refreshes messages without losing the active room.

8. Mobile core path:
   - Use a mobile viewport.
   - Create or open a room.
   - Send a message.
   - Verify controls remain usable.

### Acceptance Criteria

- AI tests do not call real model APIs.
- Tests fail if premium model double-confirmation is bypassed or stuck.
- Tests fail if AI stream content appears without completion metadata.
- Tests fail if uploaded images do not render.
- Tests fail if share-link joining does not reach chat view.
- Mobile test verifies core controls are tappable in a constrained viewport.

## Stage 4: CI And Deployment Integration

### Scope

- Keep E2E as an explicit script first.
- Add documentation for local E2E execution.
- Optionally wire E2E into CI after local stability is confirmed.

### Local Execution

Run E2E from the client package:

```bash
cd client-heroui
npx playwright install chromium
npm run test:e2e
```

The Playwright config starts the backend and frontend automatically. The backend uses `redis://127.0.0.1:6379/15`, enables `E2E_TEST_MODE=true`, and uses `E2E_FAKE_AI=true`, so E2E runs do not call real AI providers. The reset endpoint flushes only the selected Redis DB.

Optional overrides:

```bash
E2E_CLIENT_PORT=3311 E2E_SERVER_PORT=3312 npm run test:e2e
```

### Acceptance Criteria

- `npm run test:e2e` is documented.
- All existing checks still pass.
- E2E suite passes locally before merge to deployment branch.

## Commit Plan

1. `test(e2e): document user flow coverage plan`
2. `test(e2e): add playwright harness`
3. `test(e2e): cover room and message flows`
4. `test(e2e): cover ai media sharing flows`
5. `test(e2e): document execution and verify suite`

## Final Delivery Criteria

- Plan document exists and matches implemented tests.
- Both E2E batches are implemented.
- All acceptance criteria are met.
- Client lint passes.
- Client unit/component tests pass.
- Client build passes.
- Server tests pass.
- Server build passes.
- E2E tests pass.
- Changes are committed in logical batches on `dev`.
- `dev` is pushed.
- Deployment branch is fast-forwarded and pushed after validation.
