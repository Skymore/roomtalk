# 房间可靠性架构

[English](room-reliability-architecture.md)

状态：当前架构
更新：2026-07-13

本文是客户端房间会话恢复、房间对象收敛、消息同步、媒体连续性和时间型房间
权限的唯一当前文档事实源。源码和测试始终是最终权威。

## 可靠性模型

房间可靠性由四个明确的权威边界组成：

1. `RoomSessionController` 管理当前浏览器标签的 transport registration 与
   desired-room membership。
2. 服务端完整 room object 与单调 `roomVersion` 管理 ack、broadcast、list、join
   和 storage 之间的房间 metadata 收敛。
3. durable message history 与 `historyVersion` 管理消息 reconciliation；
   Socket.IO 和本地 cache 只负责加速 delivery，不是 durable truth。
4. 服务端 authorization 管理 posting permission；客户端只计算下一个时间边界，
   到点后重新向服务端请求判断。

这些权威彼此关联，但 revision 不能混用。Join ack 不是 room-object version，
message history version 不是 membership epoch，reconnect indicator 也不是恢复
scheduler。

## 事实源地图

| 边界 | 当前 owner |
| --- | --- |
| Room-session 状态机 | `client-heroui/src/utils/roomSessionController.ts` |
| Socket.IO transport adapter 与诊断 | `client-heroui/src/utils/socket.ts` |
| React 投影与浏览器 lifecycle event | `client-heroui/src/pages/MessagePage.tsx` 和 `client-heroui/src/hooks/useRoomSession.ts` |
| 消息 listener、cache hydration 与 history reconciliation | `client-heroui/src/hooks/useRoomMessageEvents.ts` 和 `client-heroui/src/components/MessageList.tsx` |
| Room-object 排序与整体替换 | `client-heroui/src/utils/roomState.ts` 和 `client-heroui/src/pages/MessagePage.tsx` |
| Posting boundary 调度 | `client-heroui/src/utils/postingSchedule.ts` |
| Per-socket membership 串行化与 canonical room ack | `server/src/socket/roomHandlers.ts` |
| Durable room version | `server/src/repositories/postgresStore.ts` 和 `server/src/repositories/redisStore.ts` |

## Room Session Controller

`RoomSessionController` 是以下状态的唯一客户端 owner：

- transport connection readiness；
- 当前 Socket.IO socket ID 是否已注册；
- 当前浏览器标签的 desired room 和会话内 password；
- join/rejoin attempt 与 retry budget；
- room-session epoch；
- message resync revision；
- 对外 session phase 与 terminal error。

浏览器 lifecycle handler、React page 和普通 socket helper 只能提交 intent 或订阅
snapshot，不能直接发 `register` / `join_room`，也不能维护平行的 membership
generation。

### 对外状态

控制器发布 immutable snapshot：

| 字段 | 含义 |
| --- | --- |
| `phase` | `idle`、`connecting`、`registering`、`joining`、`ready`、`retrying` 或 `unavailable` |
| `roomId` | 当前 desired room，不是某个组件正在展示的 view |
| `socketId` | 产生该 snapshot 的 socket ID |
| `sessionEpoch` | desired-room/socket pair 的身份 |
| `resyncRevision` | 独立触发 message history reconciliation 的 revision |
| `result` | 最近一次已验证的 room、permissions 与 member count |
| `source` | 发起当前 transition 的事件 |
| `attempt` | 当前 epoch 内的 attempt，不是 epoch |
| `error` | `unavailable` 的 terminal error；暂态 retry error 留在控制器内部 |

React 只用一个条件推导 `isRoomSessionReady`：snapshot 对当前展示房间处于
`ready`。

### Epoch 与 revision 规则

`sessionEpoch` 只在以下情况推进：

1. desired room 发生变化，包括离开房间；
2. 已有 desired room 时，连接建立在不同的 Socket.IO socket ID 上。

它不会因列表/聊天页面切换、`visibilitychange`、`pageshow`、`online`、retry、
重复调用、registration ack 或 join ack 而推进。

`resyncRevision` 是独立数据流，只在以下情况推进：

1. 一个 session epoch 第一次到达 `ready`；
2. 同一 session 仍 ready 时，前台/BFCache event 要求 reconciliation。

一起到来的 `pageshow`、`visibilitychange` 和 `online` 会被合并，至多推进一次
resync revision。对于已 ready 的 socket/room pair，它们不会再次发 join。

### 状态转移

```text
idle
  -- select room, disconnected --> connecting
  -- select room, connected ----> registering

connecting
  -- connect -------------------> registering
  -- connection deadline -------> unavailable

registering
  -- register ack --------------> joining
  -- disconnect ----------------> retrying
  -- transient timeout ---------> retrying -> registering
  -- definitive rejection ------> unavailable

joining
  -- join ack ------------------> ready             [resyncRevision + 1]
  -- disconnect ----------------> retrying
  -- transient timeout ---------> retrying -> joining
  -- definitive rejection ------> unavailable

ready
  -- same-room navigation ------> ready             [无 join、无 epoch]
  -- foreground resync ---------> ready             [resyncRevision + 1、无 join]
  -- disconnect ----------------> retrying           [保留已渲染数据]
  -- select another room -------> joining/registering [epoch + 1]

retrying
  -- connect/register/join -----> ready
  -- retry budget exhausted ----> unavailable

unavailable
  -- explicit retry ------------> connecting/registering/joining [同一 epoch]
  -- select another room -------> connecting/registering/joining [epoch + 1]
```

### 并发与 lifecycle 规则

- Registration 按 socket ID 合并；需要 ack 的 socket operation 等待同一个
  registration promise。
- 同一房间仍在请求中时再次选择该房间，会返回同一个 completion promise 并
  保留原始 initiating source。
- 新房间立即 supersede 旧 completion；迟到结果不能更新 snapshot。旧房间的
  迟到成功 join 会得到防御性 `leave_room` cleanup。
- 当前 join timeout 后可在同一 epoch 内 retry；retry attempt 不推进
  `sessionEpoch` 或 `resyncRevision`。
- `visibilitychange`、BFCache `pageshow` 和 `online` 只调用 `resume`；React 不
  拥有 membership timer、generation 或 join promise。
- 页面可以延迟 reconnect indicator 以避免闪烁，但这个 UI timer 不驱动恢复。

## 消息与媒体连续性

Session readiness 控制新的 privileged work：

- 发送、编辑、删除消息；
- 请求新的 signed media URL；
- 房间设置、workspace read 与其他 member-only operation。

Session readiness 不会清除已经渲染的状态：

- `connecting`、`registering`、`joining`、`retrying` 期间，内存和 IndexedDB
  message window 仍然可见；
- 已有 object URL / signed URL 继续绑定 media element；
- media hook 暂停新的 access-controlled lookup/fetch，而不是清空当前 URL。

消息 listener 与 persistent-cache hydration 按 `roomId` 绑定，不按 readiness
绑定，因此暂态重连不会卸载它们。独立 effect 只在控制器 ready 且
`resyncRevision` 变化时发出 `get_room_messages`。

`historyVersion` 负责 server/local message window 排序。它既不是 room session
epoch，也不是 room metadata version。响应证明本地 window 陈旧时，消息层从
durable history 收敛，不创建另一次 join。

## Room object 收敛

服务端 room object 是完整值，不是 patch。每个被接受的 room object 都整体替换
旧对象，因此关闭 `postingSchedule` 或清除 `hasPassword` 后，服务端省略的 optional
field 会真正消失。

所有 room ingress path 使用同一排序规则：

```text
incoming roomVersion > local -> replace
incoming roomVersion == local -> 同一次写入；安全 no-op 或 replace
incoming roomVersion < local -> ignore
missing roomVersion -> legacy updatedAt fallback
```

`roomVersion` 是服务端拥有的 per-room 单调序列。PostgreSQL 在 canonical row
mutation boundary 内持锁推进；Redis Lua script 根据存储 record 原子推导下一个
值。Version 只在同一 room 内可比较。`updatedAt` 只用于展示和 legacy fallback，
不是正常排序权威。

`MessagePage` 会先同步推进 `currentRoomRef`，再 enqueue 带 guard 的 React update。
这样即使 ack 和 broadcast 在同一个 React commit window 内到达，也能看到同一个
最新 room。Local persistence 只保存已接受的 canonical object。

## Ack、broadcast 与 membership

客户端消费的 room metadata mutation 会在 ack 返回 canonical saved room，并在
适用时向其他客户端 broadcast 同一份 authoritative state。两条路径都经过同一
个完整对象/version guard 收敛；persistence 失败时，两条路径都不能发出 ghost
update。

发起 mutation 的客户端因此可直接从 ack 获得 read-your-write，不依赖收到自己
的 broadcast。相等 `roomVersion` 使 ack/broadcast 的重复 delivery 幂等。

服务端把会改变同一个 socket registration 或 room presence 的 operation 全部
放在 per-socket mutation queue 中串行执行。`register`、overlapping join、
`leave_room`、re-registration 与 disconnect 不会在异步 store work 后乱序提交。
Join 会在 commit time 再次验证 durable access，成功前不会离开原来的健康房间。

Realtime presence 与 durable membership 是两个概念。Leave/disconnect 移除
realtime presence；durable membership 继续作为密码房和 room role 的 access
grant。

## Posting window 重新验证

服务端是 actor 当前能否发帖的事实源。即使没有 socket event，permission
snapshot 也会在时间跨过 schedule boundary 时变旧。

客户端只镜像 timezone/overnight boundary 计算，调度下一个相关边界，并在到点
后重新向服务端请求 room permission；它不会本地翻转 `canPost`。客户端与服务端
使用共享 scenario vector 覆盖普通窗口、跨午夜、timezone、disabled/empty
schedule 和边界时刻。

## 失败处理

暂态 transport loss 会保留 desired room 和已渲染内容，由 controller retry。
明确失去 access 则不同：`room_removed`、`Room not found` 与显式 access removal
会失效 room cache，并通过页面的 room-domain handling 离开房间。

Password/access rejection 对当前 attempt 是 terminal。切换到不同房间时，旧健康
房间不会在新房间成功 commit 前被丢弃，因此被拒绝的切房可以回到原房间。

现存协议债是稳定的 machine-readable room error code。部分路径仍通过
`/room not found/i` 等字符串分类；后续协议工作应替换成共享 code，但不改变
本文定义的状态 ownership。

## 生产诊断

浏览器日志会在不记录 password、token 或 message content 的前提下暴露状态机：

- `[room-session]` 记录 transport、registration、join、phase、retry、epoch、
  readiness 与 resync transition；
- `[room-messages]` 记录 persistent-cache hydration 与按版本进行的 history
  request/response reconciliation。

排查时关联 `roomId`、`socketId`、`sessionEpoch`、`resyncRevision` 和
`historyVersion`。

正常 cold restore 顺序是：

```text
room-selected -> connection-waiting -> socket-connected
-> registration-attempt -> registration-ready
-> join-attempt -> room-ready
-> history-request -> history-response
```

一个 epoch 内，成功 join 应只产生一次 `room-ready`。已经 ready 时的前台
lifecycle signal 可以产生 `resync-requested` 与新的 history request，但不能产生
`join-attempt`。已有 desired room 时切换到新 socket ID，会创建新 epoch 并重新
执行 registration/join。

## 验证合约

当前自动化覆盖包括：

- `roomSessionController.test.ts`：connection/register/join 事件序列、同房间合并、
  socket replacement、timeout、supersession 与迟到 ack cleanup；
- `MessagePage.test.tsx`：current-room 投影、内容连续性、完整对象替换、陈旧版本
  拒绝、ack read-your-write 与 posting-boundary permission refresh；
- `useRoomMessageEvents.test.tsx` 和 `MessageList.test.tsx`：cache hydration、
  resync/history reconciliation 与 unready 时保留内容；
- `roomState.test.ts`：`roomVersion` 排序与 legacy timestamp fallback；
- `postingSchedule.test.ts` 与 `roomAuthorization.test.ts`：两端共享 schedule scenario；
- `roomHandlers.test.ts`：registration、幂等 rejoin、overlapping join 串行化、
  join-then-leave ordering 与 canonical room ack；
- store contract test：PostgreSQL 与 Redis 行为下，混合 room/message mutation 的
  `roomVersion` 单调性。

任何 room recovery 或 room-object synchronization 变更，都必须在 owner layer
增加事件序列或 convergence test，不能再引入 component-local generation、timer
或 repair state machine。
