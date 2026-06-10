# 移动浏览器恢复房间会话：彻底修复方案

## 背景

用户在手机浏览器中进入聊天室后，可能把页面切到后台、锁屏、切换网络、返回历史页面，或者浏览器直接回收页面进程。恢复后曾出现过两类用户可见问题：

- 页面没有可靠回到原来的房间。
- 房间顶部人数显示为 `0` 或错误值，让用户以为房间状态丢失。

这个问题难点在于，“浏览器恢复网页”不是一个单一事件。不同浏览器、不同手机系统、不同网络状态下，页面可能是完整冷启动，也可能是从 BFCache 直接恢复，也可能只是 JavaScript 继续运行但 WebSocket 已经断掉。因此不能只靠一个 `visibilitychange` 监听补丁解决。

彻底方案应该把“当前房间会话”当成一个可恢复的 session，并让所有入口走同一个可重入流程。

## 当前实现观察

相关代码主要在：

- `client-heroui/src/pages/MessagePage.tsx`
- `client-heroui/src/utils/socket.ts`
- `server/src/socket/roomHandlers.ts`

当前客户端已经有几块能力：

- `localStorage` 会保存当前房间快照和当前视图。
- `MessagePage` 首次挂载时会尝试从本地保存的房间恢复。
- `socket.ts` 用 `activeRoomId` 记住当前房间，socket `connect` 后会自动发 `join_room`。
- 服务端 `join_room` 会返回房间和权限，并广播 `room_member_change`。
- `getRoomMemberCount()` 在没有缓存时返回 `null`，UI 可以显示未知态而不是错误的 `0`。

之前的 `3651846 Fix mobile room restore loading states` 是一个方向正确但不完整的修复：

- 它改善了首次从 `localStorage` 恢复时的 loading 状态。
- 它避免成员数未知时直接显示 `0`。
- 它让本地保存的房间先进入 UI，再异步验证房间是否存在。

但它没有覆盖所有恢复入口。特别是页面已经在房间里，然后手机后台一段时间再回来时，当前实现不能保证重新完成“注册 socket -> join 房间 -> 刷权限 -> 刷消息 -> 刷成员数”这一整套流程。

`bf9ada3 Fix room online member counts` 主要解决服务端在线人数统计和断开清理问题，它也不是完整的客户端恢复方案。

## 恢复场景拆分

### 1. 首次打开房间 URL

例子：用户点击分享链接 `?room=<id>`。

这时不能信任本地保存的旧房间，URL 参数优先。正确流程：

1. 读取 URL 里的 `roomId`。
2. 调用服务端读取房间信息。
3. 如果房间存在，弹出加入确认或密码输入。
4. 用户确认后走统一的 `ensureActiveRoomSession(roomId, password)`。
5. join ack 成功后再进入聊天视图。

失败处理：

- 房间不存在：清理 URL 参数或回到房间列表，显示“房间不存在”。
- 需要密码：停在加入确认弹窗。
- socket 无法连接：保留待加入状态，提示网络问题，允许重试。

### 2. 页面冷启动后从本地存储恢复

例子：浏览器进程被系统杀掉，用户重新打开浏览器标签。

这时 JavaScript 内存已经没了，只剩 `localStorage`。正确流程：

1. 读取保存的 `currentRoom` 和 `view`。
2. 先把 UI 置为 `restoring`，不要把成员数显示成 `0`。
3. 用服务端重新验证房间是否存在。
4. 走统一的 `ensureActiveRoomSession(roomId)`。
5. join ack 返回后，用服务端返回的新房间覆盖本地快照。
6. 刷新权限、消息、成员数。

注意点：

- 本地保存的房间只能作为临时 shell，不能当成权威状态。
- 房间名、房主、密码状态、发帖时段、权限都可能在用户离线时变化。
- 如果房间已删除，必须清掉本地保存的当前房间。

### 3. 手机后台恢复

例子：用户在聊天室里，切到微信或锁屏，几分钟后回到浏览器。

浏览器可能没有销毁页面，但 WebSocket 可能已经断开，或者 socket 看起来还在但服务端已经清理了这个 socket 的房间 membership。正确流程：

1. 监听 `visibilitychange`，当页面变成 `visible` 时触发恢复。
2. 不能只刷新消息，必须重新确认当前房间 session。
3. 调用同一个 `ensureActiveRoomSession(currentRoom.id)`。
4. 成功后刷新消息、权限、成员数。

这里要避免一个常见误区：`socket.connected === true` 不等于“服务端认为你还在房间里”。移动端后台冻结后，客户端和服务端对连接状态的认知可能短时间不一致，所以前台恢复时要做显式 join ack。

### 4. BFCache 恢复

例子：用户从聊天室跳到另一个页面，再用浏览器返回按钮回到聊天室。Safari 和 Chrome 都可能使用 BFCache。

BFCache 会冻结整个页面，包括 JavaScript heap。恢复时 React 组件可能不会重新 mount，所以只依赖 `useEffect(() => ..., [])` 不够。

正确流程：

1. 监听 `pageshow`。
2. 如果 `event.persisted === true`，说明页面从 BFCache 恢复。
3. 走 `ensureActiveRoomSession(currentRoom.id)`。
4. 同时刷新消息和成员数，因为恢复期间可能错过 socket 事件。

实际实现中，即使 `event.persisted` 不存在，也可以在 `pageshow` 时做轻量检查；如果当前没有房间就不做事，如果已有房间就走幂等恢复。

### 5. socket 自动重连

例子：地铁里网络从 Wi-Fi 切到 5G，或者服务端短暂重启。

Socket.IO 自带重连，但仅重连传输层不等于恢复业务 session。正确流程：

1. socket `connect` 后先完成客户端身份注册。
2. 注册必须有 ack，客户端要知道服务端已经把 `socket.id -> clientId` 建好。
3. 如果有 active room，发 `join_room` 并等待 ack。
4. join 成功后通知页面刷新房间数据。

当前代码里 `connect` 事件会发 `register`，随后如果有 `activeRoomId` 就发 `join_room`。风险在于 `register` 没有 ack，`join_room` 可能在服务端尚未登记 clientId 时执行，导致服务端返回 `You are not registered`。彻底修复需要把 socket 的连接状态分成：

- transport connected
- client registered
- room joined

只有第三个状态成立，消息发送、AI 请求、权限操作才算安全。

### 6. 离线后恢复

例子：用户进入隧道断网，再恢复网络。

正确流程：

1. 监听 `online` 事件。
2. 调用 socket reconnect。
3. 走 `ensureActiveRoomSession(currentRoom.id)`。
4. 恢复期间输入框可以保留草稿，但发送按钮应该禁用或进入重试状态。

`offline` 时不应该立刻清除当前房间，因为这只是网络状态，不代表用户主动离开。

### 7. 多标签页

例子：用户在同一台手机或电脑打开同一个房间的两个标签页。

这里要先定义产品语义：

- 如果“人数”表示在线用户数，同一个 `clientId` 的多个 socket 应该算 1 人。
- 如果“人数”表示在线连接数，多个标签页可以算多个连接。

聊天产品通常更符合“在线用户数”。服务端统计应以 `(roomId, clientId)` 去重，同时保留 socket 级 session 用于断开清理。否则同一用户多开标签会导致人数膨胀。

### 8. 房间状态在后台期间变化

例子：用户后台期间，房主删除房间、转让所有权、修改发帖时段、添加密码、移除管理员。

正确流程：

1. 恢复时不能只恢复 messages。
2. 必须重新读取 room、permissions、posting schedule、role members 或至少让相关组件拿到新版本。
3. 如果权限下降，隐藏对应操作。
4. 如果房间被删除，退出当前房间并清理本地保存状态。

这也是为什么恢复流程必须以服务端状态为准，而不是继续信任 React state 或 localStorage。

## 目标不变量

彻底修复后应满足这些不变量：

1. 只要 UI 显示“我在某个房间里”，客户端就必须已经拿到该房间的 join ack，或者 UI 明确处于 `restoring` 状态。
2. 成员数未知时显示 unknown/loading，不显示 `0`。
3. `send_message`、`ask_ai`、编辑、删除、清空历史等房间操作必须在 registered + joined 后执行。
4. 所有恢复入口都调用同一个恢复函数，避免每个事件里各写一套半截逻辑。
5. 恢复流程必须可重入：连续触发 `visibilitychange`、`pageshow`、`online`、`connect` 时，最终只应用最新一次结果。
6. 房间本地快照只能用于临时展示，最终状态必须由服务端确认。
7. 用户主动离开房间时才清除 active room；网络断开或页面后台不等于主动离开。

## 客户端设计

### 单一恢复接口

建议抽一个 `useRoomSession` hook 或 `roomSessionService`，提供一个统一方法：

```ts
type EnsureRoomSessionOptions = {
  roomId: string;
  password?: string;
  source: "url" | "storage" | "visibility" | "pageshow" | "online" | "socket-connect" | "manual";
};

type RoomSessionResult = {
  room: Room;
  permissions: RoomPermissions;
  memberCount: number | null;
};

async function ensureActiveRoomSession(options: EnsureRoomSessionOptions): Promise<RoomSessionResult>
```

它内部应该做这些事：

1. 生成递增的 `restoreGeneration`。
2. 等待 socket transport connected。
3. 等待 `register` ack。
4. 发 `join_room`，等待 ack。
5. 从 join ack 或后续接口拿到 room、permissions、memberCount。
6. 刷新消息列表。
7. 只有当前 `restoreGeneration` 仍然最新、且用户还在同一个 room 时，才更新 React state。

这样可以防止竞态：

- 用户正在恢复房间 A，马上点进房间 B，A 的异步结果回来后不能覆盖 B。
- `visibilitychange` 和 `socket connect` 同时触发，不能重复制造状态抖动。
- 房间已删除或密码错误时，不能继续显示旧房间 shell。

### 页面事件入口

以下入口都只负责触发统一恢复，不直接写业务细节：

| 入口 | 触发条件 | 动作 |
| --- | --- | --- |
| initial mount | 无 URL room，存在 stored room | `ensureActiveRoomSession({ source: "storage" })` |
| URL join | URL 有 `room` 且用户确认 | `ensureActiveRoomSession({ source: "url" })` |
| `visibilitychange` | `document.visibilityState === "visible"` | 如果有 current room，恢复 |
| `pageshow` | 页面显示，尤其 `event.persisted` | 如果有 current room，恢复 |
| `online` | 网络恢复 | 如果有 current room，恢复 |
| socket `connect` | transport 重连成功 | 注册成功后，如果有 active room，恢复 |
| 手动选房间 | 用户点击房间卡片 | `ensureActiveRoomSession({ source: "manual" })` |

### UI 状态

建议显式维护房间 session 状态：

```ts
type RoomSessionStatus =
  | "idle"
  | "restoring"
  | "joining"
  | "joined"
  | "blocked"
  | "error";
```

使用规则：

- `restoring`：可以显示房间 shell，但顶部人数显示 `...`，输入区禁用发送。
- `joined`：允许发送消息和权限操作。
- `blocked`：例如需要密码、房间不存在、权限不足。
- `error`：网络错误，显示重试入口。

成员数用 `number | null`，不要用 `0` 表示未知。`0` 只能来自服务端明确返回。

## socket 客户端设计

### 注册必须有 ack

当前风险是 socket `connect` 后发了 `register`，但没有等待服务端确认，就可能继续发 `join_room`。

建议改成：

```ts
async function ensureRegisteredSocket(): Promise<void>
```

内部保证：

1. socket 已 connected。
2. 已向服务端发送 `register`。
3. 收到 register ack。
4. 同一 socket 生命周期内重复调用直接复用结果。

### join 必须返回完整恢复所需状态

建议服务端 `join_room` ack 返回：

```ts
{
  success: true,
  room,
  permissions,
  memberCount
}
```

这样客户端不需要等待异步广播的 `room_member_change` 才知道当前人数。广播仍然保留，用来更新其他在线客户端。

### active room 只在 join 成功后更新

规则：

- `activeRoomId` 只在 join ack 成功后设置。
- join 失败时恢复之前的 active room。
- 用户主动 `leaveRoom` 时才清空。
- reconnect、visibility restore、online restore 不应该清空 active room。

## 服务端设计

### join_room 幂等

同一个 socket 重复加入同一个 room 时，应当是幂等操作：

- 不应该先 leave 再 join 导致成员数短暂抖动。
- 不应该重复增加在线人数。
- 应该返回当前 room、permissions、memberCount。

### 在线人数以服务端为准

服务端应该维护实时 presence：

- socket session：`socket.id -> clientId -> rooms`
- room presence：`roomId -> clientId -> socketIds`
- member count：按产品语义决定按 client 去重或按 socket 计数

如果选择“在线用户数”，同一个 `clientId` 多个 socket 在同房间只算 1。

### TTL 和心跳

移动端后台时，disconnect 事件可能延迟，服务端不能只依赖 disconnect 清理。

建议 presence 记录带 TTL：

1. socket 连接时写入 presence。
2. 定期 heartbeat 刷新 TTL。
3. disconnect 时主动删除。
4. TTL 过期兜底清理。
5. 清理后广播新的 memberCount。

这样即使手机系统直接冻结或杀掉页面，服务端人数也会在 TTL 后回归正确。

## 数据刷新顺序

统一恢复成功后的推荐顺序：

1. join ack 返回 room、permissions、memberCount。
2. 更新 `currentRoom`。
3. 更新 `roomPermissions`。
4. 更新 `memberCount`。
5. 请求最新消息。
6. 请求 saved rooms / room list，保证侧边栏状态一致。

如果消息刷新失败，但 join 成功，可以保留房间并显示消息加载错误；如果 join 失败，则不能让 UI 假装已经在房间里。

## 错误处理

| 错误 | UI 行为 |
| --- | --- |
| Room not found | 清除当前房间，回房间列表 |
| Password required/incorrect | 保留目标房间，弹密码输入 |
| Not registered | 重新注册 socket 后重试一次 |
| Network timeout | 显示恢复失败和重试入口，不清除房间 |
| Permission changed | 刷新权限并隐藏不可用操作 |
| Room deleted while active | 退出房间并清除本地 current room |

## 测试计划

### 单元测试

- `ensureRegisteredSocket` 等待 register ack 后才允许 join。
- `ensureActiveRoomSession` 多次并发调用只应用最新结果。
- join 失败时不覆盖已有 active room。
- `memberCount === null` 时 UI 显示 loading，不显示 `0`。

### socket 测试

- `join_room` 对同一 socket 同一房间重复调用是幂等的。
- `join_room` ack 返回 room、permissions、memberCount。
- disconnect 和 TTL 清理都会更新成员数。
- 同一 `clientId` 多 socket 是否去重，按产品语义写测试固定下来。

### React 组件测试

- 从 localStorage 恢复时进入 `restoring`，join ack 后进入 `joined`。
- `visibilitychange` 回到 visible 会触发统一恢复。
- `pageshow persisted` 会触发统一恢复。
- 恢复房间 A 过程中用户切到房间 B，A 的结果不会覆盖 B。

### E2E 测试

- 移动视口进入房间，刷新页面后仍回到房间。
- 进入房间后模拟 `visibilitychange`，确认消息、权限、人数恢复。
- 模拟 `pageshow`，确认页面不会停留在旧状态。
- 两个浏览器上下文同时进房间，断开一个后人数正确。
- 服务端重启或 socket 断连后，客户端能重新注册并重新 join。

### 已落地 E2E 覆盖

当前 Playwright 覆盖集中在默认 Redis E2E 环境，不依赖真实对象存储或外部 Postgres：

- `client-heroui/e2e/room-restore.spec.ts`
  - 硬刷新后从本地 session 恢复当前房间。
  - 同一浏览器存储的新标签页恢复当前房间。
  - 离线再在线后刷新 room session、消息和成员数。
  - 浏览器返回导航后恢复房间状态。
  - 同一 `clientId` 多标签页在线人数按 1 人统计。
  - 前台页恢复时补齐后台期间产生的新消息。
- `client-heroui/e2e/mobile-core.mobile.spec.ts`
  - 移动视口硬刷新后仍恢复当前房间和历史消息。
- `client-heroui/e2e/message-flows.spec.ts`
  - `visibilitychange` 回到 visible 后能拉到期间新增消息。
- `client-heroui/e2e/multi-client-realtime.spec.ts`
  - 多客户端消息、编辑、删除、清空历史和 AI streaming 仍实时同步。

默认命令：

```bash
cd client-heroui
npx playwright test --project=chromium
npx playwright test e2e/mobile-core.mobile.spec.ts --project=mobile-chromium
```

## 分阶段实现建议

### 第一阶段：客户端统一恢复

- 抽 `ensureActiveRoomSession`。
- `visibilitychange`、`pageshow`、`online`、首次 storage restore、手动 join 都走它。
- 加 `restoreGeneration` 防竞态。
- UI 使用 `RoomSessionStatus` 和 `memberCount: number | null`。

这是最能直接修复“手机回来没进房间/人数显示错”的部分。

### 第二阶段：socket 注册和 join ack

- `register` 改为 ack。
- join 之前等待注册完成。
- `join_room` ack 增加 `memberCount`。
- socket reconnect 后走统一恢复，不只是在 socket 层静默 emit。

这是让恢复逻辑变可靠的关键。

### 第三阶段：服务端 presence 加固

- `join_room` 幂等。
- presence 按明确产品语义统计。
- TTL/heartbeat 兜底清理。

这是让人数在异常移动端生命周期下长期正确的关键。

### 第四阶段：补齐回归测试

- 先补单元和 socket 测试。
- 再补移动视口和恢复类 E2E。
- 真机验证 iOS Safari / Chrome Android / 应用内浏览器。

## 面试解释版本

可以这样讲：

> 这个问题不是简单的“监听浏览器恢复事件”。移动端恢复有冷启动、BFCache、后台冻结、socket 重连、离线恢复、服务端 presence 过期等多种情况。我的处理方式是把当前聊天室抽象成一个可恢复的 room session，而不是在每个事件里写临时逻辑。所有入口最终都调用同一个幂等的 `ensureActiveRoomSession`：先确保 socket connected，再确保 client registered，然后等待 `join_room` ack，拿到 room、permissions 和 memberCount，最后刷新消息。UI 上把 `restoring` 和 `joined` 分清楚，成员数未知时不显示 0。服务端则要让 join 幂等，presence 用 TTL 兜底，并在 join ack 里返回权威成员数。这样无论是刷新、后台回来、BFCache 返回、网络重连还是服务端重启，恢复路径都是同一套，测试也能围绕这一套不变量写。

核心点是：不要把 WebSocket connected 当成“已经在房间里”，不要把 localStorage 当成权威房间状态，也不要用 `0` 表示未知成员数。
