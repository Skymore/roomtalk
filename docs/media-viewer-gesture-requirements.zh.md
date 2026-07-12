# 媒体查看器手势需求

[English](media-viewer-gesture-requirements.md)

状态：当前需求与实现记录
更新：2026-07-12

## 目标

图片/视频查看器应接近原生 photo viewer：手势决策可预期，手指未离开时可逆，只在手势结束时 commit navigation/dismiss。

## 范围

- 图片：single tap、double tap、pinch zoom、zoomed pan、水平切换、下拉返回。
- 视频：保留播放控件，不让 viewer gesture 抢占内建 media control。
- Mouse/keyboard：desktop close/navigation/zoom 可访问。

## 交互规则

### Commit 时机

- `pointermove` 只更新视觉 transform/opacity，不切换 media 或 close。
- `pointerup`/`pointercancel` 根据 distance、velocity、direction lock 和 boundary 决定 commit/snap-back。
- 手势未 commit 时必须平滑回到稳定状态。

### Tap 与 double tap

- Single tap 不应在 double-tap window 内立即触发与 double tap 冲突的 action。
- Double tap 在 1x 和预设 zoom 之间切换，以 tap point 为缩放中心，并 clamp pan bounds。
- 明显 drag/pinch 后不触发 tap。

### Pinch zoom

- 用两 pointer 间距与 midpoint 计算 scale/pan。
- 保持内容在手指下稳定，限制 minimum/maximum scale。
- 第二个 pointer 加入后，当前 single-pointer navigation/dismiss candidate 失效。
- 回到 1x 时将 pan 吸附回中心。

### 图片 pan

- 只在 zoom > 1 时允许自由 pan。
- 水平 pan 先消耗图片内容边界；只在已到边界且继续向外拖动时，才能进入 carousel navigation candidate。
- 越界使用 resistance，不允许无限拖离 viewport。

### 水平切换

- 只在主方向锁定为 horizontal 后为 candidate。
- 正向拖动预览相邻 media，但只在 release threshold/velocity 通过后切换 index。
- 第一个/最后一个 media 的无效方向使用 resistance 并 snap back。
- Zoomed image 只在内容边界向外拖时允许 navigation。

### 下拉返回

- 只在主方向锁定为 downward 且 scale 接近 1x 时启动。
- 拖动过程更新 media translate/scale 和 backdrop opacity。
- Release threshold/velocity 通过才 close，否则 snap back。
- Upward drag 不触发 dismiss。

### 优先级

1. 活跃 video/native control interaction。
2. Multi-pointer pinch。
3. Zoomed image pan（包括边界 handoff）。
4. 1x 下方向锁定的 horizontal navigation 或 downward dismiss。
5. Tap/double tap。

一旦某手势模式锁定，当前 pointer sequence 内不在模式之间抖动。

## 视频

- 视频 control 点击/拖动不会触发 viewer navigation/dismiss。
- 视频切换/close 时 pause 并清理不需要的 playback state。
- 不将图片 pinch/pan 语义强行应用到视频。

## 性能

- Pointer move 不应在每个事件做大量 React render；transform/opacity 用 `requestAnimationFrame` 合并。
- 主动 pointer 使用 capture，cancel/unmount 必须释放。
- 转换只使用 transform/opacity，避免 layout thrash。
- 移动端设置合适 `touch-action` 以避免 browser gesture 与 viewer 冲突。

## 可访问性

- Escape close；左右键 navigation；可访问 close/previous/next control。
- Focus 在 modal 中可预期，close 后返回触发点。
- 尊重 reduced-motion，不用 animation 作为唯一状态表达。

## Acceptance

- Drag 未过 threshold 不切换/close。
- Horizontal/downward 不互相误触。
- Pinch 不触发 tap/navigation。
- Zoomed pan 在到边界前不切换。
- Edge resistance、velocity-only commit、single-tap delay、keyboard 和 video control 符合上述规则。

## 实现状态

当前已实现锁定 gesture state machine、rAF transform batching、pinch/pan/navigation/dismiss 和 media cache 结合。已知需要继续强化的 automated coverage 包括 pinch、zoomed swipe suppression、edge resistance、velocity-only commit、keyboard 和 single-tap delay。
