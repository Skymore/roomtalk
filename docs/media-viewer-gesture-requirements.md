# Media Viewer Gesture Requirements

[中文](media-viewer-gesture-requirements.zh.md)

Status: Current requirements and implementation record
Updated: 2026-07-21

## Goal

The image and video viewer should feel closer to a native photo viewer than a web carousel. Gesture decisions must be predictable, reversible while the finger is still down, and committed only when the gesture ends.

## Scope

- Full-screen media viewer opened from a chat message.
- Single media preview opened from the image/video history grid.
- Image gestures: double-tap zoom, pinch zoom, pan, tap return, swipe down return, horizontal media navigation.
- Video behavior: no autoplay; playback starts only from explicit user action.

## Interaction Rules

### Gesture commit timing

- No navigation, close, or return action may execute on pointer down or pointer move.
- Pointer move may only update visual preview state, such as carousel offset, vertical dismiss offset, image pan, or pinch scale.
- Navigation, close, and return are committed only on pointer up or pointer cancel.
- If a gesture does not pass the commit threshold, the viewer returns to its prior visual state.

### Tap and double tap

- A tap is a pointer sequence with movement no greater than 8 px.
- Single tap returns from the current preview:
  - In the main viewer, single tap closes the viewer.
  - In history single-preview mode, single tap returns to the history grid.
- Single tap must be delayed briefly so a second tap can convert it into a double tap.
- Double tap on an image toggles zoom:
  - If the image is at 1x, zoom to 2x.
  - If the image is above 1x, return to 1x.
  - The second tap position is the zoom anchor, so the tapped point stays as close as possible to the same screen location.
- Tap and double tap do not apply to videos; video taps are left to native controls, while drag gestures on the video surface may still navigate or dismiss.

### Pinch zoom

- Two active pointers on an image enter pinch mode.
- Pinch scale is continuous and calculated from pointer distance.
- The pinch center is the anchor, so the content under the midpoint remains stable as much as possible.
- Pinch disables horizontal navigation and vertical return until all but one pointer has ended.
- Zoom is clamped to 1x through 6x.
- If pinch ends close to 1x, snap back to exactly 1x and recenter.

### Image pan

- At zoom greater than 1x, one-finger movement pans the image unless the initial movement locks as a downward return.
- Pan is clamped so the image cannot drift indefinitely away from the viewport.
- Horizontal movement is consumed by image pan first. Once the image reaches its left or right pan boundary, continued outward movement can hand the same gesture to carousel navigation when an adjacent item exists.
- Pan is committed visually during move, but no navigation or return is committed until pointer up.

### Horizontal navigation

- Horizontal swiping starts directly at 1x for images and remains active on video surfaces. A zoomed image can enter horizontal paging only after its pan reaches the outward boundary.
- Movement locks to horizontal once horizontal displacement exceeds the gesture threshold and dominates vertical movement.
- While dragging, the carousel follows the finger using direct DOM transforms instead of React state updates, with transform writes batched through `requestAnimationFrame`.
- React state should update only after pointer up selects a new item or resets the current one.
- Release animation duration should be calculated from remaining travel distance and release velocity, then clamped to a bounded native-feeling 500ms-800ms range.
- Commit criteria:
  - Swipe distance exceeds the distance threshold, or
  - Swipe velocity exceeds the velocity threshold.
- If neither threshold is met, the carousel snaps back.
- At first/last media, horizontal drag applies edge resistance instead of hard-stopping.

### Downward return

- Downward return is active at both 1x and zoomed states.
- It locks when downward displacement exceeds the gesture threshold and dominates horizontal movement.
- During move, the active media follows the finger downward, scales down, and the backdrop plus viewer chrome fade with the gesture.
- It returns only on pointer up if distance or velocity threshold is met.
- If the threshold is not met, the viewer springs back to normal.

### Gesture priority

1. Interactive controls: buttons, links, and video controls keep their native behavior.
2. Two active pointers: pinch.
3. Single pointer on image:
   - If zoomed and downward movement dominates, vertical return.
   - If zoomed and not downward return, image pan; continued outward movement at a horizontal boundary hands off to navigation.
   - If 1x and horizontal movement dominates, horizontal navigation.
   - If 1x and downward movement dominates, vertical return.
4. Tap candidate:
   - Single tap returns after the double-tap delay.
   - Double tap toggles image zoom at the tapped position.

## Video Requirements

- Full-viewer videos must not autoplay when opened or when swiped into view.
- Full-viewer videos must show native controls when active.
- Full-viewer videos must allow horizontal swipe navigation when dragging on the video surface.
- Leaving a video slide should not attempt to keep it playing.

## Performance Requirements

- Pointer move must not call React state setters for every frame of horizontal drag or vertical dismiss preview.
- Pointer move should avoid repeated expensive layout work; dimensions used for commit thresholds should be captured at gesture start.
- Gesture transforms should be applied outside React render during active movement and flushed once per animation frame, with CSS transitions disabled while following the finger.
- The RAF-batched transform path is the implemented 60fps optimization. The original device profile dropped below 30fps with scattered writes; the optimized path was observed at 60fps on the target device. These are manual profile observations, not an automated benchmark.
- React state is updated after gesture completion for active media index, zoom, and pan.
- CSS transitions are disabled during direct finger tracking and enabled only for snap-back or commit animations.

## Accessibility Requirements

- Existing close, download, history, share, previous, and next buttons remain accessible by label.
- Keyboard left/right navigation remains available.
- Escape continues to close or return according to current mode.
- Images keep alt text.
- Motion is short and functional, not decorative.

## Acceptance Criteria

- Double-tapping an image zooms around the tap position; double-tapping again resets to 1x.
- Pinching an image changes zoom continuously and clamps between 1x and 6x.
- Single tapping an image closes the main viewer or returns from history preview, including when zoomed.
- Down swiping previews the return during movement and commits only after release.
- Horizontal swiping feels smooth and follows the finger at 1x.
- A zoomed image pans before paging; at its horizontal boundary, continued outward movement can switch to the adjacent media.
- Closing after swiping to another item and reopening the original chat media starts from the clicked media, not the previous internal carousel position.
- Video slides do not autoplay and require explicit user play.
- Existing history preview action buttons remain available.

## Implementation Status

Current implementation lives in `client-heroui/src/components/MediaViewerModal.tsx`.
It covers direct DOM transforms, double-tap image zoom, pinch, pan, downward
return at 1x or while zoomed, direct horizontal paging at 1x, zoomed-image pan
boundary handoff, video controls with no autoplay, inactive-video pause,
keyboard navigation, and Escape handling.

Automated coverage currently includes double-click zoom, tap close, downward
dismiss, horizontal image/video swipes, zoomed-image boundary handoff, reopen
behavior, and video no-autoplay through `MessageItem.test.tsx`.

Known test gaps:

- Direct multi-pointer pinch simulation.
- Edge resistance at the first/last media item.
- Velocity-only commits independent of distance.
- Keyboard arrow and Escape behavior.
- Single-tap delay before double-tap disambiguation.
