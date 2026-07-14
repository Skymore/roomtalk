# 房间会话控制器架构

[English](room-session-controller-design.md)

状态：当前架构
更新：2026-07-13

本文是当前客户端房间会话合约。源码和测试始终是最终事实源；
`docs/room-reliability/` 下较早的移动端恢复策略与 review 计划，是本控制器
所替代实现的历史记录。

## 历史问题

引入 `RoomSessionController` 之前，客户端同时存在两套相互独立的房间会话
状态机：

- `utils/socket.ts` 管理 socket 注册、join intent、迟到 ack 和成员关系修复；
- `pages/MessagePage.tsx` 管理 restore generation、后台 suppression、重连提示，
  以及第二套 ready/unavailable 状态。

消息和媒体组件又把页面临时的 `ready` 同时解释为授权状态和内容可见性。
因此一次短暂 transport 切换可能清掉已经安全显示的消息/媒体，每个浏览器
lifecycle signal 也可能意外创建新的 join generation。

服务端本来就通过每个 socket 的单一队列，顺序执行 `register`、`join_room`、
`leave_room`、重新注册与 disconnect 成员关系 mutation；Socket.IO 在同一连接
上也保持 packet 顺序。本次重构保留了该后端合约，并删除了客户端第二套
ack 顺序修复算法。

## 事实源地图

| 边界 | 当前 owner |
| --- | --- |
| 会话状态机 | `client-heroui/src/utils/roomSessionController.ts` |
| Socket.IO transport adapter 与诊断日志 | `client-heroui/src/utils/socket.ts` |
| React snapshot 投影与浏览器 lifecycle event | `client-heroui/src/pages/MessagePage.tsx` 和 `client-heroui/src/hooks/useRoomSession.ts` |
| 消息监听、cache hydration 与 history reconciliation | `client-heroui/src/hooks/useRoomMessageEvents.ts` 和 `client-heroui/src/components/MessageList.tsx` |
| 每 socket 成员关系串行化 | `server/src/socket/roomHandlers.ts` |

其他客户端层都不能拥有自己的 room membership generation，也不能直接发出
`register` 或 `join_room`。

## 唯一所有权

`RoomSessionController` 是以下状态的唯一客户端 owner：

- transport 连接是否可用；
- 当前 Socket.IO socket ID 是否已注册；
- 当前浏览器标签想进入的房间及会话内密码；
- join/rejoin attempt 与 retry budget；
- room-session epoch；
- message resync revision；
- 对外 session phase 与最终错误。

浏览器 lifecycle handler、React page 和普通 socket helper 只能发送事件或订阅
snapshot，不能直接发 `register` / `join_room`，也不能维护平行的 membership
generation。

## 对外状态

控制器发布 immutable snapshot：

| 字段 | 含义 |
| --- | --- |
| `phase` | `idle`、`connecting`、`registering`、`joining`、`ready`、`retrying` 或 `unavailable` |
| `roomId` | 当前 desired room，不是某个组件正在展示的 view |
| `socketId` | 产生该 snapshot 的 socket ID |
| `sessionEpoch` | desired-room/socket pair 的身份 |
| `resyncRevision` | 独立触发消息 history reconciliation 的 revision |
| `result` | 最近一次已验证的 room、permissions 与 member count |
| `source` | 发起当前 transition 的事件 |
| `attempt` | 当前 epoch 内的 attempt，不是 epoch |
| `error` | `unavailable` 的最终错误；暂态 retry error 留在控制器内部 |

React 只用一个条件推导 `isRoomSessionReady`：snapshot 对当前展示房间处于
`ready`。

## Epoch 与 revision 规则

`sessionEpoch` 只在以下情况推进：

1. desired room 发生变化，包括离开房间；
2. 已有 desired room 时，连接建立在不同的 Socket.IO socket ID 上。

它不会因列表/聊天页面切换、`visibilitychange`、`pageshow`、`online`、retry、
重复调用、registration ack 或 join ack 而推进。

`resyncRevision` 是独立的数据流，只在以下情况推进：

1. 一个 session epoch 第一次到达 `ready`；
2. 同一 session 仍 ready 时，前台/BFCache 事件要求 reconciliation。

Resume signal 会合并，所以一起到来的 `pageshow`、`visibilitychange`、`online`
至多产生一次 history 请求。对于已经 ready 的 socket/room pair，它们绝不会
重复发 join。

## 状态转移

```text
idle
  -- select room, disconnected --> connecting
  -- select room, connected ----> registering

connecting
  -- connect(new socket ID) ----> registering       [已有 desired room 时 epoch + 1]
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

## 并发规则

- Registration 按 socket ID 合并；所有需要 ack 的 socket 操作等待同一个
  registration promise。
- 同一房间仍在请求中时再次选择该房间，返回同一个 completion promise。
- 新房间立即 supersede 旧 completion；迟到结果不能更新 snapshot。
- 旧 join 仍等待 callback 时，控制器可以发出更新的 join。服务端 per-socket
  mutation queue 保证更新的 join 最后提交。
- 旧房间的迟到成功 join 会触发该旧房间的 `leave_room` 防御清理，但不会创建
  repair epoch，也不会 replay 当前房间。
- 当前 join timeout 后可安全 retry；服务端串行化保证重复的 desired join 是
  最终 membership mutation。

## 内容与授权

Session readiness 控制新的 privileged work：

- 发送、编辑、删除消息；
- 请求 signed media URL；
- 房间设置、workspace read 及其他 member-only 操作。

Session readiness 不会清除已经渲染的状态：

- `connecting`、`registering`、`joining`、`retrying` 期间，内存与 IndexedDB
  message window 仍然可见；
- 已有 object URL / signed URL 继续绑定到 media element；
- media hook 在身份未验证时暂停新 lookup/fetch，而不是清空当前 URL。

明确失去权限与暂态重连不同。`room_removed`、`Room not found` 与 access removal
会通过页面的 room-domain handling 失效房间 cache 并离开房间。

## 消息同步

消息 listener 与 cache hydration 按 `roomId` 绑定，而不是按 readiness 绑定，
所以暂态重连期间不会卸载。另一个独立 effect 只在控制器 ready 且
`resyncRevision` 变化时发出 `get_room_messages`。

`historyVersion` 继续负责 server/local message window 排序。它不是 membership
epoch；join ack 也不再直接充当 history request counter。

## Lifecycle event 合约

`visibilitychange`、BFCache `pageshow` 与 `online` 只调用控制器的 `resume`。
React 不再维护 timer、generation 或 join promise。当前房间已经 ready 时，
控制器把这些 signal 合并成一个 `resyncRevision`；transport 未 ready 时，它们
复用同一个 room completion 和 drive，而不是替换正在进行的工作。

页面只拥有 presentation：对很短的暂态恢复延迟显示 reconnect indicator；每个
ack result object 只 apply 一次；最终 `unavailable` 才显示错误。这个 UI timer
不是恢复 scheduler。

## 测试模型

控制器测试事件序列，而不是组件 timing：

1. disconnected -> select -> connect -> register -> join -> ready；
2. register ack 前 disconnect -> 新 socket -> register -> join；
3. join 中 disconnect -> 新 socket -> register -> join；
4. ready 后 same-room navigation -> register/join/epoch/revision 都不变；
5. ready 时 `pageshow` + `visibility` -> 一个 resync revision，且不 join；
6. room A join pending -> 选择 room B -> 忽略 A 的迟到结果，B ready；
7. join timeout -> 有界 retry -> ready 或 unavailable；
8. join pending 时 leave -> 迟到成功得到 stale-room cleanup；
9. readiness false 时消息/媒体仍显示，新的 privileged request 仍被阻止。

## 诊断日志

生产浏览器日志会在不输出 secret 的前提下暴露状态机：

- `[room-session]` 记录 transport、registration、join、epoch、phase、retry、
  readiness 与 resync transition；
- `[room-messages]` 记录 persistent-cache hydration 与按版本进行的 history
  request/response reconciliation。

排查 incident 时关联 `roomId`、`socketId`、`sessionEpoch` 和 `resyncRevision`。
一个 join ack 在该 epoch 内应只产生一次 `room-ready`。已经 ready 时的前台
lifecycle signal 可以推进 `resyncRevision`，但不能再次发 join。

## 已完成迁移

客户端迁移已经完成：

1. pure controller 拥有状态机与 retry budget；
2. 对 room-session registration/join/leave，`socket.ts` 只作为 transport adapter；
3. `MessagePage` 订阅唯一 controller snapshot，不再维护 restore generation 与
   repair callback；
4. `roomResyncRevision` 与 join attempt/ack 计数彻底分离；
5. 暂态 unready phase 保留消息/媒体显示，同时阻止新的 privileged work；
6. controller event-sequence test 取代旧 socket repair model。

后端 membership implementation 被刻意保留，因为 per-socket mutation queue 已经
提供所需 ordering contract。服务端 overlapping joins 与 join-then-leave contract
test 会验证最终 ack/membership 反映最后一个串行 mutation。

## 已被取代的文档

以下文件保留调查过程与中间 scheduler 设计，不是当前实现说明：

- `docs/room-reliability/mobile-room-restore-strategy.zh.md`；
- `docs/room-reliability/room-restore-review-fix-plan.zh.md`。

room-reliability 系列其余部分关于 room object 整体替换、单调 `roomVersion`、
read-your-write ack 与 posting boundary 的结论仍然有效，不受本次 session
controller 替换影响。
