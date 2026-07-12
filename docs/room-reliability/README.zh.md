# 房间可靠性系列:入口与总览

2026-06-08 ~ 06-10 的一条完整工程线:从用户报告的三个症状出发,经多轮对抗 review,最终落成房间会话恢复与房间状态同步的可靠性架构。下方四份详细文档是当时的证据、推演和 review 记录，其中的 `file:line` 与测试数量属于历史快照；当前实现以源码和测试为准。

现行不变量已按 `master` 复核：2026-07-12。

> 当前状态：主线修复仍有效。已再次确认的协议债是 socket ack/error 尚未统一稳定错误码；客户端仍有 `/room not found/i` 文案匹配，服务端多数 room ack 仍只有 string error。

## 症状 → 根因 → 修复(一行版)

| 用户症状 | 根因 | 修复 |
|---|---|---|
| 恢复房间"转两圈",第一圈完没人数 | 4 个恢复触发器各自发请求 + 首轮失败被死 `_error` 静默 + 恢复开头清空人数缓存 | 恢复调度器合并触发 + 错误可见化 + 人数守卫 |
| disable 排期后界面残留,刷新无效,退房重进才好 | 客户端用 spread 合并服务端房间对象,删不掉"键不存在"的字段;陈旧经 localStorage 永生 | 整体替换 `applyServerRoom` + ack read-your-write |
| 改完 posting time 输入框不随时间解禁 | `canPost` 是服务端时间快照,跨窗口边界无人重算 | 客户端算出下一边界,到点拉取权限 |

## 最终不变量(现行架构,一行一条)

- **恢复调度**:前沿触发 + 250ms per-room 抑制窗 + in-flight 复用;失败/断连清抑制窗立即可重试;手动操作清后台状态。
- **恢复反馈**:主动恢复(storage/manual/url)显示 spinner;后台恢复静默,超 400ms 未完成才显示"重连中"。
- **房间状态应用**:服务端房间对象是完整真值,一律**整体替换**;客户端排序按 `roomVersion`（数据库列 `room_version`，Redis 用 Lua 原子递增）,版本相等 ⟺ 同一次写入；`updatedAt` 仅作旧数据回落。
- **密码房恢复**:会话内经 `ensureRoomJoined` 复用 active password;整页刷新仍依赖 durable membership(已接受的边界)。
- **posting 窗口**:客户端镜像服务端时区/跨午夜数学(两侧共享测试向量对拍),到点向服务端要权限,不本地翻转。
- **待清理协议债**:用稳定错误码替代 string error / regex matching。

## 文档指路

| 文档 | 什么时候读 |
|---|---|
| [room-restore-review-fix-plan.zh.md](room-restore-review-fix-plan.zh.md) | 查恢复链路的修复决策(三轮评审↔作者对话留痕:G1/G2 实现期陷阱、debounce 前沿后沿之争等) |
| [room-update-stale-analysis.zh.md](room-update-stale-analysis.zh.md) | 查"房间更新不刷新"的完整根因链(全链路数据流、带 `file:line` 证据、实测复现表) |
| [room-update-review-followup.zh.md](room-update-review-followup.zh.md) | 查对抗 review 的 7 项 finding 与三轮跟进(含 `room_version` 取代时间戳的全过程) |
| [mobile-room-restore-strategy.zh.md](mobile-room-restore-strategy.zh.md) | 查最初的移动端恢复策略设计(系列起点,部分内容已被上面三份演进取代) |

对应 commit 线:`fdfaa12` → `c0d5944` → `6782f7c` → `b249860` → `45065db` → `0a79128`。

这条 commit 线和详细文档用于解释问题如何被发现与修复，不应作为当前行号索引。当前验证入口是 `MessagePage.test.tsx` 的 restore/rejoin/room-version 场景、`socket.test.ts` 的 join reconciliation，以及客户端/服务端共享的 posting-schedule 测试向量。

## 面试 30 秒版

> 用户报了三个症状:恢复时转两圈、关排期后界面残留、改时间后输入框不解禁。逐一溯源后发现是三类问题:**恢复链路**(多触发器无协调 + 错误静默)、**状态同步**(spread 合并删不掉字段 + 无写入排序)、**时间快照**(权限不随时间重算)。修复分三层:恢复收成单一调度器(前沿触发 + 抑制窗 + 断连重置);状态应用改整体替换,排序用行级单调版本号 `room_version`——外部 review 指出过 `NOW()` 是事务时间戳非严格全序,版本号方案让"版本相等即同一次写入",ack 与广播双路径天然幂等;posting 窗口由客户端算边界、到点向服务端取真值,两端实现用共享测试向量对拍防漂移。全程测试先行:先写 red test 复现,修复转绿，并保留 focused unit 与 E2E 回归。
