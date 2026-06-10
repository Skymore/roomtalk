# Room Update 修复的二次 Review 与跟进修复

日期:2026-06-10

对 `6782f7c fix: keep room settings updates from going stale on clients` 做了 7 路独立 finder 的对抗 review(约 30 个候选,逐一回源码裁决:7 项成立、其余证伪)。本文档记录成立的 7 项发现与修复方案,全部(含低优先清理)在本次跟进中修复。

## 发现与修复方案

### F1(P2,设计):`updated_at` 只覆盖 2 条写路径,LWW 全序只是近似

**事实**:`room_updated` 共有 **13 个发射点**(roomHandlers 5 个、messageHandlers 3 个、aiHandlers 5 个——消息追加/编辑/删除、AI 截断都会向 owner 广播完整房间对象),但 `updated_at` 只在 `updateRoomSettings`/`updateRoomName` 两条写路径 bump。Postgres 共 9 条 `UPDATE rooms` 语句,7 条不 bump;Redis 共 6 个 `hSet('rooms', ...)` 写入点,4 个不 bump。

**风险**:活动类写入(lastActivity/messageVersion)的载荷继承当前 stamp,正常时序下等值放行没问题;但跨写路径并发时,晚到的未 bump 载荷会带着旧 stamp 被 LWW 拒绝,丢失一次 lastActivity 更新(可自愈),且 `updatedAt` 的语义("settings 变了"还是"房间变了")模糊。

**修复**:把 bump 落到 chokepoint——
- Postgres:全部 9 条 `UPDATE rooms` 语句统一带 `updated_at = NOW()`;`saveRoom` 的 INSERT 也写入初始 stamp,房间从出生起就有全序;
- Redis:新增私有 `writeRoomRecord(roomId, room)`(写入前盖 `updatedAt` ISO stamp),6 个写入点全部收口到它;
- 契约测试的 fake pool 同步模拟每条新 SQL 的 stamp 行为。

从此 `updatedAt` 语义 = "房间行最后一次变更",客户端 LWW 成为精确全序。

### F2(P2):`transferRoomOwnership` 不 bump 却广播 `room_updated`

creatorId 变更是 settings 级写入,`roomHandlers.ts:914` 会广播。与排期保存并发时,晚到的转移载荷带旧 stamp 会被 LWW 拒绝,客户端丢失 creatorId 变更直到下次 join。**修复**:被 F1 的 chokepoint 覆盖(Postgres 转移 SQL、Redis 写入点都统一 bump)。

### F3(P2,防御):`isNewerRoom` 对无效日期串无防御

`Date.parse` 对损坏的 `updatedAt`(localStorage 污染、旧版本写入)返回 NaN,`NaN >= x` 恒 false → 持有损坏 stamp 的本地房间会**永久拒绝**一切有效更新,直到换房间。**修复**:解析结果 NaN 时视同"无时间戳"放行;顺带把守卫从 MessagePage 下沉到 `utils/roomState.ts`(见 F5),并补 NaN 单测。

### F4(P2,漂移风险):posting 窗口数学客户端/服务端两套实现,无对拍

`client-heroui/src/utils/postingSchedule.ts` 镜像了 `server/src/socket/roomAuthorization.ts` 的时区/跨午夜窗口数学,且 review 发现**服务端 `getPostingAvailability` 自己也没有测试**。任一侧将来单独修改边界语义(如 DST),客户端定时器就会在错误时刻刷新,"到点不解禁"回归。

**修复**:建立共享测试向量对拍——服务端新增 `roomAuthorization.test.ts` 的 `getPostingAvailability` 用例,与客户端 `postingSchedule.test.ts` 使用**同一组场景向量**(同一时刻、同一窗口、两侧分别断言"是否开放"与"距下一边界的时长"互相印证),两侧文件头部交叉引用,改一侧必须同步另一侧。

### F5(P3,简化/altitude):LWW 存在两套平行实现且位于错误层

`applyServerRoom` 用 `isNewerRoom`,`applyRoomSessionResult` 另写了一套内联 baseline/roomToApply;守卫位于 MessagePage,未来新的写入点可绕过。**修复**:`isNewerRoom`/`pickNewerRoom` 移入 `utils/roomState.ts`(与 `upsertRoom` 同层),两条路径共用,MessagePage 不再内联排序逻辑;`roomState.test.ts` 补全单测(含 NaN、缺 stamp、等值放行)。

### F6(P3,效率):12h 上限触发的定时器做无意义权限刷新

边界在 6 天后时,`Math.min(delay, 12h)` 导致每 12h 发一次空的 `getRoomPermissions` 往返(≈12 次/6 天)。**修复**:`armNextBoundary` 区分"到达真实边界"与"仅命中上限"——后者只重新 arm 不刷新。

### F7(P3,健壮性):`update_room_settings` 空更新仍写库并广播

payload 只有 `{roomId}`(无 password/postingSchedule 键)时,handler 仍执行 UPDATE(bump stamp)并广播两条 `room_updated` + 一条失效事件。**修复**:`updates` 为空时直接读回房间返回 `success`,不写不播;补服务端测试。

## 已证伪的主要候选(record,防止反复)

- armNextBoundary 捕获旧 roomId:effect cleanup 必然清掉计时器,极端竞窗下 `refreshRoomPermissions` 内部 ref 守卫也会丢弃结果;
- `delta=0` wrap 到下周:`bestDelta` 取全部边界最小值,同日关门边界仍在候选,wrap 掉刚命中的边界是正确行为;
- 客户端时区 fallback 与服务端 throw 分歧:服务端在写入时即拒绝非法时区,非法值到不了客户端;
- "RoomSettingsModal ack 路径绕过守卫":`onRoomUpdated` 即 `applyServerRoom`,守卫生效;
- Modal seeding ref 时序、权限翻转重置表单、fallbackRoom 绕过守卫、timeoutId 类型:逐一对照实现不成立。

## 实施清单

| # | 改动 | 状态 |
|---|---|---|
| F1/F2 | Postgres 全部 9 条 `UPDATE rooms` + `saveRoom` INSERT/UPSERT 统一 `updated_at = NOW()`;Redis `stampRoomRecord` 收口 6 个 TS 写入点(settings/rename/transfer/save/clear/lastActivity);契约 fake pool 同步模拟 | ✅ 已完成 |
| F3/F5 | `isNewerRoom`/`pickNewerRoom` 下沉 `utils/roomState.ts`,NaN 视同无 stamp 放行;MessagePage 删除内联实现,两条路径共用;`roomState.test.ts` 补 4 组单测(LWW 排序/等值幂等/缺失或损坏 stamp/跨房间) | ✅ 已完成 |
| F4 | 新增 `server/src/socket/roomAuthorization.test.ts`(getPostingAvailability 首批测试,5 组);客户端补"开门瞬间/关门瞬间"两条互补向量;两侧文件头交叉引用,共 10+5 条向量对拍 | ✅ 已完成 |
| F6 | `armNextBoundary` 区分"到达真实边界"与"命中 12h 上限":后者只重新计时不发权限请求 | ✅ 已完成 |
| F7 | `update_room_settings` 空 updates 直接读回房间返回 success,不写库不广播;补 2 条 handler 测试(正向广播 + 空更新无副作用) | ✅ 已完成 |

### F1 的一个已知例外(~~刻意保留~~ → 已在第三轮跟进中关闭)

第一版用 ISO 时间戳时,Redis 的 Lua 消息路径无法低风险盖 stamp,曾作为例外保留。**第三轮跟进改用整数版本号后,该例外已不存在**(整数自增不需要时间戳格式化,Lua 一行即可),详见下文「第三轮跟进」。

> 历史背景:当时的理由是 `REPLACE_MESSAGE_LIST_SCRIPT` 使用变长 ARGV,在 Lua 内传入并格式化 ISO 时间需改动全部脚本及调用方,风险大于收益;prod 的 Postgres 已全覆盖,Redis(dev)等值放行无回归。

## 验收结果(2026-06-10)

- 客户端:**134 用例全绿**(新增:roomState LWW ×4、对拍向量 ×2),`tsc` / `lint` / `check:i18n` 干净;
- 服务端:**176 用例全绿**(新增:getPostingAvailability ×5、update_room_settings ×2;契约测试升级为"saveRoom/rename 必须盖 stamp"的正式断言,fake pool 同步),`tsc` 干净;
- 现有 LWW/边界/disable 复现回归测试无回退。

---

## 第三轮跟进:`room_version` 行级单调版本号(2026-06-10)

### 触发:外部 review 的 P2 finding(判定:成立)

> `updated_at = NOW()` 还不是严格全序。`NOW()` 是 transaction timestamp(冻结在 `BEGIN` 时刻),显式事务下先 BEGIN、后拿锁提交的事务会写出比已提交新状态更早的 stamp;且 JS `Date.parse` 只有毫秒精度,无法区分"同一次写入"和"同毫秒两次写入"。

复核结论:**两点都成立**,且前两轮文档中"LWW 在 prod 是精确全序"的表述过强,予以更正。精确化补充:

- `updateRoomSettings`/`updateRoomName` 是单语句(隐式事务),`NOW()` ≈ 语句执行时刻——**settings 类竞争(原始 bug 类)本来就是安全的**;
- 暴露面在事务包裹的写路径(`appendMessage`/`saveMessageHistory`/`transferRoomOwnership` 等):低概率、可被任何后续写入自愈,但语义上确实不是全序。

### 修复:`room_version`(reviewer 建议的方案 B,弃用方案 A 的 `clock_timestamp()`)

选择理由:`SET room_version = room_version + 1` 在**持有行锁时读改写**,每行严格单调、与时钟无关;codebase 已有同型先例(`message_version`);并使"等值放行"从妥协变成定义正确——**版本相等 ⟺ 同一次写入**(ack 与广播双路径幂等),毫秒平局问题一并消失。

落地清单(全部完成,服务端 178 / 客户端 138 测试全绿):

| 层 | 改动 |
|---|---|
| schema | `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_version BIGINT NOT NULL DEFAULT 0`(幂等,启动自动迁移) |
| Postgres | 全部 9 条 `UPDATE rooms` 加 `room_version = room_version + 1`;`saveRoom` INSERT 起始版本 1、冲突分支 +1;`ROOM_COLUMNS`/`mapRoom`/`RoomRow` 透出(注意:误伤 `room_ai_cost_totals` 两处后已精确还原,自增恰好且仅 10 处全在 rooms 表) |
| Redis Lua | 8 个写房间的脚本各加一行 `room['roomVersion'] = (tonumber(...) or 0) + 1`(紧邻既有 `messageVersion` 自增;`REPLACE_MEDIA_MESSAGE_ASSET_SCRIPT` 不写房间,不加) |
| Redis TS | **同时关闭 read-modify-write 例外**:新增 `WRITE_ROOM_RECORD_SCRIPT`,版本号以"写入时刻存储中的值"为准在 Redis 内原子自增;6 个 TS 写入点全部收口到 `writeRoomRecord()`,不再有 `hSet('rooms', ...)` 直写 |
| 客户端 | `isNewerRoom` 改为**版本号优先**:两侧都带 `roomVersion` 时按版本比较(等值放行=幂等);任一侧缺失回落 `updatedAt`;时间戳缺失/损坏放行。`updatedAt` 退为展示/兼容回落 |
| 测试 | 新契约测试「混合写路径(创建→改名→消息)版本严格单调」双 fixture 通过;客户端 roomState 增"版本号优先于时间戳(含事务时间戳偏差场景)""缺版本号回落时间戳"两组;三个测试 fake(contract 双份 MemoryRedis、StatefulPostgresPool)同步模拟 |

### 残余语义(如实记录)

- Redis(dev)的 Lua 消息脚本 bump `roomVersion` 但不盖 `updatedAt`(Lua 内无 ISO 时钟)——客户端按版本号比较,不受影响;
- 存量房间 `room_version = 0`,`mapRoom` 不透出(>0 才设),客户端按"缺版本号"回落时间戳,首次任何写入后进入版本号轨道,平滑过渡;
- 跨房间不存在版本可比性(版本是行级的),`isNewerRoom` 对不同 roomId 恒放行,语义不变。

### 面试口径(更新)

> 排序真值是行级逻辑版本号 `room_version`(同 `message_version` 先例):每次房间写入持锁自增,严格单调、与时钟无关;版本相等即同一次写入,ack 与广播双路径天然幂等。`updatedAt` 退为展示和旧数据兼容回落。这是从"timestamp-based LWW(近似全序)"到"版本号 LWW(精确全序)"的升级,消除了事务时间戳偏差和毫秒平局两类乱序源。

---

## 第四轮跟进:`room_version` 实现的二次 review(2026-06-10)

外部 review 对第三轮实现提出 3 项 finding,**全部成立**,已修复:

| # | Finding | 修复 |
|---|---|---|
| P1 | `applyServerRoom` 只入队 React state、不同步推进 `currentRoomRef`;`room_updated(v2)` 到达后、commit 前 resolve 的旧 rejoin ack(v1) 经 ref 看到的还是 v1,其**值更新**会把队列里的 v2 覆盖掉 | 新增 `commitNewerCurrentRoom`:`currentRoom` 的唯一提交入口——先同步推进 ref(两条路径互相可见),再做带守卫的 functional update(入队顺序不影响收敛结果);`applyRoomSessionResult` 的值更新同步改为收敛式。根因是上一轮只给一条路径加了 ref 同步,**不对称**;本轮把对称性收进单一函数,结构上不可再分叉 |
| P2 | 重连指示器的 timer 无 owner:断连清 in-flight 后新恢复 B 启动,旧恢复 A 迟到的 `finally` 会无条件清掉 B 的 timer/spinner | `Symbol` owner token:只有最近一次启动的恢复能撤销指示器;`clearBackgroundRestoreState`(手动切房/离开/断连)强制清除 |
| P3 | contract fake 的 4 个消息变更分支(update-content/delete/truncate/update-and-truncate)不镜像真实 Lua 的 `roomVersion` bump(update-content 甚至不回写房间),契约测试无法证明这些路径严格递增 | 4 个分支补齐真实语义;单调性契约测试扩展为**创建→改名→消息→编辑→删除 = 1→2→3→4→5**,双 fixture 通过 |

P1/P2 均按"red 验证"流程:先写 reviewer 给定场景的测试,stash 修复确认对旧代码**精确变红**,还原后转绿。验收:服务端 178 / 客户端 140 全绿,双侧 tsc/lint/i18n 干净。

已知未对齐(刻意,记录):fake 的 eval 分支不镜像真实脚本的 `messageVersion` bump——这是本系列之前就存在的偏差,与 `roomVersion` 正交,现有测试不依赖该行为;如未来要对齐,应连同 `historyVersion` 断言一起做。
