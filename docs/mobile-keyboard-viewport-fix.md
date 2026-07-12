# iOS Keyboard Chat-Viewport Misalignment: Fix Record

[中文](mobile-keyboard-viewport-fix.zh.md)

Status: Implemented fix record
Reviewed: 2026-07-12

## Background

On iOS browsers, opening the software keyboard changes the visual viewport without necessarily changing the layout viewport in the same way. A chat layout based on `100vh`, fixed bottom navigation, and browser-managed input scrolling could leave the message list and composer offset, hidden, or larger than the actually visible area.

## User-Visible Symptoms

- Composer moved behind or above the keyboard with an incorrect gap.
- Message list height remained based on the pre-keyboard viewport.
- Bottom navigation competed with the keyboard and consumed visible space.
- Modal and chat layouts reacted differently.
- Focusing an input could trigger automatic page zoom or unwanted browser scroll.

## Layout Preconditions

RoomTalk has a full-height application shell, a scrollable message region, a bottom composer, mobile bottom navigation, and modal overlays. Fixing one element with a hard-coded offset would not keep these surfaces consistent across Safari/Chrome, portrait/landscape, safe areas, and standalone/PWA modes.

## Root Cause

- `100vh` reflected the layout viewport rather than the currently visible keyboard-reduced viewport.
- `position: fixed` elements were laid out against different viewport assumptions.
- Browser focus scrolling and input font sizing could zoom or shift the page.
- Multiple components independently calculated bottom padding.
- Keyboard state was inferred indirectly instead of observing `visualViewport` and focused editable elements.

## Final Fix

### Shared viewport variables

A single visual-viewport observer publishes CSS variables for visible height and offsets. Updates are batched and react to resize, scroll, orientation, focus, blur, and page lifecycle changes. Fallbacks preserve ordinary desktop behavior when `visualViewport` is unavailable.

### Application shell follows the visual viewport

The mobile application container uses the shared variables so the scroll region and composer fit the actually visible area. A `.roomtalk-keyboard-open` state class coordinates layout behavior rather than each component guessing independently.

### Editable focus and navigation

Keyboard-open detection checks focused editable controls. Mobile bottom navigation hides while editing so it does not compete for the reduced viewport. Modal viewport variables follow the same source. Input sizing avoids iOS automatic zoom.

### Cleanup and restoration

Listeners and scheduled frames are removed on unmount. Blur, visibility changes, BFCache restoration, and orientation changes recompute state so stale keyboard offsets do not survive navigation.

## Verification

Automated tests cover visual-viewport updates, focus/editable detection, keyboard class changes, navigation visibility, and cleanup. Browser emulation cannot reproduce every iOS keyboard behavior, so real-device regression includes:

1. Safari and Chrome on iPhone;
2. portrait and landscape;
3. room composer, settings inputs, and modal inputs;
4. open/close keyboard repeatedly;
5. switch apps/background/foreground;
6. navigate rooms while the keyboard is open;
7. verify safe-area bottom spacing and no page-scale jump.

## Lessons

- Mobile keyboard layout is a viewport ownership problem, not an arbitrary bottom-margin problem.
- One shared observer is safer than multiple component heuristics.
- Browser automation is valuable for state logic but cannot replace real iOS verification.
- Keyboard, bottom navigation, modal layout, and BFCache recovery must be designed together.
