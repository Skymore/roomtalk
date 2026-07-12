# RoomTalk UI/UX Audit, Root-Cause Review, and Fix Record

[中文原文](ui-ux-audit-2026-07-10.md)

Status: Date-bounded audit and remediation record
Date: 2026-07-10
Reviewed: 2026-07-12

Environment: local development, light/dark themes, English/Chinese UI
Desktop: 1440 × 900 and 768 × 900
Mobile: 390 × 844 and 375 × 667; 390 × 500 simulated a keyboard-reduced viewport

## Scope and Product Constraints

The audit preserved before-fix screenshots and initial hypotheses, then recorded source-level root-cause checks, code fixes, automated regression coverage, and after-fix screenshots. The final status table supersedes early hypotheses where evidence changed the conclusion.

Compact 28 × 28 visual controls are an intentional high-density choice. They were reported only when actual hit-target, discoverability, or state-feedback evidence justified it. Test coverage included home/saved empty states, valid and stale rooms, settings, username editing, room creation/posting hours, invalid IDs, sidebar collapse, the 767/768 breakpoint, themes, and both languages. Isolated test rooms were used for destructive/message/media flows.

## Conclusion Corrections

Source and browser verification changed several screenshot-only interpretations:

- some apparent missing actions already existed behind context-specific controls;
- ordinary message failure already exposed a status, so the remaining issue was recovery affordance rather than total absence;
- compact mobile navigation was retained because its interaction target and information density worked as designed;
- findings requiring real room/media state were separated from issues reproducible in deterministic fixtures.

## Fixed Cross-Platform Findings

1. **Stale room ghost state (P1).** Invalid/deleted rooms could remain selected and make unrelated screens look broken. Room restore now validates the room and clears stale active state.
2. **Persistent invalid-room error (P1).** A room error could survive navigation and modal changes. Error ownership and reset points were aligned with the active room flow.
3. **Media loading/recovery feedback (P2).** Loading, failure, and retry/open actions were made more explicit.
4. **Duplicated accessible form names (P2).** Label/ARIA composition was corrected so screen readers do not announce repeated text.
5. **Primary-button contrast (P1).** Text/background combinations were adjusted to meet WCAG AA in affected themes.
6. **Global error announcement (P2).** Error surfaces gained live-region semantics where asynchronous failures need announcement.
7. **Username input name (P2).** The editing input received an accessible label.
8. **Reduced motion (P2).** Custom motion respects `prefers-reduced-motion`.
9. **Chat log semantics (P1).** The realtime message list exposes appropriate log/live behavior without rereading the full history.
10. **Modal background isolation (P1).** Message actions and media viewer improved focus containment and background interaction blocking.
11. **Page/navigation landmarks (P2).** Missing structural semantics were added where they materially improve navigation.

## In-Room Findings

- Media types needed a more consistent select-then-send model.
- Multi-file upload required item-level progress/error rather than only one spinner.
- Composer errors needed a dismiss/recovery action.
- Ordinary message send failure had a status but benefited from clearer retry behavior.
- Media-viewer actions needed text/toast feedback, not icon-state-only changes.
- Export failure should use product UI rather than a browser `alert`.

These items were tested against isolated message, image, video, file, sticker, voice, room-recovery, settings, and delete flows.

## Desktop Findings

- Put actionable state earlier on the settings page.
- Reduce default composer height where it competes with message density.
- Do not render a selector when room type has only one available option.
- Give secondary header status explicit loading/error semantics.
- Validate form fields before the final submit boundary.
- Keep the collapsible sidebar; it performs well for high-density use.

## Mobile Findings

- Shorten the path to important settings.
- Retain compact bottom navigation; it was a positive finding.
- Tighten empty-state copy and primary action.
- Keep full-screen room creation on small viewports.
- Validate mobile forms earlier.
- Improve use of 600–767px tablet width.
- Add text/tooltips or another discoverable treatment for icon-only settings tabs.

## Additional Root-Cause Fixes

The deeper pass also found state ownership and responsive edge cases not obvious in the first screenshots. Fixes focused on clearing stale state at its owner, preserving user-entered form values through validation, preventing overlay interaction leaks, and ensuring short viewports keep the composer/action path reachable.

## Validation

The remediation pass used targeted unit/component tests, accessibility queries, production client build, deterministic desktop/mobile screenshots, and real interaction checks for keyboard, focus, overlay dismissal, reconnect, media, and room cleanup. Screenshots and exact command/output evidence remain in the Chinese source report and its `screenshots/` directory.

## Residual Boundaries

This report is a dated snapshot, not a permanent design source of truth. External media/network timing, device-specific soft keyboards, screen-reader differences, and production-only service behavior still require targeted verification when those paths change. Current UI behavior is defined by the client source and tests.
