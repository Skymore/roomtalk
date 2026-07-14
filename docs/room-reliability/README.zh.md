# 房间可靠性系列:入口与总览

[English](README.md)

状态：工程复盘，并指向当前架构事实源
Reviewed: 2026-07-13

2026-06-08 ~ 06-10 的一条完整工程线：从用户报告的三个症状出发，经多轮对抗 review，逐步修复房间恢复与状态同步。房间对象、排序、ack 和 posting window 的结论仍然有效；当时的中间 reconnect scheduler 已在 2026-07-13 被 [Room Session Controller 架构](../room-session-controller-design.zh.md)取代。下方详细文档是当时的证据、推演和 review 记录，其中的 `file:line` 与测试数量属于历史快照；当前实现以源码和测试为准。

现行不变量已按 `master` 复核：2026-07-13。

> 当前状态：主线修复仍有效。已再次确认的协议债是 socket ack/error 尚未统一稳定错误码；客户端仍有 `/room not found/i` 文案匹配，服务端多数 room ack 仍只有 string error。

## 症状 → 根因 → 修复(一行版)

| 用户症状 | 根因 | 修复 |
|---|---|---|
| 恢复房间“转两圈”，第一圈完没人数 | 多个 lifecycle/socket owner 重叠发起工作 + 失败被静默 + 恢复过早清空有用状态 | 历史 scheduler 先减少重复；当前 controller 统一 connect/register/join/retry owner，拆开 session epoch 与 history resync，并保留已渲染内容 |
| disable 排期后界面残留,刷新无效,退房重进才好 | 客户端用 spread 合并服务端房间对象,删不掉"键不存在"的字段;陈旧经 localStorage 永生 | 整体替换 `applyServerRoom` + ack read-your-write |
| 改完 posting time 输入框不随时间解禁 | `canPost` 是服务端时间快照,跨窗口边界无人重算 | 客户端算出下一边界,到点拉取权限 |

## 最终不变量(现行架构,一行一条)

- **会话所有权**：只有 `RoomSessionController` 管理 connect、registration、desired room、join/rejoin、retry budget、phase、epoch 和 resync revision；React 与浏览器 lifecycle handler 只能提交 intent 或订阅 snapshot。
- **Epoch 与 resync**：`sessionEpoch` 只因切房或 socket ID 替换而变化，join ack 不推进 epoch；首次 ready 和合并后的前台 lifecycle signal 推进独立的 `resyncRevision`，已经 ready 的 session 不重复 join。
- **内容连续性**：暂态 `connecting`/`registering`/`joining`/`retrying` 阻止新的 privileged work，但保留 cache message 与已解析 media 的显示。
- **恢复反馈**：主动恢复(storage/manual/url)显示进度；很短的 reconnect 延迟显示提示以避免闪烁，这个 UI delay 不是恢复 scheduler。
- **房间状态应用**:服务端房间对象是完整真值,一律**整体替换**;客户端排序按 `roomVersion`（数据库列 `room_version`，Redis 用 Lua 原子递增）,版本相等 ⟺ 同一次写入；`updatedAt` 仅作旧数据回落。
- **密码房恢复**：controller 在浏览器会话内保留 desired-room password；整页刷新仍依赖 durable membership（已接受的边界）。
- **posting 窗口**:客户端镜像服务端时区/跨午夜数学(两侧共享测试向量对拍),到点向服务端要权限,不本地翻转。
- **待清理协议债**:用稳定错误码替代 string error / regex matching。

## 文档指路

| 文档 | 什么时候读 |
|---|---|
| [Room Session Controller 架构](../room-session-controller-design.zh.md) | **当前事实源**：ownership、phase/epoch/revision、内容连续性、诊断日志与源码边界 |
| [room-restore-review-fix-plan.zh.md](room-restore-review-fix-plan.zh.md) | **历史记录**：恢复链路的修复决策、失败模式和三轮评审↔作者对话 |
| [room-update-stale-analysis.zh.md](room-update-stale-analysis.zh.md) | 查"房间更新不刷新"的完整根因链(全链路数据流、带 `file:line` 证据、实测复现表) |
| [room-update-review-followup.zh.md](room-update-review-followup.zh.md) | 查对抗 review 的 7 项 finding 与三轮跟进(含 `room_version` 取代时间戳的全过程) |
| [mobile-room-restore-strategy.zh.md](mobile-room-restore-strategy.zh.md) | **历史记录**：最初的移动端 trigger inventory、中间 scheduler 设计、密码房推理与 acceptance flow |

对应 commit 线:`fdfaa12` → `c0d5944` → `6782f7c` → `b249860` → `45065db` → `0a79128`。

这条 commit 线和详细文档用于解释问题如何被发现与修复，不应作为当前实现说明或行号索引。当前恢复验证入口是 `roomSessionController.test.ts` 的事件序列、`MessagePage.test.tsx` 的页面投影、`useRoomMessageEvents.test.tsx` 的 history reconciliation，以及 `roomHandlers.test.ts` 的 overlapping join / join-then-leave 串行化；room update 与 posting schedule 仍由各自的 version/共享测试向量覆盖。

## 面试 30 秒版

> 用户报了三个症状：恢复时转两圈、关排期后界面残留、改时间后输入框不解禁。逐一溯源后发现是三类问题：**恢复链路**(多个状态 owner + 错误静默)、**状态同步**(spread 合并删不掉字段 + 无写入排序)、**时间快照**(权限不随时间重算)。最终方案分三层：恢复由唯一 `RoomSessionController` 管理 connect/register/join/retry，并把 session epoch 与消息 resync revision 拆开；状态应用改整体替换，排序使用行级单调 `room_version`，让 ack 与广播双路径幂等；posting window 由客户端算边界、到点向服务端取真值，并以共享测试向量防止两端漂移。
