# iOS 键盘弹出导致聊天视口错位：修复记录

## 背景

在 iPhone 的移动浏览器中，用户进入聊天室并聚焦消息输入框后，软键盘弹出，聊天页面出现大段空白，消息列表与输入区域被顶出可视范围。键盘保持打开时继续拖动页面，错位会随可视区域移动而变化。

该问题于 2026-05-25 在生产环境 `https://room.ruit.me` 复现，涉及移动端聊天主路径。

## 用户可见现象

- 聚焦消息编辑区后，屏幕中间显示大面积空白。
- 消息列表不再位于输入框上方的可视区域内。
- 底部导航或聊天区域可能被移动到屏幕上方。
- 键盘弹出后继续拖动视图，会看到错位位置发生变化。

## 页面布局前提

聊天页面采用全屏内部滚动布局：

- `client-heroui/src/App.tsx` 在应用根层管理可用视口高度。
- `client-heroui/src/index.css` 让 `.app-shell` 占满当前应用视口。
- `client-heroui/src/components/ChatRoomView.tsx` 将消息列表和输入面板组织为纵向 flex 布局。
- `client-heroui/src/components/MessageInput.tsx` 使用 `contentEditable` 作为消息输入区域。

页面本身不依赖 document 滚动，消息列表应当在自己的滚动容器内滚动。

## 根因

移动端 Safari 类浏览器在软键盘显示时存在两个不同的视口概念：

- Layout viewport：页面布局所依赖的基础视口。
- Visual viewport：用户当前真正能看到的区域；键盘弹出后它会缩小，也可能被浏览器向下平移。

`window.visualViewport` 提供两个关键值：

- `height`：键盘弹出后剩余的可见高度。
- `offsetTop`：visual viewport 相对于 layout viewport 的纵向偏移。

初始实现只把 `visualViewport.height` 写入 `--app-height`，并且在 `visualViewport.scroll` 时也重算高度。iOS 聚焦 `contentEditable` 后，浏览器可能同时缩小并平移 visual viewport，导致应用容器按照缩小后的高度重排，但没有移动到真正可见的位置。

第一轮修复解决了页面被普通滚动带走的一部分问题：

- 将 `body` 和 `#root` 固定在视口中。
- 不再用 `visualViewport.scroll` 更新应用高度。
- 将移动端编辑区字号设为 16px，降低 iOS 聚焦自动缩放的概率。

但第一轮修复没有使用 `visualViewport.offsetTop`。因此，当 iOS 在键盘状态下平移 visual viewport，固定的 `.app-shell` 仍停留在 layout viewport 顶部，和用户真正看到的区域发生偏移，空白问题仍会出现。

## 最终修复

最终方案将可视高度和可视偏移作为两个独立状态处理。

### 1. 视口变量

`client-heroui/src/utils/appViewport.ts` 维护两个 CSS 变量：

```css
--app-height: <visualViewport.height>;
--app-viewport-top: <visualViewport.offsetTop>;
```

事件处理规则如下：

| 事件 | 更新高度 | 更新顶部偏移 | 原因 |
| --- | --- | --- | --- |
| 初始化 | 是 | 是 | 建立当前布局基线 |
| `window.resize` / `orientationchange` | 是 | 是 | 窗口或方向发生结构性变化 |
| `visualViewport.resize` | 是 | 是 | 软键盘显示/隐藏改变可见高度 |
| `visualViewport.scroll` | 否 | 是 | 键盘状态下的 visual viewport 平移不应反复改变布局高度 |

更新通过 `requestAnimationFrame` 合并，避免同一帧内 resize 与 scroll 事件造成抖动。

### 2. 应用容器跟随 visual viewport

`client-heroui/src/index.css` 中，根页面继续阻止 document 级滚动，`.app-shell` 则固定到 visual viewport 所在位置：

```css
.app-shell {
  position: fixed;
  top: var(--app-viewport-top, 0px);
  left: 0;
  right: 0;
  height: var(--app-height, 100dvh);
  overflow: hidden;
}
```

键盘弹出后：

- `--app-height` 使聊天布局只占用键盘上方的可见高度。
- `--app-viewport-top` 使整个聊天布局随 iOS 实际可见区域对齐。
- 消息列表仍保留为内部滚动容器，输入面板保持在可见区域底部。

### 3. 输入区域防止自动缩放

移动端 `contentEditable` 编辑区使用 `text-base`（16px），较宽屏幕再回到较紧凑字号：

```tsx
className="... text-base ... sm:text-sm"
```

这不是主要修复，但可避免 iOS 因输入字号过小而额外触发页面缩放或聚焦平移。

## 变更记录

| PR | 内容 | 结果 |
| --- | --- | --- |
| `#4` `Fix mobile keyboard viewport layout` | 固定根容器、抽取视口高度逻辑、移除 scroll 高度重算、输入字号调整 | 缓解因素已处理，但未覆盖 `offsetTop`，真机仍复现 |
| `#5` `Fix mobile keyboard viewport offset` | 单独跟踪 `visualViewport.offsetTop`，让 `.app-shell` 随 visual viewport 平移 | 真机反馈确认问题修复 |

## 测试与验证

### 自动化测试

`client-heroui/src/utils/appViewport.test.ts` 覆盖：

- 使用 `visualViewport.height` 初始化应用高度。
- `visualViewport.resize` 同时更新高度和顶部偏移。
- `visualViewport.scroll` 只更新顶部偏移，不改变应用高度。
- 浏览器不提供 `visualViewport` 时回退到 `window.innerHeight`。

本次修复执行过：

```bash
cd client-heroui
npm test -- appViewport.test.ts
npm test -- --run
npm run build
```

### 本地浏览器验证边界

桌面浏览器的移动尺寸模式可以确认：

- `.app-shell` 使用 fixed 布局。
- CSS 变量已接入页面。
- 移动尺寸下页面可以正常渲染。

但普通桌面浏览器无法真实模拟 iOS 系统键盘对 `visualViewport.offsetTop` 的操作，因此不能单独作为此类问题的最终通过依据。

### 真机回归步骤

对于 iOS Safari 或应用内 WebView，发布后应检查：

1. 打开一个包含历史消息的聊天室。
2. 滚动至消息底部并点击消息输入框。
3. 确认键盘弹出后，输入面板仍位于键盘上方，最近消息仍可见。
4. 在键盘保持打开时轻微拖动页面，确认不再出现大面积空白或导航错位。
5. 收起键盘，确认页面恢复完整高度且消息滚动位置合理。
6. 分别在浅色/深色模式和 Safari/实际使用的内置浏览器中复测。

## 经验与后续

- 处理移动端键盘布局时，不能只关注 `visualViewport.height`，还必须考虑 `offsetTop`。
- `visualViewport.scroll` 在键盘场景下不等同于用户滚动消息列表，不应触发布局高度重排。
- 与软键盘相关的布局问题，需要真机或完整 Xcode Simulator 做发布验证；仅有响应式 viewport 测试不足以证明修复成立。
- 若后续继续调整移动端聊天布局，应把上述真机回归步骤作为发布前检查项保留。
