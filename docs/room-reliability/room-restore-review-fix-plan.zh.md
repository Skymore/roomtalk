# 房间恢复 Review 评价与修复计划

日期：2026-06-08

审查范围：

- `fdfaa12 fix: harden room session restore`
- `6d71e0b test(e2e): cover room session restore flows`

这份文档用于评价外部 review 中提出的问题，并给出后续修复计划。结论先行：review 的主线判断是对的，尤其是错误静默、恢复触发器未合并、密码恢复路径未使用保留密码这三点。部分关于“转两圈”的因果解释方向正确，但需要更精确地描述为“多恢复入口 + 成员数缓存清空 + 首轮失败或被后续恢复覆盖”的组合问题，而不是固定由四个触发器全部同时触发。

## 总体评价

当前实现已经解决了几个关键基础问题：

- socket 注册有 ack，`ensureRegisteredSocket()` 可以避免未注册就发房间操作。
- `join_room` ack 返回 `room`、`permissions`、`memberCount`，客户端能拿服务端权威状态。
- `roomSessionGenerationRef` 能防止旧恢复结果覆盖新房间。
- 服务端重复 join 同一房间时不会先 leave 再 join，避免同一 socket 重入造成成员数抖动。
- 已补充默认 Redis E2E 和移动视口 reload 恢复测试。

但当前实现还不是“最终形态”。主要剩余风险集中在用户反馈、恢复入口合并、密码房恢复、以及成员数视觉稳定性。

## Review 条目判定

| 编号 | 判定 | 严重度 | 评价 |
| --- | --- | --- | --- |
| #1 恢复失败静默，`_error` 未渲染 | 成立 | P0 | 这是最应该先修的问题。很多失败路径都调用 `setError()`，但 UI 没有读取 `_error`。 |
| #2 移动端唤醒恢复风暴 | 成立，但不是每次都 4 个触发器全触发 | P1 | `visibilitychange`、`pageshow`、`online`、socket `connect` 都会触发恢复，缺少 debounce/in-flight 合并。 |
| #3 密码恢复路径未使用 `ensureRoomJoined()` | 成立，影响条件有限但设计不稳 | P1 | 恢复路径传 `password: undefined`，会丢掉 socket 层保存的密码。当前依赖服务端 durable membership 才能正常。 |
| #4 重连重入逻辑从 socket 层下沉到 React | 部分成立 | P2 | 不一定必须放回 socket 层，但应抽成单一 session 恢复控制器，避免多个 React 监听器各自发请求。 |
| #5 恢复 effect 随 URL 参数变化重订阅 | 成立，低风险 | P2 | `ensureActiveRoomSession` 依赖 `clearRoomUrlParam`，后者依赖 `searchParams`，会造成监听器重订阅。 |
| #6 前台/重连时标题旁 spinner 闪烁 | 成立 | P2 | `isRestoringRoom` 对后台轻量恢复和手动进入房间使用同一个视觉状态，容易产生噪音。 |
| #7 用 `/room not found/i` 匹配错误文案 | 成立 | P1 | 应改成稳定错误码，避免服务端文案变化导致客户端不能清理 deleted room。 |
| #8 `transferOwnershipHint` 孤儿 i18n key | 成立 | P3 | 清理项，不影响行为。 |
| #9 新客户端连旧服务端 register ack 兼容 | 成立但窗口很短 | P3 | 滚动发布期间可能 timeout。需要兼容策略或接受短窗口。 |
| #10 register 部分状态不对称 | 成立但低风险 | P3 | session 可能已经写入，但 room list 读取失败导致 ack false。可优化但不是恢复主风险。 |

二次复核修正：`ChatHeader` 里 `onlineMembers` 不是可见重复渲染。按钮上的 `aria-label={t('onlineMembers')}` 是无障碍标签，弹层里的 `{t('onlineMembers')}` 是可见标题，两者都应该保留。

## 关键证据

### `_error` 是死状态

`client-heroui/src/pages/MessagePage.tsx` 中声明：

```ts
const [_error, setError] = useState<string | null>(null);
const [_success, setSuccess] = useState<string | null>(null);
```

后续有多处 `setError(...)` 和 `showSuccess(...)`，但组件返回的 JSX 没有渲染 `_error` 或 `_success`，也没有传给 `StatusMessage`、toast、modal 或子组件。因此恢复失败、手动 join 失败、保存失败等都可能只写入不可见 state。

影响：

- 存储中的房间已删除：状态会被清理，但用户不知道为什么被踢回列表。
- 弱网恢复失败：用户只看到人数或 spinner 异常，没有错误原因。
- 手动点房间失败：`ensureActiveRoomSession()` catch 后返回 `null`，外层 catch 不会触发，用户可能感觉“点了没反应”。

### 多恢复入口没有合并

`MessagePage` 中同时注册：

- `visibilitychange`
- `pageshow`
- `online`
- `socket.on("connect")`

这些入口都调用 `restoreCurrentRoom()`，后者会：

1. `reconnectSocket()`
2. `ensureActiveRoomSession(...)`
3. `joinRoom(...)`
4. `socket.emit("get_room_messages", { roomId })`

目前没有 debounce，也没有“同一个 roomId 已有恢复 in-flight 时复用 promise”的逻辑。代际守卫只能防止旧结果覆盖新状态，不能阻止重复网络请求和重复房间广播。

影响：

- 手机从后台回到前台时可能连续发多次 `join_room`。
- 每次 join 成功服务端都会广播 `room_member_change`。
- 客户端不会显示“某人加入”的系统消息，所以用户可见副作用主要是 spinner/人数闪烁，而不是消息污染。

### 成员数会被恢复开头打回 `null`

`ensureActiveRoomSession()` 开始时执行：

```ts
setMemberCount(getRoomMemberCount(roomId));
```

而 `getRoomMemberCount()` 在缓存没有该房间时返回 `null`：

```ts
return roomMemberCounts.get(roomId) ?? null;
```

`ChatHeader` 显示：

```tsx
{memberCount ?? "..."}
```

所以每轮恢复开始时，如果本地缓存还没有成员数，头部会从数字变成 `...`。如果恢复入口连续触发，就会出现“转圈和人数状态抖动”。

### 密码恢复路径没有使用保留密码

`socket.ts` 中已有：

```ts
export const ensureRoomJoined = (roomId: string): Promise<RoomJoinResult> => {
  const password = activeRoomId === roomId ? activeRoomPassword || undefined : undefined;
  return joinRoom(roomId, password);
};
```

但 `MessagePage` 恢复路径调用的是：

```ts
joinRoom(roomId, password);
```

后台恢复、`visibilitychange`、`online`、`pageshow`、socket connect 这些路径都没有密码参数。当前服务端对已有 durable member 会跳过密码校验，所以多数情况下不会出问题；但如果服务端 membership 被清理、数据迁移异常、未来改成更严格的成员过期策略，密码房恢复就会失败。

### 错误类型依赖文案匹配

当前客户端用：

```ts
if (/room not found/i.test(message)) {
  ...
}
```

来判断房间是否已删除。这和服务端当前 `'Room not found'` 文案偶然匹配。更稳的协议应该返回：

```ts
{ success: false, code: "ROOM_NOT_FOUND", error: "Room not found" }
```

客户端只判断 `code`，展示文案走 i18n。

## “转两圈，第一次没人数，第二次才有人数”的精确解释

这个现象和 review 中 #2/#4 是同一类问题，但不应简单理解为“四个触发器一定都触发了”。

更精确的解释是：

1. 每一轮 `ensureActiveRoomSession()` 开始都会 `setIsRestoringRoom(true)`，标题旁 spinner 出现。
2. 每一轮恢复开始还会用本地缓存重设 `memberCount`。缓存为空时显示 `...`。
3. 如果这一轮 join 成功，服务端 ack 会带 `memberCount`，`applyRoomSessionResult()` 会把人数填回来。
4. 如果第一轮 join 失败或被断连打断，`finally` 会结束这一轮 spinner，但不会填回成员数；后续另一次恢复成功后才会显示人数。

因此根因不是单点，而是三件事叠加：

- 恢复入口没有合并，可能连续启动多轮恢复。
- 恢复开头会把人数回退到缓存值，缓存空就是 `...`。
- 错误状态不可见，第一轮失败时用户不知道发生了什么。

需要注意：纯粹的 generation 抢占不会产生“两段独立转圈”。被抢占的旧 generation 在 `finally` 中不会关闭 spinner，所以表现更像一段较长的转圈。出现“两段独立转圈，且第一段结束后仍没有人数”，更强地指向第一轮恢复失败或断连，而不是单纯乱序应用。

## 修复目标

修复后应满足这些不变量：

1. 用户主动操作失败必须可见。
2. 后台恢复失败可以低噪音，但不能永久静默；连续失败应有提示或重试入口。
3. 同一个 roomId 的恢复在短时间内只发一轮网络请求。
4. 恢复不会无意义地把已有成员数清成 `...`。
5. JS 会话内的密码房后台恢复不依赖“服务端 durable membership 恰好还在”。
6. 删除房间、密码错误、未注册等错误用稳定 code 分支处理。
7. 手动进入房间、URL join、storage restore、visibility restore、online restore、socket reconnect 共享同一套恢复逻辑。

## 修复计划

### Phase 1：恢复错误可见化

优先级：P0

目标：让已有 `setError()` 和 `showSuccess()` 真的显示出来。

建议实现：

- 在 `MessagePage` 根布局里渲染现有 `StatusMessage`，或使用项目已有 toast 机制。
- `_error` 改名为 `error`，`_success` 改名为 `success`，避免死状态被忽略。
- 根据来源区分提示策略：
  - `manual` / `url`：立即显示错误。
  - `storage`：显示“房间恢复失败，可重试”。
  - `visibility` / `pageshow` / `online` / `socket-connect`：第一次失败可以静默或轻提示，连续失败再显示。
- 定义提示消失策略：
  - success：沿用 2000ms 自动消失。
  - manual/url/storage error：默认保留，用户可关闭；进入房间成功、切换房间、离开房间、重新发起同类操作时清除。
  - background restore error：如果显示，使用短时轻提示或连续失败计数，避免一个后台失败长期挂在界面上。
- `ensureActiveRoomSession()` catch 不应吞掉所有用户主动错误。可以返回 discriminated result，或让手动路径选择性 rethrow。

测试：

- React 测试：mock `joinRoom` reject，手动点击房间后应显示错误。
- React 测试：stored room 不存在时应清理 current room 并显示“房间已不存在”。
- E2E 可选：创建房间后通过 API 删除，再 reload，确认 UI 退出房间且有提示。

验收：

- 所有 `setError(...)` 都能被用户看到或被明确标注为 silent。
- 没有 `_error` / `_success` 这种未读取 state。

### Phase 2：合并恢复触发器

优先级：P1

目标：防止一次前台恢复/网络恢复发多轮 `join_room` 和 `get_room_messages`。

建议实现：

- 抽一个 `scheduleRoomRestore(source)`：
  - `manual` / `url` 可以立即执行，不参与 debounce。
  - `visibility` / `pageshow` / `online` / `socket-connect` 用 leading-edge restore + 150-300ms suppression window 合并。
  - 第一条后台恢复信号立即执行，后续短窗口内的重复信号复用 in-flight promise 或丢弃，不给真实 socket reconnect 额外增加 250ms。
- 增加 in-flight 复用：
  - key 为 `roomId`。
  - 如果同一个 `roomId` 已有恢复 promise，后台来源直接复用。
  - 如果用户手动选择另一个房间，递增 generation 并取消旧恢复应用。
- 合并 source 优先级：
  - `manual` > `url` > `storage` > `online/socket-connect/pageshow/visibility`
  - 只用于日志和错误展示，不影响最终状态。

伪代码：

```ts
const restoreSuppressUntilByRoomRef = useRef(new Map<string, number>());
const inFlightRestoreRef = useRef<{ roomId: string; promise: Promise<Room | null> } | null>(null);

function scheduleRoomRestore(source: RoomRestoreSource) {
  const room = currentRoomRef.current;
  if (!room) return;

  if (inFlightRestoreRef.current?.roomId === room.id) {
    return inFlightRestoreRef.current.promise;
  }

  const now = Date.now();
  const suppressedUntil = restoreSuppressUntilByRoomRef.current.get(room.id) ?? 0;
  if (now < suppressedUntil) {
    return null;
  }

  restoreSuppressUntilByRoomRef.current.set(room.id, now + 250);
  const promise = ensureActiveRoomSession({
    roomId: room.id,
    fallbackRoom: room,
    source,
  }).then((joinedRoom) => {
    if (!joinedRoom) {
      restoreSuppressUntilByRoomRef.current.delete(room.id);
    }
    return joinedRoom;
  }, (error) => {
    restoreSuppressUntilByRoomRef.current.delete(room.id);
    throw error;
  }).finally(() => {
    if (inFlightRestoreRef.current?.promise === promise) {
      inFlightRestoreRef.current = null;
    }
  });
  inFlightRestoreRef.current = { roomId: room.id, promise };
  return promise;
}
```

实现备注：

- 抑制窗按 roomId 记录，不用单个全局时间戳，避免上一个房间的后台恢复影响下一个房间。
- 如果恢复失败、被断连打断，或 `ensureActiveRoomSession()` 返回 `null`，必须清掉该 roomId 的抑制窗，允许下一个网络/前台信号立即重试。
- 手动切房、主动离开房间、URL join 应重置当前 room 的 in-flight/suppression 状态，避免后台恢复状态影响用户主动操作。

测试：

- React 测试：第一次 `socket connect` 触发后立即调用 `joinRoom`，不等待 debounce。
- React fake timers：连续触发 `visibilitychange`、`online`、`connect`，短窗口内只调用一次 `joinRoom`。
- React 测试：第一轮后台恢复返回 `null` 或 reject 后，短窗口内第二个恢复信号可以立即重试。
- React 测试：同 roomId in-flight 时复用请求。
- E2E：现有 `room-restore.spec.ts` 继续通过。

验收：

- 一次移动端前台恢复不会连续闪多次 spinner。
- 服务端不会收到同一 roomId 的重复 join burst。

### Phase 3：稳定成员数和 spinner 策略

优先级：P1

目标：恢复时不把已有成员数无意义地打回 `...`，减少标题闪烁。

建议实现：

- 删除或收敛恢复开头的：

```ts
setMemberCount(getRoomMemberCount(roomId));
```

- 改成在覆盖 `currentRoomRef.current` 之前先抓旧房间 id，再决定是否清空人数。注意 `previousRoomId` 必须物理上位于 `if (fallbackRoom)` 块之前，不能只替换原 `setMemberCount(...)` 所在位置：

```ts
const previousRoomId = currentRoomRef.current?.id ?? null;

if (fallbackRoom) {
  currentRoomRef.current = fallbackRoom;
  setCurrentRoom(fallbackRoom);
}

const cachedCount = getRoomMemberCount(roomId);
if (typeof cachedCount === "number") {
  setMemberCount(cachedCount);
} else if (previousRoomId !== roomId) {
  setMemberCount(null);
}
```

理由：`ensureActiveRoomSession()` 当前会在设置人数前先把 `currentRoomRef.current = fallbackRoom`。如果直接比较 `currentRoomRef.current?.id !== roomId`，当 `fallbackRoom.id === roomId` 时条件恒为 false，切换到一个没有缓存的新房间时会错误保留旧房间人数。旧 id 必须在 ref 覆盖前读取。

实现备注：

- `previousRoomId` 这行不能和 `setMemberCount` 相邻地粘回旧位置；它必须出现在 `if (fallbackRoom)` 之前。
- 如果后续把 fallback shell 更新移动到别的 helper，也要保持“先读旧 room id，再覆盖 current room ref，再处理 memberCount”的顺序。

- 对 spinner 分层：
  - 初次 storage restore、manual join、url join：可以显示 spinner。
  - 后台 visibility/online/socket-connect 轻量恢复：默认不显示，或延迟 300ms 后仍未完成才显示。
    - **2026-06-10 更新**:延迟方案已实现(`RECONNECT_INDICATOR_DELAY_MS = 400`)——后台 rejoin 超过 400ms 宽限期仍未完成才显示"重连中"转圈,完成即消失;健康连接下切前台零闪烁,真断网重连时用户可见反馈。
- `isRestoringRoom` 可以拆成：
  - `isJoiningRoom`：用户主动进入/首次恢复。
  - `isRefreshingRoomSession`：后台恢复，不一定显示在 header。

测试：

- React 测试：已有 `memberCount=2` 时触发 visibility restore，join 未返回前仍显示 2，不显示 `...`。
- React 测试：初次 storage restore 没缓存时允许显示 `...`。
- E2E：`room-restore.spec.ts` 中 member count 仍最终为 1。

验收：

- “第一次转完没人数，第二次才有”不再复现。
- 健康连接下切回页面不出现明显 spinner 闪烁。

## PR 1 落地状态

日期：2026-06-08

本次 PR 1 已落地范围：

- `MessagePage` 渲染现有 `StatusMessage`，把原先未读取的 `_error` / `_success` 改成真实可见的 `error` / `success` 状态。
- storage restore、manual join、URL join 仍显示恢复状态；`visibility`、`pageshow`、`online`、`socket-connect` 这类后台恢复不再驱动 header spinner，避免用户切回页面时看到无意义的转圈。
- 恢复开始时先读取 `previousRoomId`，再应用 `fallbackRoom`，最后按缓存决定成员数：
  - 有缓存数字时使用缓存。
  - 同一个房间后台恢复且没有缓存时保留当前人数。
  - 切到另一个没有缓存的新房间时清空人数，避免把旧房间人数显示到新房间。
- 成功 ack 没带 `memberCount` 且本地也没有缓存时，同一个房间保留当前人数，兼容旧服务端或异常 ack，避免成功恢复后反而掉成 `...`。
- 主动切房、通过 ID 加入房间、离开房间会清掉旧错误和可见恢复状态，避免 stale feedback 留在 UI 上。
- 单测覆盖可见错误、success 提示、后台恢复不显示 spinner、后台恢复保留成员数、旧 ack 缺少人数时保留当前人数、手动切到未缓存房间时成员数清空。

本次 PR 1 明确未包含：

- 未合并 `visibilitychange` / `pageshow` / `online` / socket `connect` 这些恢复触发器。这个属于 Phase 2，需要单独做 in-flight 复用和 suppression window。
- 未修复密码房恢复路径对 `ensureRoomJoined()` / active password 的使用。这个属于 Phase 4。
- 未把 `'Room not found'` 文案匹配改成稳定错误码。这个属于后续协议层修复。

本次验证：

- `npm test -- --run src/pages/MessagePage.test.tsx`
- `npm test -- --run`
- `npm run build`

## PR 2 + PR 3 落地状态

日期：2026-06-09

本次 PR 2 已落地范围：

- 新增后台恢复 scheduler，用于统一处理 `visibilitychange`、`pageshow`、`online`、socket `connect` 触发的恢复。
- 同一个 `roomId` 已有后台恢复 in-flight 时，后续后台信号复用同一个 promise，不再重复发送 `join_room`。
- 第一条后台恢复信号 leading-edge 立即执行，不等待 debounce。
- 成功发起后台恢复后，为当前 roomId 设置 250ms suppression window，窗口内重复信号被忽略。
- 如果后台恢复失败、被 generation 抢占后返回 `null`，或其它异常导致没有 joined room，会清掉该 roomId 的 suppression，允许下一条恢复信号立即重试。
- `reconnectSocket()` 只在真正发起 leading restore 时调用，in-flight 复用和 suppression 命中时不会重复调用。
- socket `disconnect` 会清掉当前房间的后台恢复 suppression 和 in-flight 状态；socket identity 已变化时，后续 `connect` 必须能重新 join 聊天房，不能被刚成功的恢复窗口挡住。
- 手动切房、通过 ID 加房、离开房间、删除当前房间会清掉后台恢复状态，避免后台恢复影响用户主动操作。

本次 PR 3 已落地范围：

- `MessagePage.ensureActiveRoomSession()` 在没有显式 `password` 时调用 `ensureRoomJoined(roomId)`，由 socket 层复用当前 active room 的密码。
- 用户手动输入密码或 URL join 确认密码时仍调用 `joinRoom(roomId, password)`，保证新密码会写回 socket 层的 `activeRoomPassword`。
- socket 单测覆盖：先 `joinRoom(roomId, "secret")`，再 `ensureRoomJoined(roomId)`，第二次 `join_room` payload 会带 `password: "secret"`。

边界说明：

- PR 3 复用的是当前 JS 会话内的 `activeRoomPassword`，覆盖后台恢复、网络恢复、BFCache 等浏览器没有销毁 JS context 的情况。
- 硬刷新或浏览器杀进程后，内存密码会丢失。当前实现没有把房间密码持久化到 localStorage/sessionStorage；如果服务端 durable membership 也失效，客户端仍需要用户重新输入密码。这是安全取舍，后续要不要持久化密码需要单独讨论。
- 服务端稳定错误码还没做，`ROOM_NOT_FOUND` 等 code 化仍属于 Phase 5。

新增测试：

- React 测试：`visibilitychange` + `pageshow` + `online` burst 只产生一次后台 rejoin。
- React 测试：socket `connect` 触发后台 rejoin 且走 `ensureRoomJoined()`。
- React 测试：成功恢复后的 suppression window 内不重复 join，窗口过后可再次恢复。
- React 测试：失败恢复会清 suppression，下一条后台信号能立即重试。
- React 测试：成功恢复后的 suppression window 内如果发生 socket `disconnect` + `connect`，仍会重新 join。
- socket 测试：`ensureRoomJoined()` 复用 active room password。

本次验证：

- `npm test -- --run src/pages/MessagePage.test.tsx src/utils/socket.test.ts`
- `npm test -- --run`
- `npm run build`
- `npm run test:e2e -- e2e/room-restore.spec.ts --project=chromium`

### Phase 4：修复密码房恢复路径

优先级：P1

目标：恢复密码房时使用保存过的密码，避免依赖 durable membership。

建议实现：

- `MessagePage` 恢复路径不要直接调用 `joinRoom(roomId, undefined)`。
- 方案 A：恢复来源没有显式 password 时调用 `ensureRoomJoined(roomId)`。
- 方案 B：在 `socket.ts` 暴露 `joinActiveRoom(roomId, password?)`，内部使用 `password ?? activeRoomPassword`。
- `manual` / `url` 用户输入密码时仍调用 `joinRoom(roomId, password)`，以便更新 `activeRoomPassword`。
- 不能让一次无密码恢复成功后把 `activeRoomPassword` 覆盖成 `null`。

测试：

- socket 单元测试：先 `joinRoom(password)`，再 `ensureRoomJoined(roomId)`，第二次 emit payload 带 password。
- React 测试：visibility restore 调用保留密码路径。
- 可选 E2E：密码房加入后 reload/visibility restore 仍在房间。

验收：

- JS 会话内的密码房后台恢复不依赖服务端 existingMember 分支。
- `ensureRoomJoined` 不再只有测试在用。

### Phase 5：服务端错误码协议

优先级：P1

目标：消除客户端对错误文案的正则匹配。

建议实现：

- 扩展 socket ack 类型：

```ts
type SocketErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_PASSWORD_REQUIRED"
  | "NOT_REGISTERED"
  | "ROOM_ID_REQUIRED"
  | "ROOM_JOIN_FAILED";

type SocketAckResponse = {
  success: boolean;
  code?: SocketErrorCode;
  error?: string;
  message?: unknown;
};
```

- 服务端 `join_room` 返回：
  - 房间不存在：`{ success: false, code: "ROOM_NOT_FOUND", error: "Room not found" }`
  - 未注册：`{ success: false, code: "NOT_REGISTERED", error: "You are not registered" }`
  - 密码错误：`{ success: false, code: "ROOM_PASSWORD_REQUIRED", error: "Room password is required or incorrect" }`
- 客户端用 `code` 做状态分支，用 i18n 做展示文案。
- 保留 `error` 文案作为日志和兼容旧客户端。

测试：

- 服务端 socket 测试覆盖每个 code。
- 客户端 socket 测试确认 reject error 保留 code 或能被上层读取。
- React 测试：`ROOM_NOT_FOUND` 会清理 stored room。

验收：

- 客户端不再出现 `/room not found/i`。
- 服务端文案变更不影响客户端行为。

### Phase 6：低风险清理

优先级：P2/P3

建议项：

- 删除 5 个 locale 中未使用的 `transferOwnershipHint`。
- 恢复 effect 使用稳定 callback/ref，减少 URL 参数变化导致的监听器重订阅。
- register ack 优化：
  - critical registration 成功后先 ack success。
  - room list / saved list 读取失败只影响列表事件，不应让客户端认为注册失败。
- 滚动发布兼容：
  - 如果需要支持新客户端连旧服务端，可在 register ack 超时后做一次兼容 fallback。
  - 如果不支持混部，则文档写清必须先发服务端再发客户端。

测试：

- i18n check 继续通过。
- `npm test -- --run`。
- `npx playwright test --project=chromium`。
- `npx playwright test e2e/mobile-core.mobile.spec.ts --project=mobile-chromium`。

## 推荐执行顺序

建议分两到三个 PR 做，避免一次改太大：

### PR 1：用户可见错误 + 成员数不闪

包含：

- 渲染 error/success。
- 手动 join/storage restore 错误可见。
- 恢复开头不清空已有 memberCount。
- spinner 对后台恢复降噪。

收益：

- 直接解释并缓解“转两圈但没人数”的用户体验。
- 如果第一轮恢复失败，用户或开发者能看到原因。

### PR 2：恢复入口合并 + 密码恢复

包含：

- debounce / in-flight 合并恢复触发器。
- 恢复路径使用 `ensureRoomJoined` 或等价逻辑。
- 增加对应单元和 E2E。

收益：

- 消除重复 join burst。
- 密码房恢复更稳。
- 恢复逻辑更接近单一 session controller。

### PR 3：错误码协议 + 清理

包含：

- 服务端 socket ack 增加 `code`。
- 客户端用 code 分支。
- 删除孤儿 i18n key。
- register ack 语义优化。

收益：

- 消除字符串耦合。
- 让恢复错误处理更适合长期维护。

## 需要 reviewer 重点复查的问题

请重点检查这些点：

1. `error/success` 渲染位置是否会遮挡移动端底部输入框或 modal。
2. 后台恢复失败是否应该立即提示，还是连续失败后提示。
3. debounce 时间取 150ms、250ms 还是 300ms，是否影响真实恢复速度。
4. 手动 join 是否应该绕过 in-flight 合并，避免用户点击后感觉慢。
5. 密码房恢复应该保存密码多久；是否需要在主动 leave 时清除。
6. `ROOM_PASSWORD_REQUIRED` 时，后台恢复是否要弹密码框，还是只显示不可恢复状态。
7. 错误码是否要同时覆盖 HTTP API 和 socket ack。
8. Postgres / Redis 两种 persistence 下 durable membership 语义是否一致。

## 面试解释口径

可以这样解释：

> 这次 review 发现的问题不是恢复核心方向错了，而是恢复机制还缺少产品级收敛。我们已经把恢复抽象成 `ensureActiveRoomSession`，也有 register ack、join ack、generation guard 和 E2E 覆盖。下一步要做的是把所有恢复入口合并成一个调度器，避免移动端前台/网络恢复时重复发 join；把错误状态真正渲染出来，避免失败静默；恢复时不要把已有成员数清空成 unknown；密码房恢复要使用保存过的 active password；最后用稳定 error code 替代字符串匹配。这样可以把“能恢复”提升到“恢复过程稳定、可解释、可测试”。

---

## 二次 Review 回复（对话）

> 评审 → 作者
>
> 先说结论：这份计划我整体认可，可以照着推进。我把每条代码级断言都回源码核对过了，**有两点你比我第一版 review 更细，我服**：
>
> 1. 你把死状态从 `_error` 扩到了 `_success` / `showSuccess`（`MessagePage.tsx:70 / :89`）。这意味着不止错误静默，`shareSuccess` / `copySuccess` / `usernameUpdated` / `chatHistoryCleared` / `roomDeletedSuccess` 这些**成功提示也全是不可见的**。我原稿漏了这半边，确认你是对的。
> 2. 你在 Phase 4 点出 `activeRoomPassword = password || null`（`socket.ts:391`）会把密码冲掉。我核实了：**只要第一次后台恢复走 `joinRoom(roomId, undefined)`，密码就被置 `null`，之后 `ensureRoomJoined` 读到的也是 `null`**。所以"换成 `ensureRoomJoined`"单独做不够，必须同时堵住这次置空——这条你已经写进 `:307`，很关键。
>
> 但我有 **3 处一定要你再确认/反驳**，因为它们会直接影响动手时的代码：
>
> **A. `onlineMembers` "重复渲染两次"（`:39` / Phase 6 `:371`）——我认为是误报，请你复核。**
> ChatHeader 里只有：`:126 aria-label={t('onlineMembers')}`（按钮无障碍标签，不可见）+ `:135 {t('onlineMembers')}`（弹层可见标题）。这是标准的 "aria-label + 标题" a11y 写法，不是重复。**删掉任一个都会损坏无障碍。** → 你能确认这条从计划里去掉吗？还是你看到的是另一处真实的可见重复（如果是，请贴行号）？
>
> **B. Phase 3 的人数守卫（`:269-275`）我判断会失效，请你确认改写。**
> 走到那段之前，`ensureActiveRoomSession` 已经执行过 `currentRoomRef.current = fallbackRoom`（且 `fallbackRoom.id === roomId`），所以 `else if (currentRoomRef.current?.id !== roomId)` **恒为 false**，切到无缓存的新房间时不会清成 `...`，会继续显示旧房间人数。建议在重设 ref **之前**先 `const previousRoomId = currentRoomRef.current?.id` 再比较，或者干脆这里不调 `setMemberCount`、只让 `applyRoomSessionResult` 写权威值。 → 你认可这个时机问题吗？倾向"抓旧 id"还是"这里不写"？
>
> **C. Phase 2 的 debounce 是后沿（`:231 setTimeout(...,250)`），会给"真重连"加 250ms。**
> 断线重连后的那一次 `connect` 恰恰最该**立即**重入。我建议改成**前沿触发 + 后沿抑制**（首次立刻执行，250ms 内的重复来源复用 in-flight / 丢弃）。 → 你接受默认改成 leading-edge 吗？时间窗仍可在 150/250/300 里选。
>
> 另外 **2 处建议收紧（不阻塞，但希望你点头）**：
>
> - **两圈现象的因果（`:152`）再准一点**：纯被抢占（superseded）**不会**产生两段独立转圈——代际守卫把"跳过 apply"和"跳过 finally 熄灭 spinner"绑在同一判断上，被抢占那轮 spinner 不熄，是一长圈。**要出现"两段独立圈、且第一圈没人数"，第一轮必然是失败/被断连**（成功的 join 一定带回 `memberCount`）。这其实是 Phase 1 P0 最硬的论据，建议补进文档。
> - **Phase 1 顺带定义 error 的消失策略**：`showSuccess` 自带 2000ms 自动清除，但 `setError` 没有。接 `StatusMessage` 时请定义错误何时消失（超时 / 切视图 / 进房成功），否则后台失败提示会一直挂着。
>
> 麻烦你针对 **A / B / C** 明确回一句"确认"或"我有不同看法 + 理由"，我据此再决定 PR 1 的落地写法。其余部分我没有异议。
>
> 作者 → 评审（回复）
>
> - A（onlineMembers 误报）：确认，是我误报。当前源码里 `aria-label={t('onlineMembers')}` 是按钮的无障碍名称，弹层标题 `{t('onlineMembers')}` 是可见标题，不是可见重复。计划中的额外发现和 Phase 6 清理项已删除，两个位置都应保留。
> - B（Phase 3 守卫时机）：确认。原伪代码在 `currentRoomRef.current = fallbackRoom` 之后再比较会失效。落地时应在 ref 被 fallback 覆盖前保存 `previousRoomId`，再按 `cachedCount` / `previousRoomId !== roomId` 决定是否清空。倾向“抓旧 id”，因为完全不写会让手动切到新房间时短暂显示旧房间人数。
> - C（debounce 前沿/后沿）：确认。真实 socket reconnect 应立即重入，不应该被后沿 debounce 人为延迟。默认改成 leading-edge restore + 150-300ms suppression window；第一条恢复信号立即执行，短窗口内重复来源复用 in-flight 或丢弃。
> - 两圈因果补写：确认。文档已收紧：纯 superseded 不会产生两段独立转圈；两段独立转圈且第一段没人数，更强地指向第一轮失败或断连。
> - error 消失策略：确认。Phase 1 已补：success 继续 2000ms 自动清除；manual/url/storage error 默认保留且可关闭，并在成功进入房间、切换/离开房间或重新发起同类操作时清除；background restore error 用短时轻提示或连续失败计数，避免长期挂住。

> 评审 → 作者（第三轮）
>
> A / B / C 和两条收紧我都核对过了，正文也改对了，主线对齐，**计划可以进入实现**。但落地 PR 1 前还有 **2 个实现期的坑**，它们藏在你改后的伪代码里，文字描述对、但照抄代码块会再次踩回去。请你确认会在实现备注里写死：
>
> **G1. Phase 3 的 `previousRoomId` 必须物理上移到 `if (fallbackRoom)` 之前。**
> 你 `:299` 的说明是对的（"旧 id 必须在 ref 覆盖前读取"），但 `:289-297` 是独立代码块。当前 `ensureActiveRoomSession` 的真实顺序是先 `if (fallbackRoom) { currentRoomRef.current = fallbackRoom }`，**之后**才设人数。如果实现时把这段直接粘回原 `setMemberCount(getRoomMemberCount(roomId))` 的位置，`previousRoomId` 又会读到新房间 = 等于没改。→ 请在 Phase 3 实现备注里写明：`const previousRoomId = currentRoomRef.current?.id` 这一行要落在 `if (fallbackRoom)` 块**上面**，不能和 `setMemberCount` 相邻。
>
> **G2. Phase 2 的抑制窗是全局时间戳，且不区分"首轮失败"。**
> `:230 restoreSuppressUntilRef` 是单个 `number`：
> - **失败会误吞重试**：真重连时第一轮在坏网下失败、几十毫秒后网络恢复又来一个信号 → `now < suppressUntil` → 被丢弃，要等下一个触发器才恢复。建议**恢复失败时不进入/清掉抑制窗**（失败立即可重试），正好和 Phase 1"连续失败再提示/可重试"呼应。
> - **抑制窗不分房间**：它由上一个房间的后台恢复设置。因为手动切房走 `handleRoomSelect` 绕过 scheduler，影响有限；若要严谨可改 per-room 或在手动切房时重置 `restoreSuppressUntilRef`。
> → 这两条不阻塞方案，但请写进 Phase 2/3 实现备注，免得 PR 1 又踩回去。
>
> 麻烦你对 **G1 / G2** 回一句"确认写入实现备注"或"有不同看法"。确认后我就按"PR 1 + 这两条修正"直接落地。
>
> 作者 → 评审（回复）
>
> - G1（previousRoomId 提到 fallbackRoom 之前）：确认写入实现备注。Phase 3 已把代码块改成贴近真实 `ensureActiveRoomSession` 顺序：先读取 `previousRoomId`，再执行 `if (fallbackRoom) { currentRoomRef.current = fallbackRoom; setCurrentRoom(fallbackRoom); }`，最后才根据 cached count / previous room 决定是否更新 `memberCount`。备注里也明确写了不能只把这段粘回旧 `setMemberCount(...)` 位置。
> - G2（抑制窗：失败可重试 / per-room）：确认写入实现备注。Phase 2 已把单个全局 `restoreSuppressUntilRef` 改成按 roomId 的 `restoreSuppressUntilByRoomRef`，并补充：恢复失败、断连、或 `ensureActiveRoomSession()` 返回 `null` 时要清掉该 roomId 的 suppression，允许下一个信号立即重试；手动切房/离开/URL join 也应重置对应 in-flight/suppression，避免后台恢复状态影响用户主动操作。
