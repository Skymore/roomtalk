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

### F1 的一个已知例外(刻意保留)

Redis 的消息追加路径经由 Lua 脚本直接改房间 JSON(`APPEND_MESSAGE_LIST_SCRIPT` 等,其中 `REPLACE_MESSAGE_LIST_SCRIPT` 使用变长 ARGV),在 Lua 内盖 ISO stamp 需要改动全部脚本及其调用方,风险大于收益:

- prod 持久层是 Postgres,其**全部**写路径已盖 stamp,LWW 在 prod 是精确全序;
- Redis(dev)的 Lua 追加路径继承现有 stamp,客户端对等值 stamp 放行,行为与修复前一致、无回归;残余影响仅为 dev 环境下消息活动更新与设置变更并发时的瞬时竞争,可自愈。

`redisStore.ts` 的 `stampRoomRecord` 注释中同样记录了该例外。

## 验收结果(2026-06-10)

- 客户端:**134 用例全绿**(新增:roomState LWW ×4、对拍向量 ×2),`tsc` / `lint` / `check:i18n` 干净;
- 服务端:**176 用例全绿**(新增:getPostingAvailability ×5、update_room_settings ×2;契约测试升级为"saveRoom/rename 必须盖 stamp"的正式断言,fake pool 同步),`tsc` 干净;
- 现有 LWW/边界/disable 复现回归测试无回退。
