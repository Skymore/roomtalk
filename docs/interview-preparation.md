# RoomTalk 面试准备资料

本文档帮助你在技术面试中讲解 RoomTalk 项目。内容覆盖系统设计、技术决策、踩过的坑、扩展方案和常见面试追问。

---

## 一、30 秒项目介绍

> RoomTalk 是一个实时聊天系统，支持多人房间聊天、AI 流式助手、私有媒体上传、贴纸、语音转写和移动端优化。前端是 React + TypeScript + Vite，后端是 Node.js + Express + Socket.IO，持久化支持 Redis 和 PostgreSQL 双模式，媒体存储用 S3 兼容对象存储。部署在 Fly.io，CI/CD 通过 GitHub Actions 自动化。

面试官听完会根据兴趣追问，你控制节奏，引导到你最熟的方向。

---

## 二、系统架构

### 画架构图时这样画

```text
                    ┌──────────────┐
                    │   Client     │
                    │  React/Vite  │
                    └──────┬───────┘
                           │ HTTPS / WSS
                    ┌──────▼───────┐
                    │  Load Balancer│ ← TLS termination, sticky session
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │    Node.js Server       │
              │  Express + Socket.IO    │
              │                         │
              │  ┌─────────────────┐    │
              │  │ CompositeRoom   │    │
              │  │ Store           │    │
              │  └──┬──────────┬───┘    │
              └─────┤          ├────────┘
                    │          │
         ┌──────────▼──┐  ┌───▼──────────┐
         │ PostgreSQL   │  │    Redis      │
         │ (durable)    │  │ (realtime +   │
         │ rooms,       │  │  sessions,    │
         │ messages,    │  │  presence,    │
         │ members,     │  │  Socket.IO    │
         │ media assets │  │  adapter,     │
         │ auth, ...    │  │  msg cache)   │
         └──────────────┘  └──────────────┘

              ┌──────────┐    ┌───────────┐
              │ S3/Tigris│    │ AI APIs   │
              │ (media)  │    │ DeepSeek  │
              └──────────┘    │ Anthropic │
                              │ OpenAI    │
                              │ OpenRouter│
                              └───────────┘
```

### 关键设计点（面试必讲）

**1. CompositeRoomStore — 双存储分层**

这是整个后端最核心的抽象。一个 `CompositeRoomStore` 组合了三个子存储：

- `DurableRoomStore`：持久数据（房间、消息、成员、媒体资产、认证）。可以是 Redis 或 PostgreSQL，运行时通过环境变量切换。
- `RealtimeRoomStore`：始终是 Redis。管理 socket session、在线成员、临时状态。服务重启后自动重建。
- `RoomMessageCacheStore`：可选的 Redis TTL 缓存，在 PostgreSQL 模式下减少数据库读压力。

面试时这样讲：
> 我们把存储拆成"持久"和"实时"两层。持久层可以在 Redis 和 PostgreSQL 之间切换——开发用 Redis 快速迭代，生产切到 PostgreSQL 保证数据安全。实时层始终用 Redis 因为它本来就是内存存储，做 session 和 presence 正好。中间加了一层消息缓存，cache miss 才查 PostgreSQL，命中率在 90%+ 因为聊天场景下用户大概率读最近的消息。

**2. Socket.IO 多实例扩展**

```text
Client A ──WSS──▶ Instance 1 ──Redis pub/sub──▶ Instance 2 ──push──▶ Client B
```

用 `@socket.io/redis-adapter`，所有 Socket.IO 事件通过 Redis pub/sub 同步到所有实例。客户端不感知自己连的是哪个实例。

面试追问：**sticky session 为什么必须？**
> Socket.IO 握手分两步：先发几个 HTTP long-polling 请求，再升级到 WebSocket。如果这几个 HTTP 请求被负载均衡分到不同实例，握手就断了。所以 ALB 必须开 stickiness，保证同一个客户端的请求始终到同一台机器。握手完成后 WebSocket 是长连接，自然不会飘。

**3. AI 流式响应**

```text
Client → ask_ai event → Server → AI Provider (streaming) → ai_chunk events → Client
```

- 服务端用 OpenAI SDK 的 stream API，逐 chunk 读取，通过 Socket.IO 实时推给客户端。
- 消息创建时 `status: 'streaming'`，完成后改为 `'complete'`，出错改为 `'error'`。
- 服务器重启时，`aiStreamRecovery` 扫描所有 `status = 'streaming'` 的消息，标记为 `'error'`，避免僵尸流。

面试追问：**为什么不用 SSE？**
> 已经有 Socket.IO 长连接了，再开 SSE 是多余的连接。Socket.IO 事件模型可以区分不同房间、不同用户的 AI 流，比 SSE 灵活。而且 AI 流需要和消息历史、状态同步走同一个通道，不适合单独开一个 HTTP 流。

**4. 媒体上传流程 — Presigned URL**

```text
Client                    Server                     S3
  │                         │                         │
  │── request upload URL ──▶│                         │
  │                         │── generate presigned ──▶│
  │◀── presigned PUT URL ──│                         │
  │                         │                         │
  │──── PUT file directly ─────────────────────────▶ │
  │                         │                         │
  │── confirm upload ──────▶│                         │
  │                         │── create MediaAsset ──▶ │
  │◀── message with asset ─│                         │
```

面试时这样讲：
> 文件不经过我们的服务器。客户端先向服务器请求一个临时上传 URL（presigned URL，有效期 15 分钟），然后直接上传到 S3。上传完成后通知服务器，服务器创建 metadata 记录。下载也是类似的，服务器生成临时读取 URL 返回给客户端。这样服务器不处理大文件流量，带宽和 CPU 都省了。

面试追问：**presigned URL 安全吗？**
> URL 本身包含签名，只对特定 bucket/key 有效，有过期时间。泄露了也只能上传到这一个位置，不能读其他文件。而且我们的 bucket 设置了 block all public access，没有 presigned URL 什么都看不到。

---

## 三、技术难点与解决方案

### 前端篇

### 难点 1：媒体查看器手势引擎（1830 行）

**问题**：需要在一个组件里同时支持 6 种手势——单击关闭、双击缩放、双指缩放、拖拽平移、水平滑动翻页、下滑关闭——它们在触控层面高度重叠，一根手指的移动可能是任何一种操作。

**核心设计** — 手势模式状态机：

所有触控事件先进入 `tap` 模式，移动超过阈值后根据方向锁定到具体模式，一旦锁定不再切换：

```typescript
// MediaViewerModal.tsx — 手势模式转换
if (state.mode === "tap" && (absX > TAP_THRESHOLD || absY > TAP_THRESHOLD)) {
  clearTapTimer();
  if (deltaY > 0 && absY > absX * 1.15) {
    state.mode = "vertical";     // 下滑关闭
  } else if (isZoomedImage) {
    state.mode = "pan";          // 缩放态下拖拽
  } else if (absX > absY * 1.1) {
    state.mode = "horizontal";   // 左右翻页
  } else {
    state.mode = "ignored";      // 方向不明确，忽略
  }
}
```

方向判定用 1.1x/1.15x 的不对称阈值——下滑关闭需要更强的纵向意图（1.15x），避免翻页时误触关闭。

**双指缩放 — 中心点保持：**

缩放时两指中心点必须"钉在屏幕上"，不能漂移。核心公式是按缩放比重新计算 pan offset：

```typescript
// MediaViewerModal.tsx — pinch-to-zoom
const distance = Math.max(1, getDistance(points[0], points[1]));
const nextZoom = clampZoom(state.startZoom * (distance / state.pinchDistance));
const ratio = nextZoom / Math.max(MIN_IMAGE_ZOOM, state.startZoom);
const nextPan = nextZoom <= MIN_IMAGE_ZOOM
  ? ZERO_IMAGE_PAN
  : clampImagePan({
    x: stageCenter.x - ((state.pinchCenter.x - state.startPan.x) * ratio),
    y: stageCenter.y - ((state.pinchCenter.y - state.startPan.y) * ratio),
  }, nextZoom, state.metrics);
```

**双击缩放 — 时空双重判定：**

220ms 内、34px 内的两次点击才算双击。第一次点击延迟触发关闭，第二次来了就取消：

```typescript
// MediaViewerModal.tsx — 双击检测
const isImageDoubleTap = activeStageMedia.kind === "image"
  && lastTap
  && currentTime - lastTap.time <= DOUBLE_TAP_DELAY_MS        // 时间窗口
  && Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE;  // 空间窗口

if (isImageDoubleTap) {
  clearTapTimer();           // 取消单击关闭
  handleDoubleTap(clientX, clientY);
  return;
}
// 不是双击 → 延迟执行单击关闭
tapTimerRef.current = setTimeout(() => onDismiss(), DOUBLE_TAP_DELAY_MS);
```

**下滑关闭 — 速度 + 距离双路径：**

```typescript
// MediaViewerModal.tsx — 下滑关闭
const shouldDismiss = deltaY > SWIPE_DOWN_THRESHOLD                    // 距离够远
  || (velocityY > VERTICAL_VELOCITY_THRESHOLD                          // 或者速度够快
      && deltaY > TAP_THRESHOLD * 2 && absY > absX * 1.1);            // 但要确认是纵向
```

快速甩动不需要拖到底部就能关闭，慢速拖拽则必须超过阈值。

**边界弹性阻力（轮播边缘）：**

翻到最后一页继续拖，用非线性阻力公式模拟 iOS 弹性效果：

```typescript
// useSwipePager.ts — 边界阻力
const resisted = safeWidth * (1 - (1 / ((distance / safeWidth) * 0.55 + 1)));
return Math.sign(offset) * Math.min(resisted, safeWidth * 0.45);
```

这是经典的阻尼弹簧公式：`f(d) = w × (1 - 1/(k·d/w + 1))`。拉得越远阻力越大，最大只能拉到 45% 宽度。

**RAF 批量渲染：**

pinch 事件每秒触发 60+ 次，直接操作 DOM 会卡。所有 transform 先写入 pending 队列，合并到一个 `requestAnimationFrame` 回调里刷新：

```typescript
// MediaViewerModal.tsx — RAF 去重
const scheduleDomTransformFlush = React.useCallback(() => {
  if (transformFrameRef.current !== null) return;  // 已有排队的帧
  transformFrameRef.current = window.requestAnimationFrame(flushDomTransforms);
}, [flushDomTransforms]);
```

**速度驱动动画时长：**

快速甩动翻页，动画要短；慢速拖拽松手，动画要长：

```typescript
// useSwipePager.ts — 速度影响过渡时长
const duration = 520 + distanceRatio * 420 - velocityRatio * 120;
// 基础 520ms + 距离远加时间(最多+420ms) - 速度快减时间(最多-120ms)
```

面试时这样讲：
> 媒体查看器是我写过最复杂的前端组件，1800 多行。核心是一个手势模式状态机——所有触控先进入 tap 状态，移动超过阈值后根据方向比锁定为水平翻页、下滑关闭、缩放拖拽之一。缩放用了中心点保持的几何变换，边缘翻页有非线性弹性阻力，关闭支持速度判定。所有 DOM 更新通过 RAF 批量刷新，保证 pinch 操作 60fps 不卡顿。

---

### 难点 2：三层媒体缓存系统

**问题**：聊天里图片/视频反复查看，每次都发网络请求浪费带宽和时间。但浏览器默认 cache 对 presigned URL（每次 URL 不同）无效。

**解决方案** — Object URL → Cache API → Network：

```typescript
// mediaCache.ts — 三层缓存查找
const getCachedMediaObjectUrl = async ({ assetId, url, kind, byteSize }) => {
  const key = bodyCacheKey(assetId);

  // 第 0 层：并发请求去重
  const existingRequest = inFlightBodyUrls.get(key);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    try {
      // 第 1 层：内存中的 Object URL（最快，无 IO）
      const cachedUrl = await getBlobObjectUrlFromCache(MEDIA_BODY_CACHE_NAME, key);
      if (cachedUrl) return cachedUrl;

      // 第 2 层：Cache API blob 存储
      const response = await fetch(url, { cache: "force-cache" });
      const blob = await response.blob();

      // 存入 Cache API + 生成 Object URL
      await putBlobInCache(MEDIA_BODY_CACHE_NAME, key, blob, mimeType, MAX_BODY_CACHE_BYTES);
      return rememberObjectUrl(key, URL.createObjectURL(blob));
    } finally {
      inFlightBodyUrls.delete(key);  // 无论成功失败都清除 in-flight
    }
  })();

  inFlightBodyUrls.set(key, request);  // 注册 in-flight，后续请求复用这个 Promise
  return request;
};
```

**LRU 驱逐（300MB 上限）：**

```typescript
// mediaCache.ts — 按时间戳驱逐最旧的
const trimCache = async (cacheName, maxBytes) => {
  const entries = await Promise.all(requests.map(async (request) => ({
    request,
    byteSize: Number(response?.headers.get("X-RoomTalk-Byte-Size")) || 0,
    cachedAt: Date.parse(response?.headers.get("X-RoomTalk-Cached-At") || ""),
  })));

  let totalBytes = entries.reduce((t, e) => t + e.byteSize, 0);
  for (const entry of entries.sort((a, b) => a.cachedAt - b.cachedAt)) {  // 最旧优先
    await cache.delete(entry.request);
    totalBytes -= entry.byteSize;
    if (totalBytes <= maxBytes) return;
  }
};
```

用自定义 header `X-RoomTalk-Byte-Size` 和 `X-RoomTalk-Cached-At` 给每个缓存条目打标，驱逐时按时间排序删最旧的。

**视频自动生成封面帧：**

```typescript
// mediaCache.ts — canvas 提取视频帧
const video = document.createElement("video");
video.src = getVideoPreviewUrl(videoUrl);
await waitForVideoEvent(video, "loadeddata");
video.currentTime = Math.min(0.1, video.duration / 100);  // seek 到 1% 处
await waitForVideoEvent(video, "seeked");

const scale = Math.min(1, POSTER_MAX_WIDTH / video.videoWidth, POSTER_MAX_HEIGHT / video.videoHeight);
canvas.width = Math.round(video.videoWidth * scale);
canvas.height = Math.round(video.videoHeight * scale);
context.drawImage(video, 0, 0, canvas.width, canvas.height);
canvas.toBlob(resolve, "image/jpeg", 0.82);  // 82% quality JPEG
```

面试时这样讲：
> 因为我们用 presigned URL，每次 URL 都不一样，浏览器默认缓存失效。所以我们自己做了三层缓存：内存里的 Object URL 最快，Cache API 存 blob 持久化，最后才走网络。用 assetId 而不是 URL 做缓存 key。并发请求同一个资源会复用 Promise，避免 thundering herd。LRU 驱逐按时间戳排序删最旧的，上限 300MB。视频还会自动通过 canvas 生成封面帧缓存起来。

---

### 难点 3：移动端视窗与输入适配

**问题**：iOS Safari 和 Android Chrome 的键盘弹出行为完全不同——Safari 用 Visual Viewport 收缩可视区，Chrome 推挤页面。CSS `100vh` 在两者上都不对。中文/日文输入法（IME）的 composing 状态下按回车会误发消息。

**键盘检测 — Visual Viewport API + 棘轮模式：**

```typescript
// appViewport.ts — 键盘高度检测
const viewportHeight = getViewportHeight(win);  // visualViewport.height
const isEditableFocused = isEditableElement(win.document.activeElement);

// "棘轮"：只在非聚焦或视窗变大时更新基准高度
if (!isEditableFocused || viewportHeight > expandedViewportHeight) {
  expandedViewportHeight = Math.max(win.innerHeight, viewportHeight);
}

// 基准高度 - 当前高度 > 120px → 键盘打开
const isKeyboardOpen = isEditableFocused
  && expandedViewportHeight - viewportHeight > KEYBOARD_HEIGHT_THRESHOLD_PX;
root.classList.toggle('keyboard-open', isKeyboardOpen);
```

`expandedViewportHeight` 记录"没有键盘时的最大高度"。只在输入框失焦或视窗变大时更新。差值超过 120px 就判断键盘打开。120px 阈值防止 toolbar 收缩导致的误判。

**IME 输入防误发 — 80ms 宽限期：**

中文输入法选字后，`compositionend` 和 `keydown Enter` 的顺序在不同浏览器不一致。直接判断 `isComposing` 不够可靠：

```typescript
// keyboardComposition.ts — 四重检查
export const isConfirmingIMEComposition = ({
  isComposing,          // React 状态
  nativeIsComposing,    // 原生事件属性
  keyCode,              // 229 = IME 正在处理
  lastCompositionEndAt, // composition 结束时间戳
  now,
  graceMs = 80,         // 80ms 宽限期
}) => {
  return (
    isComposing ||
    !!nativeIsComposing ||
    keyCode === 229 ||
    now - lastCompositionEndAt < graceMs   // 刚结束 composition，还不安全
  );
};
```

面试时这样讲：
> 移动端键盘检测不能用 `window.innerHeight`，因为 iOS Safari 有 Visual Viewport 的概念。我们记录"无键盘时的最大视窗高度"作为基准，当前高度比基准小 120px 以上就判断键盘打开，然后通过 CSS class 调整布局。中文输入法防误发用了四重检查加 80ms 宽限期，因为 compositionend 和 keydown 的时序在 Safari、Chrome、微信浏览器里都不一样。

---

### 难点 4：贴纸系统（虚拟分页 + 预加载 + 长按预览）

**问题**：2275 张贴纸，每张都是一个图片请求。如果一次全渲染，DOM 节点数爆炸，首屏加载巨慢。

**虚拟分页 — 只渲染 ±1 页：**

```typescript
// StickerPicker.tsx — 按距离决定是否渲染
const shouldRender = Math.abs(index - groupIndex) <= STICKER_PAGE_RENDER_RADIUS;  // ±1 页

{groups.map((group, index) => (
  <div key={group.title} aria-hidden={index !== groupIndex}>
    {shouldRender && (
      <StickerGrid
        stickers={resolve(group.stickerIds)}
        imageLoading={isNearActive(index) ? 'eager' : 'lazy'}  // 相邻页 eager 加载
      />
    )}
  </div>
))}
```

当前页 + 前后各 1 页 = 最多 3 页 DOM，其余页的 div 为空。

**相邻页图片预加载：**

```typescript
// StickerPicker.tsx — 微任务预加载
useEffect(() => {
  if (!preloadStickerUrlKey) return;
  const timer = window.setTimeout(() => {
    for (const url of preloadStickerUrlKey.split('\n')) {
      const image = new Image();
      image.decoding = 'async';   // 异步解码，不阻塞主线程
      image.src = url;
    }
  }, 0);  // setTimeout(0) 推到微任务，不阻塞当前帧
  return () => window.clearTimeout(timer);
}, [preloadStickerUrlKey]);
```

**长按预览 — 350ms 定时器 + 点击抑制：**

```typescript
// StickerPicker.tsx — 长按状态机
const startPress = () => {
  longPressed.current = false;
  timer.current = window.setTimeout(() => {
    longPressed.current = true;
    onPreview(sticker.id);      // 350ms 后显示大图预览
  }, 350);
};
const handleClick = () => {
  if (longPressed.current) {     // 长按过了就不算点击
    longPressed.current = false;
    return;
  }
  onSelect(sticker.id);          // 短按才选中发送
};
```

面试时这样讲：
> 2275 张贴纸如果全渲染 DOM 节点数会爆。我们用虚拟分页只渲染当前 ±1 页，其余页 div 为空。相邻页的图片用 `new Image()` 异步预加载，`decoding='async'` 不阻塞渲染线程。交互上实现了长按 350ms 预览大图、松开关闭、短按发送的状态机。

---

### 难点 5：消息列表体验优化（乐观发送 + 滚动保位）

**问题**：消息发送如果等服务端确认再显示，体感延迟明显。加载更早的消息历史时，新消息插入到列表顶部会导致当前阅读位置跳动。

**乐观发送 — 三阶段状态机：**

```typescript
// messageState.ts — 乐观插入
export const addOptimisticMessage = (messages, optimisticMessage) => {
  // clientMessageId 去重，防止重复插入
  if (optimisticMessage.clientMessageId &&
      messages.some(m => m.clientMessageId === optimisticMessage.clientMessageId)) {
    return messages;
  }
  return sortMessages([...messages, optimisticMessage]);
};

// 服务端 ack → 替换为真实消息
export const replaceOptimisticMessage = (messages, clientMessageId, savedMessage) => {
  return upsertMessage(messages, { ...savedMessage, clientMessageId });
};

// 发送失败 → 标记错误
export const markOptimisticMessageFailed = (messages, clientMessageId, error) => {
  return messages.map(m =>
    m.clientMessageId === clientMessageId
      ? { ...m, deliveryStatus: "failed", deliveryError: error }
      : m
  );
};
```

**加载历史消息 — delta height 保位：**

```typescript
// MessageList.tsx — 加载前记录位置
const handleLoadMore = useCallback(() => {
  preserveScrollRef.current = {
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
  socket.emit('get_room_messages', { roomId, beforeMessageId, limit: 80 });
}, [...]);

// 加载后用 layoutEffect 恢复
React.useLayoutEffect(() => {
  const prev = preserveScrollRef.current;
  if (!prev || !container) return;
  preserveScrollRef.current = null;
  // 新 scrollTop = 旧 scrollTop + 新增内容的高度
  container.scrollTop = prev.scrollTop + (container.scrollHeight - prev.scrollHeight);
}, [messages.length]);
```

**ResizeObserver 自动 stick-to-bottom：**

```typescript
// MessageList.tsx — 内容变化时自动跟底
const observer = new ResizeObserver(() => {
  if (preserveScrollRef.current) return;    // 正在加载历史，不自动滚
  if (isNearBottomRef.current) {            // 用户在底部附近
    scheduleScrollToBottom('auto');
  }
});
observer.observe(contentRef.current);

// 150px 阈值判断"在底部附近"
const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
```

面试时这样讲：
> 消息发送用了乐观更新：先用 clientMessageId 插入本地列表，服务端确认后替换为真实消息，失败则标记错误。用户感知是"发出即显示"。加载历史消息时，用 layoutEffect 在 DOM 更新后立即修正 scrollTop：新位置 = 旧位置 + 新增高度差。再加上 ResizeObserver 监听内容尺寸变化，用户在底部时自动跟随新消息。

---

### 后端篇

### 难点 6：移动浏览器 WebSocket 断连恢复

**问题**：手机切后台、锁屏、切网络后，WebSocket 连接可能被浏览器挂起甚至断开。用户切回来后：
- 消息停止接收（连接已死但没有触发 disconnect 事件）
- 在线成员数不准确
- 房间状态过时

**解决方案** — 多层恢复机制：

1. **Page Visibility API**：监听 `visibilitychange`，页面恢复前台时检查连接健康度。
2. **主动重连判断**：不是无脑重连。用 `ensureRoomJoined` 先检查当前房间是否仍然 joined，避免重复 join 导致成员数翻倍。
3. **in-flight 请求复用**：短时间内多次恢复（快速切换前后台）复用同一个恢复请求，不重复发。
4. **恢复状态延迟显示**：健康连接下的 rejoin 是毫秒级的，只有超过 400ms 未完成才显示"重连中"，避免每次切前台闪一下转圈。
5. **密码房复用**：会话内记住已验证的密码，恢复时自动带上，不让用户重新输入。

面试时这样讲：
> 移动端 WebSocket 恢复是我们踩坑最多的地方。核心思路是"不信任连接状态"——页面回到前台就检查，但不无脑重连。我们有一个 `ensureRoomJoined` 做幂等 rejoin，加上 in-flight 去重和延迟转圈，用户基本感知不到断连过程。

### 难点 7：Redis → PostgreSQL 持久化迁移

**问题**：系统最初用 Redis 做全量持久化。Redis 虽然快，但：
- 数据全在内存，成本随数据量线性增长
- 没有关系约束，数据一致性靠应用层保证
- 备份和恢复不如关系型数据库成熟

**解决方案** — 渐进式迁移，不停服：

1. 抽象出 `DurableRoomStore` 接口，`RedisStore` 和 `PostgresStore` 各自实现。
2. `CompositeRoomStore` 组合 durable + realtime，切换 durable 实现只需要改环境变量。
3. 写了幂等迁移脚本 `migrate:redis-to-postgres`，支持 dry-run。
4. 加了 `smoke:persistence` 安全测试，保护不会误连生产 Redis。
5. 回滚是纯配置切换：`PERSISTENCE_STORE=redis`，因为迁移期间不删 Redis 数据。

面试时这样讲：
> 我们做了一个 Store 接口抽象层，Redis 和 PostgreSQL 各自实现相同接口。上层代码完全不知道底下是哪个数据库。切换只需要改一个环境变量，回滚也是。迁移脚本是幂等的，可以反复跑。这样我们在生产环境做了零停机迁移。

### 难点 8：房间状态同步与一致性

**问题**：多个客户端同时操作房间设置（改名、设密码、改发言时间段），客户端的房间对象可能过时。

**解决方案**：

1. **整体替换而非合并**：服务端返回完整的 room 对象，客户端收到后整体替换本地状态，不做字段级 merge。
2. **`room_version` 单调版本号**：PostgreSQL 行级自增，客户端按 version 比较新旧，不依赖时间戳（时钟漂移不可靠）。
3. **ack read-your-write**：客户端修改设置后，ack 返回最新的 room 对象，立即更新本地，不等广播。

面试追问：**为什么不用 CRDT？**
> 房间设置是低频操作，last-write-wins 够用。CRDT 适合高频并发编辑（协同文档），引入复杂度不值得。我们的 version 号保证了排序，整体替换保证了最终一致。

### 难点 9：AI 多 Provider 抽象

**问题**：接入了 DeepSeek、Anthropic、OpenAI、OpenRouter 四个 AI 提供方，每个的 SDK、定价、限流策略不同。

**解决方案**：

```text
aiModels.ts   — model registry: model ID → { provider, apiModel, pricing, ... }
aiClients.ts  — client factory: provider → SDK client instance
aiHandlers.ts — streaming logic: provider-agnostic chunk forwarding
```

- `aiModels.ts` 维护一个 model registry，把用户可见的 model ID 映射到具体的 provider 和 API model name。
- `aiClients.ts` 按 provider 类型创建对应的 SDK 客户端（OpenAI SDK 兼容 DeepSeek 和 OpenRouter，Anthropic 用官方 SDK）。
- 流式处理层统一把不同 SDK 的 chunk 格式转成统一的 `ai_chunk` 事件推给客户端。

面试时这样讲：
> 我们用了一个 model registry + client factory 模式。添加新的 AI 提供方只需要在 registry 注册模型、在 factory 加一个 case。流式处理是 provider-agnostic 的，不同 SDK 的 chunk 格式在服务端统一转换。客户端完全不知道后端用的是哪个 provider。

---

## 四、扩展性讨论

面试官喜欢追问"如果用户量增长 100 倍怎么办"，按这个思路答：

### 当前瓶颈在哪

| 组件 | 瓶颈 | 扩展方案 |
|---|---|---|
| 单实例 Node.js | CPU 和并发连接数 | ECS auto scaling，水平扩多个 task |
| PostgreSQL 读 | 消息历史查询 | 读副本 + Redis 缓存（已有 `RoomMessageCacheStore`） |
| PostgreSQL 写 | 高频消息写入 | 写入批量化 / 异步队列 / 分表 |
| Redis | 内存上限 | ElastiCache 升级 / cluster mode |
| S3 | 基本无瓶颈 | S3 自动扩展，无需操心 |

### 水平扩展方案

```text
现在:  1 个 ECS task
10x:   2-4 个 task, Redis adapter 广播, ALB sticky
100x:  按房间做一致性哈希路由, 每个 task 负责一组房间
       PostgreSQL 读副本 + 消息分表
       独立的 AI 请求队列 (SQS + worker)
```

### 如果要支持 10 万并发连接

1. 每个 Node.js 进程约能处理 5-10K WebSocket 连接
2. 10 万需要 10-20 个 ECS task
3. Redis adapter pub/sub 在这个规模开始有压力，可以切到 Redis Streams 或 Kafka
4. 消息持久化改成异步写入（先 ack 客户端，后台批量写 PostgreSQL）

面试时**不要主动讲到 Kafka 级别**，除非面试官追问。先讲简单方案，被追才讲复杂方案，展示你知道什么时候该用什么。

---

## 五、安全设计

| 安全点 | 实现 |
|---|---|
| 传输加密 | HTTPS/WSS，PostgreSQL TLS，Redis TLS |
| 认证 | UUID clientId + token hash，可选 Google OAuth |
| 授权 | 房间成员角色（owner/admin/member），`hasRoomAccess` 检查 |
| 密码房 | bcrypt 哈希存储，验证后 ack 返回 token |
| 媒体隔离 | S3 bucket block all public access，presigned URL 有过期时间 |
| API 限流 | AI 角色草稿按 IP 限速 10 分钟窗口 |
| Socket 注册 | 客户端必须先 `register` 发送 clientId + auth token 才能操作 |
| 环境变量 | secrets 在 SSM Parameter Store / Fly secrets，不进代码 |

面试追问：**clientId 是 UUID，不是登录系统，怎么防冒充？**
> clientId 绑定了 auth token（SHA-256 hash 存储）。注册 socket 时必须同时提供 clientId 和 token，token 不匹配就拒绝。可选地可以绑定 Google 账号做强身份认证。纯 UUID 模式下安全等级类似于 session token——只要不泄露就安全。

---

## 六、测试策略

```text
层级                  工具               覆盖内容
──────────────────────────────────────────────────
单元测试 (server)     Node test runner   store contract, message domain,
                                         AI models, auth, media storage
单元测试 (client)     Vitest + RTL       component rendering, hooks,
                                         state management, i18n
E2E (Redis mode)      Playwright         room flows, message flows,
                                         AI/media/sharing, mobile core,
                                         multi-client realtime
E2E (Postgres mode)   Playwright         persistence-mode regression
i18n 完整性           check:i18n         build 时校验所有翻译 key
```

面试时这样讲：
> 我们用了四层测试。单元测试覆盖核心业务逻辑，E2E 用 Playwright 跑真实浏览器测试用户可见行为。因为有 Redis 和 PostgreSQL 两种持久化模式，E2E 分别跑两套。CI 里还有一个 i18n key 完整性检查，防止加了新 UI 文案忘记翻译。

---

## 七、你做了什么（STAR 法）

面试官会问"你在这个项目里具体做了什么"。准备 2-3 个 STAR 故事：

### 故事 1：PostgreSQL 持久化迁移

- **Situation**：项目最初用 Redis 做全量持久化，数据增长后内存成本上升，且缺少关系约束。
- **Task**：在不停服的情况下迁移到 PostgreSQL。
- **Action**：设计了 Store 接口抽象层，实现 Redis 和 PostgreSQL 双实现，写了幂等迁移脚本和安全 smoke 测试，通过环境变量切换实现零停机迁移。
- **Result**：成功迁移，回滚方案验证通过，数据一致性 100%，PostgreSQL 模式上线后内存成本降低（Redis 只存实时状态）。

### 故事 2：移动端 WebSocket 可靠性

- **Situation**：用户反馈手机切后台回来后消息丢失、需要刷新。
- **Task**：在不改变 Socket.IO 架构的前提下，解决移动浏览器的连接恢复问题。
- **Action**：基于 Page Visibility API 实现多层恢复机制：幂等 rejoin、in-flight 去重、延迟指示器、密码房自动复用。每个机制都有对应的 E2E 测试覆盖。
- **Result**：移动端用户不再需要手动刷新，恢复过程对用户透明，相关 bug 报告归零。

### 故事 3：AI 多 Provider 集成

- **Situation**：最初只接了 OpenRouter 做中转，但部分模型需要直连官方 API 才能使用 prompt caching 等特性。
- **Task**：支持 DeepSeek、Anthropic、OpenAI 直连 + OpenRouter 路由，同时保持用户侧的简单体验。
- **Action**：设计 model registry + client factory 模式，流式处理层 provider-agnostic，支持运行时动态切换模型和 provider。前端展示 usage/cost 元数据，高价模型需要二次确认。
- **Result**：支持 10+ 模型，添加新 provider 只需改配置文件。DeepSeek 直连后 prompt caching 命中率 60%+，AI 调用成本降低约 40%。

---

## 八、常见追问与参考回答

**Q: 为什么用 Socket.IO 而不是原生 WebSocket？**
> Socket.IO 提供了开箱即用的自动重连、房间/命名空间、ack 回调、Redis adapter 多实例广播。原生 WebSocket 这些都要自己实现。对于聊天场景，Socket.IO 省了大量样板代码。

**Q: 为什么不用微服务架构？**
> 当前规模不需要。单体的开发、部署、调试效率远高于微服务。如果将来 AI 处理成为瓶颈，可以把 AI worker 拆出来用队列解耦，但现在拆了是过度设计。

**Q: Redis 挂了怎么办？**
> 实时状态（在线成员、session）丢失，用户需要重连，服务端重建。持久数据在 PostgreSQL，不受影响。消息缓存丢失只是多查一次 PostgreSQL，有性能影响但不丢数据。

**Q: 数据库死锁怎么处理？**
> 当前消息写入是 append-only（INSERT），不存在行锁竞争。房间设置更新用 `room_version` 行级版本号 + `UPDATE ... RETURNING` 原子操作，失败重试。PostgreSQL 的 MVCC 天然避免了读写阻塞。

**Q: 如何保证消息顺序？**
> 每条消息有 server-side timestamp 和 position（单调递增）。客户端按 position 排序显示。不依赖客户端时间戳，因为多设备间的时钟可能不同步。

**Q: 如果让你重新设计，会改什么？**
> 三件事：
> 1. 一开始就用 PostgreSQL 而不是 Redis 做持久化，省去后来的迁移工作。
> 2. Socket 事件的错误返回用结构化错误码，而不是字符串匹配（目前还有少量 regex 匹配遗留）。
> 3. 前端状态管理用 Zustand 或类似库，MessagePage 承担了太多状态编排，组件间共享状态靠 props 传递层级太深。

**Q: 怎么处理大量消息的性能？**
> 两个层面：
> 1. 存储层：消息分页加载（`readMessagePageByRoom`，默认 80 条一页），不一次性加载全部历史。
> 2. 渲染层：React 列表虚拟化可以进一步优化（当前未做，是已知改进点）。
> 3. 缓存层：Redis `RoomMessageCacheStore` 缓存最近消息，cache hit 避免查 PostgreSQL。

**Q: 项目里遇到最难的 bug 是什么？**
> 移动端切后台回来后成员数翻倍。原因是 visibility change 触发重连，重连后 re-join 房间，但旧的 socket 还没断开，服务端认为是两个不同的连接。修复方法是在 `updateRoomMemberCount` 里按 clientId 去重，同一个 clientId 的多个 socket 只算一个成员。

---

## 九、技术选型对比（面试白板题素材）

### 实时通信方案对比

| 方案 | 延迟 | 双向 | 断线重连 | 多实例 | 适合场景 |
|---|---|---|---|---|---|
| HTTP Polling | 高 (秒级) | 否 | N/A | 天然 | 仪表盘刷新 |
| SSE | 低 | 单向 | 自动 | 需要消息总线 | 通知推送 |
| WebSocket | 极低 | 双向 | 需实现 | 需要 adapter | 聊天、游戏 |
| Socket.IO | 极低 | 双向 | 内置 | Redis adapter | 聊天（我们的选择） |

### 数据库选型

| | Redis | PostgreSQL | MongoDB |
|---|---|---|---|
| 数据模型 | KV / Hash / List | 关系型 | 文档型 |
| 一致性 | 最终一致 | 强一致 (ACID) | 可调一致性 |
| 查询能力 | 基础 | SQL 完整 | 灵活查询 |
| 适合 | 缓存、session、实时状态 | 持久化、关系数据 | 非结构化数据 |
| 我们的用法 | 实时层 | 持久层 | 未使用 |

### 部署方案对比

| | Fly.io | AWS ECS Fargate | AWS EKS | Vercel |
|---|---|---|---|---|
| 运维复杂度 | 低 | 中 | 高 | 极低 |
| WebSocket 支持 | 原生 | ALB sticky | Ingress 配置 | 不支持长连接 |
| 成本 (低流量) | ~$5-30/月 | ~$50-60/月 | ~$80+/月 | 不适用 |
| 扩展上限 | 中 | 高 | 极高 | N/A |
| 适合阶段 | MVP / 小团队 | 生产化 | 大规模微服务 | 纯前端/Serverless |

---

## 十、项目数据与指标（准备一些数字）

面试里有具体数字会更有说服力：

- 代码规模：服务端 ~60 个 TypeScript 源文件，客户端 ~50 个组件/hook/工具
- 测试覆盖：276 个服务端测试 + 客户端 Vitest 测试 + 8 个 Playwright E2E spec
- 支持语言：5 种（en/zh/hi/ja/ko）
- AI 模型：10+ 可选，4 个 provider 直连
- 持久化模式：2 种（Redis / PostgreSQL），运行时可切换
- 消息类型：4 种（text / ai / media / sticker）
- 媒体类型：4 种（image / video / audio / file）
- 部署：push to master 自动 CI/CD，~3 分钟完成

---

## 十一、加分项 — 展示工程素养

面试不只看技术实现，也看工程习惯。可以主动提这些：

1. **渐进式迁移**：Redis → PostgreSQL 不是一刀切，而是接口抽象 + 环境变量切换 + 回滚方案。
2. **防误操作**：persistence smoke test 只允许连名字含 `test` 或 `e2e` 的数据库，不可能误连生产。
3. **文档即代码**：`.env.example` 是配置的 single source of truth，README 引用它而不是重复列表。
4. **CI 守门**：部署前校验必需的 Fly secrets，缺了就阻断，不是靠运行时 crash 发现。
5. **幂等设计**：迁移脚本可以反复跑，room upsert + message 按 ID 去重。
