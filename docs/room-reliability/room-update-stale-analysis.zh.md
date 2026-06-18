# Room Update 不刷新问题:完整链路分析

日期:2026-06-09

> 状态：已完成的历史根因分析。文中“现存 bug/设计缺口”描述的是修复前状态；
> 后续已通过整体替换房间对象、ack read-your-write、`room_version` 单调版本、
> posting 边界刷新和 modal 表单保护收敛。当前入口状态见本目录 README。

症状:**更新 posting time 之后,页面没有跟着更新;可能要刷新好几次页面才会更新。**

本文档基于对全链路代码的完整阅读(客户端 socket 层、MessagePage、RoomSettingsModal、ChatHeader、ChatRoomView、MessageInput;服务端 roomHandlers、roomAuthorization、messageHandlers、CompositeRoomStore、redisStore、postgresStore),给出经核实的数据流、根因排序和修复计划。所有断言均附 `file:line` 证据。

---

## 一、先排除的嫌疑(已证伪)

### 1.1 服务端缓存陈旧 —— ❌ 不成立

最初怀疑 prod(`PERSISTENCE_STORE=postgres`,`CompositeRoomStore(postgres, redis, redis)`,`server/src/server.ts:91-98`)在 composite 层有房间对象缓存未失效。**实际读完 `CompositeRoomStore` 全部 433 行后确认:房间对象根本没有缓存层。**

- `getRoomById` 直通 durable(Postgres):`server/src/repositories/store.ts:340-342`
- `updateRoomSettings` 直通 durable:`store.ts:312-314`
- Redis 缓存只用于**消息列表**(`readMessagesByRoom` `store.ts:225-242`,带完整失效逻辑)

Postgres 写路径是 `UPDATE rooms ... RETURNING`(`postgresStore.ts` `updateRoomSettings`),单实例 + Supabase 主库直读,写后即读一致。**服务端的房间数据从更新那一刻起就是新的。**

### 1.2 广播没发 —— ❌ 不成立

服务端 `update_room_settings` 处理器(`server/src/socket/roomHandlers.ts:701-755`)成功后做了三次广播 + 一次 ack:

```
io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);   // :746 owner 个人房
io.to(roomId).emit('room_updated', updatedRoom);                  // :747 房间内所有 socket
io.to(roomId).emit('room_permissions_invalidated', roomId);      // :748 触发权限刷新
callback?.({ success: true, room: updatedRoom });                 // :749 ack 带完整新房间
```

客户端也有对应监听:`room_updated → handleRoomUpdate`(`MessagePage.tsx:483/458`),`room_permissions_invalidated → refreshRoomPermissions`(`MessagePage.tsx:484/466-470`)。

**协议层是完整的。问题出在"消息送达的前提条件"和"客户端如何应用收到的数据"。**

---

## 二、完整数据流(更新 posting time 时实际发生什么)

### 写路径

```
RoomSettingsModal.handleApplySchedule (:249)
  └─ updateRoomSettings({roomId, postingSchedule})        client socket.ts:493
       └─ emitWithAck('update_room_settings')              (经 ensureRegisteredSocket)
            └─ server :701 鉴权(room.manageSettings)
                 └─ normalizePostingSchedule (roomAuthorization.ts)
                 └─ store.updateRoomSettings → Postgres UPDATE...RETURNING
                 └─ 广播 ×3 + ack{room}                   :746-749
       └─ ack 解析出 response.room                          socket.ts:504-508
            └─ ★ RoomSettingsModal 把它丢弃(只 await + toast):249-255
```

### 读路径(共 4 个消费面,陈旧表现各不相同)

| # | UI 表面 | 数据源 | 更新时机 |
|---|---|---|---|
| R1 | ChatHeader 菜单项可见性 + 排期详情 Modal | `currentRoom.postingSchedule`(`ChatHeader.tsx:70`) | `currentRoom` state 变化时 |
| R2 | MessageInput 时钟弹层排期明细 | `currentRoom.postingSchedule`(`ChatRoomView.tsx:151`) | 同上 |
| R3 | **输入框禁用/postingClosed 提示** | `roomPermissions.canPost`(`ChatRoomView.tsx:149`)— **服务端时间快照** | join ack / `room_permissions` 事件 / `room_permissions_invalidated` 触发的 refresh |
| R4 | RoomSettingsModal 表单回显 | 打开时从 `room.postingSchedule` 播种(`RoomSettingsModal.tsx:139-155` 的 reset effect) | 每次 `isOpen` 或 `room.postingSchedule` 引用变化 |

R1/R2/R4 都最终依赖 `currentRoom` 被更新;R3 依赖权限快照被刷新。

### `currentRoom` 的全部写入者(并发竞争点)

1. `room_updated` 广播 → **spread 合并** `{ ...current, ...room }`(`MessagePage.tsx:458`)
2. join ack(每次手动加入/后台恢复)→ **spread 合并** `{ ...current, ...joinedRoom }`(`MessagePage.tsx:182`,`applyRoomSessionResult`)
3. 恢复开始时的 fallback shell(localStorage 旧房间,`MessagePage.tsx:215-218`)
4. rename ack → spread 合并(`MessagePage.tsx:746`)
5. `update_room_settings` 的 ack —— **本应是第 5 个,但被丢弃了**

`currentRoom` 每次变化都会回写 localStorage(`saveCurrentRoom`,`MessagePage.tsx:379`),成为下次刷新的初始 shell。

---

## 三、根因(按确定性和影响排序)

### 根因 A:历史主因——广播丢失 + 恢复链路曾不可靠(已被 PR1-3 大幅修复)

socket.io 广播**没有离线重放**。手机后台/断网期间错过的 `room_updated` 永久丢失,唯一补救是"重连后 rejoin,用 join ack 里的新房间覆盖本地"。而在恢复重构修复之前,这条补救路径恰恰是坏的:

- 重连后 rejoin 曾被静默失败/抑制(P2-1 修复前,socket 甚至可能不在房间 socket.io room 里,后续广播也收不到);
- 首轮恢复失败时错误被死 `_error` 吞掉,UI 停留在 localStorage 的**陈旧 shell** 上;
- 每次刷新页面 = 先显示陈旧 shell,join 成功才覆盖——join 屡次失败时,就表现为"**刷新好几次才更新**"。

**现状**:PR1(错误可见)+ PR2(恢复调度器)+ P2-1(断连清抑制窗)后,每次前台/重连都会可靠 rejoin 并合并 join ack 的新房间。这条历史路径已基本闭合。单设备、socket 在线时,广播本身也是即时可达的。

### 根因 B:`{ ...current, ...room }` 合并永远删不掉字段 —— **现存必现 bug**

服务端在 schedule 被**关闭**时,返回的房间对象里 `postingSchedule` **键不存在**:

- Postgres:`mapRoom` 只在非空时才设置键 —— `if (postingSchedule) room.postingSchedule = postingSchedule`(`postgresStore.ts:147`)
- Redis:`delete updatedRoom.postingSchedule`(`redisStore.ts:1114`);`hasPassword` 同理(`:1106`)

而客户端**所有**应用点都用 spread 合并(`MessagePage.tsx:182 / :458 / :459 / :746`)。spread 对"键不存在"无能为力 → 旧 `postingSchedule` 原样保留。

更糟的是这个陈旧会**永生**:
1. 合并后的 `currentRoom`(仍带旧 schedule)被 `saveCurrentRoom` 写回 localStorage(`:379`);
2. 刷新页面 → 恢复用旧 shell 起步 → join ack 的新房间**同样走 spread 合并**(`:182`,`current?.id === roomId` 成立)→ 没有键,删不掉 → 旧 schedule 又活下来 → 又写回 localStorage;
3. **无论刷新多少次都不会好**,直到用户切到别的房间再切回来(走 `:182` 的整体替换分支)或清掉 localStorage。

> 对"修改时间"场景,新值键存在,spread 能覆盖,B 不触发;对"关闭排期"(以及"清除密码"的 `hasPassword`)场景,B 必现。用户操作若是"先关再开"或调试中反复开关,就会撞上。

#### 已实测复现确认(2026-06-09,连接全程未断)

复现步骤与每一步的代码级解释:

| 步骤 | 观察 | 解释 |
|---|---|---|
| 1. 开启 schedule → disable → 留在当前页面 | 仍能看到 schedule | `room_updated` 广播**正常到达**(连接健康,证明不是送达问题),但 `setCurrentRoom({...current, ...room})`(`MessagePage.tsx:458`)的 spread 删不掉缺失的 `postingSchedule` 键 |
| 2. 再打开设置 | 仍显示 enabled | Modal 表单从 `room.postingSchedule` 播种(`RoomSettingsModal.tsx:111-117/139-155`),`room` prop 即陈旧的 `currentRoom` |
| 3. 地址栏刷新页面 | 仍是 enabled | 陈旧 `currentRoom` 早已被 `saveCurrentRoom` 写回 localStorage(`:379`);刷新后旧 shell 起步,join ack 的干净房间走**同样的 spread 合并**(`:182`),键不存在删不掉 → 陈旧再次幸存并再次落盘 → **刷新无限次也不会好** |
| 4. 退出房间,从房间列表重新加入 | 变成 not enabled ✓ | 两个原因叠加:(a) 房间**列表**对同一条广播做的是**整体替换**(`upsertRoom`,`roomState.ts:3-12`),列表里的条目是干净的;(b) `handleLeaveRoom` 把 `currentRoom` 清空,重进时以干净的列表房间为 fallback,后续所有 spread 都在干净基底上进行 |

第 4 步是决定性证据:同一条广播,列表(整体替换)干净、`currentRoom`(spread 合并)陈旧——直接证明问题出在**应用方式**而非数据或送达,也直接验证了 Fix 1(整体替换)就是正确修法。

### 根因 C:`canPost` 是时间快照,跨越窗口边界时无人重算 —— **现存设计缺口**

输入框的禁用状态(R3)来自 `roomPermissions.canPost`,由**服务端**在以下时刻对"当下时间"求值(`buildRoomPermissions` → `getPostingAvailability(room, now)`,`roomAuthorization.ts`):

- join_room 时(ack + `room_permissions` 事件)
- `room_permissions_invalidated` 触发的 `getRoomPermissions`
- 注意:**owner/admin 没有豁免**——`message.post` 对所有角色执行窗口检查(`roomAuthorization.ts:220-225`),所以 owner 自己也会被自己设置的窗口禁言。

之后**没有任何机制在时间跨越窗口边界时重算**:没有定时器、没有客户端本地窗口判断、服务端也不会主动推送。典型表现:

- 用户把窗口改成"5 分钟后开放"→ 保存瞬间权限刷新,canPost=false(正确)→ 5 分钟后窗口开了,**输入框仍然禁用**,直到某个事件(切前台、重连、刷新)恰好触发权限刷新;
- 桌面端挂着不动的标签页:窗口开/关都不会反映,**手动刷新页面正好"治好"它**——这与"刷新几次才更新"的体感完全吻合(每次刷新都重新求值一次快照,刷新时机落在窗口内才显示可发言)。
- 手机端因为每次切前台都会触发恢复→join→权限刷新,反而比桌面端"自愈"得勤。

服务端 `send_message` 是逐条实时校验的(`messageHandlers.ts:90-94`),所以这是**纯 UI 陈旧**,不是安全问题——但用户看到的就是"页面没跟着更新"。

### 根因 D:更新者自己的 ack 被丢弃(无 read-your-write)—— 健壮性缺口

`update_room_settings` 的 ack 带回了**服务端确认后的完整新房间**(`roomHandlers.ts:749`,客户端解析于 `socket.ts:504-508`),但 `RoomSettingsModal.handleApplySchedule`(`:249-255`)只 `await` + 弹 toast,把房间对象丢了。更新者自己的 UI 完全依赖**绕一圈回来的广播**(根因 A 的所有脆弱性因此都适用于更新者本人)。正确做法是 ack 即本地应用——这不是乐观更新,是已确认的服务端真值。

### 根因 E(放大器):localStorage shell + 无版本字段

- 每次刷新先渲染 localStorage 旧 shell,join ack 到达前用户看到的就是旧排期(纯体感问题,但叠加 A/B 时把"陈旧"变成"持久陈旧");
- `Room` 类型有 `updatedAt?`(`types.ts:82`/客户端 `types.ts:26`)但 **Postgres 的 `ROOM_COLUMNS` 根本不查 `updated_at`**(`postgresStore.ts:79`),`updateRoomSettings` 的 UPDATE 也不 bump 它 —— 字段形同虚设,客户端无法做 last-write-wins 排序。这意味着"in-flight 的旧 join ack 晚于新广播到达并覆盖"这类乱序窗口(虽小)目前无防御。

### 次要发现 F:RoomSettingsModal 打开期间会被广播重置表单

reset effect 的依赖含 `resetSchedule`(随 `room.postingSchedule` 引用变化,`RoomSettingsModal.tsx:111-117/139-155`)。Modal 开着时若收到任何 `room_updated`(例如另一管理员保存),正在编辑的表单会被静默重置。低频但真实。

---

## 四、对症状的最终解释

"更新 posting time 后页面没更新、刷新好几次才好",是**多因叠加**,主导因素取决于场景:

| 场景 | 主导根因 |
|---|---|
| 第二台设备(手机后台)看不到更新,反复刷新才好 | A(广播丢失 + 当时恢复链路不可靠)→ **已修大半** |
| 关闭排期后界面仍显示排期,刷新也无效 | B(spread 删不掉键 + localStorage 永生)→ **现存** |
| 改完时间,输入框禁用状态不随时间变化,刷新才变 | C(canPost 快照,无边界重算)→ **现存** |
| 更新者本人界面偶尔不动 | D(ack 丢弃,依赖广播回环)→ **现存** |

---

## 五、修复计划

### Fix 1(P0,小改动):服务端房间对象 = 完整真值,客户端改为整体替换

`room_updated` 和 join ack 携带的都是**完整房间对象**,不存在客户端独有字段需要保留。把四个 spread 合并点改为按 id 匹配后**整体替换**:

```ts
// MessagePage.tsx :458(room_updated)、:182(join ack)、:459、:746 同理
setCurrentRoom((current) => current?.id === room.id ? room : current);
```

直接消灭根因 B(含 `hasPassword` 同型问题),并使 localStorage 永生链断裂(替换后的干净对象被回写)。

风险与对策:整体替换使"乱序到达的旧对象"从"部分回退"变成"整体回退",所以应与 Fix 4 的 `updatedAt` 守卫一起上;在 Fix 4 落地前,乱序窗口(in-flight join ack vs 同 socket 广播)极小,可接受。

### Fix 2(P0,一行级):用 ack 做 read-your-write

`RoomSettingsModal` 增加 `onRoomUpdated?: (room: Room) => void` prop(`handleRenameRoom` 已有同型先例),`handleApplySchedule` / 密码保存把 `await updateRoomSettings(...)` 的返回值传出去,MessagePage 直接应用(与 Fix 1 同一替换函数)。更新者本人从此不依赖广播回环。消灭根因 D。

### Fix 3(P1):posting 窗口边界的本地重算

数据(`postingSchedule`)本来就在客户端,做一个轻量 hook:

```
usePostingWindowBoundary(postingSchedule):
  - 客户端复刻 getPostingAvailability 的窗口判断(同一份 TZ/跨午夜逻辑,
    建议从服务端抽成共享纯函数或在客户端 utils 重写 + 用服务端测试用例对拍)
  - 计算"下一个边界时刻",setTimeout 到点后调 refreshRoomPermissions(roomId)
    (权限真值仍以服务端为准,客户端只负责"到点去问",不自行翻转 canPost)
```

到点去问而非本地翻转,避免客户端与服务端时区/边界实现不一致时出现"客户端以为能发、服务端拒绝"的分裂。消灭根因 C。同时建议 `visibilitychange` 已有的恢复链路保持现状(它已顺带刷新权限)。

### Fix 4(P1,服务端):启用 `updatedAt`,客户端做 LWW 守卫

> **2026-06-10 更新**:本方案已落地后又升级——外部 review 指出 `NOW()` 是事务时间戳,非严格全序。排序键已替换为行级单调版本号 `room_version`(每次房间写入持锁自增,版本相等 ⟺ 同一次写入),`updatedAt` 退为展示/兼容回落。详见 `room-update-review-followup.zh.md` 第三轮跟进。

- Postgres:`UPDATE rooms SET ..., updated_at = now()`;`ROOM_COLUMNS` 加 `updated_at`;`mapRoom` 映射;
- Redis:`updateRoomSettings`/`updateRoomName` 等写路径 bump `updatedAt`;
- 客户端替换函数加守卫:`incoming.updatedAt < current.updatedAt` 时忽略(两者都有值时才比较,向后兼容)。

为 Fix 1 的整体替换提供乱序防御,也为未来任何房间字段更新建立统一秩序。

### Fix 5(P2,顺手):Modal 编辑保护

reset effect 只在 `isOpen` 翻转为 true 时播种一次(用 ref 记录"本次打开已播种"),不再因 `room.postingSchedule` 引用变化而重置正在编辑的表单。消灭发现 F。

### 测试计划

- 单测(MessagePage):`room_updated` 携带"无 `postingSchedule` 键"的房间 → ChatHeader 排期入口消失、详情不再渲染旧排期(覆盖 Fix 1 的删除语义);
- 单测(MessagePage):保存排期后,不派发任何广播,仅凭 ack → `currentRoom.postingSchedule` 已更新(覆盖 Fix 2);
- 单测(hook):fake timers 跨越窗口边界 → 恰好一次 `getRoomPermissions` 调用(覆盖 Fix 3);
- 单测(守卫):先应用 `updatedAt=T2` 的房间,再注入 `updatedAt=T1` 的 join ack → 不回退(覆盖 Fix 4);
- 服务端测试:`update_room_settings` 后 `updated_at` 单调递增,且出现在 ack 与广播中;
- E2E(可选):双页面——A 改排期,B 不刷新断言排期详情与输入框状态在数秒内更新;A 关闭排期,B 断言排期入口消失。

### 建议落地顺序

1. **PR A:Fix 1 + Fix 2 + 单测** —— ✅ **已实现(2026-06-09,先写 red test 后修复)**:
   - 新增 `applyServerRoom`(`MessagePage.tsx`),对 `room_updated` 广播、join ack、rename ack、settings ack 统一做**整体替换**,取代原四处 spread 合并;
   - `onRoomUpdated` 经 ChatRoomView → ChatHeader → RoomSettingsModal 下传,三个设置保存动作(排期/设密码/清密码)的 ack 房间即时本地应用(read-your-write);
   - 三条 red test 转绿:`room_updated` 无键时排期消失、重连 ack 无键时陈旧 localStorage 排期被清、settings ack 不等广播直接生效;全量 119 测试 / tsc / lint / i18n 全过。
2. **PR B:Fix 4 服务端 + 客户端守卫** —— ✅ **已实现(2026-06-09)**:
   - schema 幂等加列 `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`(启动时自动迁移);
   - Postgres `updateRoomSettings`/`updateRoomName` 写入 `updated_at = NOW()`,`ROOM_COLUMNS`/`mapRoom` 透出;Redis 两个写路径同步 bump ISO 字符串;
   - 客户端 `isNewerRoom` last-write-wins 守卫接入 `applyServerRoom` 与 `applyRoomSessionResult`,两边都带 `updatedAt` 时旧数据不得覆盖新数据;
   - 测试:契约测试断言 rename 必 bump `updatedAt`;客户端两条乱序测试(旧广播回踩、陈旧 rejoin ack 回踩)均拦截。
3. **PR C:Fix 3 边界重算 + Fix 5** —— ✅ **已实现(2026-06-09)**:
   - 新增 `utils/postingSchedule.ts`:`getNextPostingBoundaryDelayMs` 镜像服务端时区/跨午夜语义,算出下一个窗口边界;MessagePage 到点后 `refreshRoomPermissions` 并自动续armed下一个边界(本地只负责"到点去问",canPost 真值仍由服务端判定);8 条单测覆盖时区/跨午夜/秒级精度/无效时区回退;
   - Fix 5:RoomSettingsModal 仅在打开瞬间播种一次表单,打开期间收到 `room_updated` 不再重置正在编辑的内容。

---

## 六、遗留确认项

1. prod(Fly)是否单实例?多实例时 socket.io Redis adapter 已配置(`server.ts:110-121` pub/sub),跨实例广播可达,结论不变;但值得在 prod 验证 adapter 健康(adapter 故障会精确复现"广播丢失"症状)。
2. 用户复现时的具体操作序列(改时间 / 先关后开 / 等窗口到点)决定当时命中的是 B 还是 C——修复后两者都不再可能,无需进一步取证。
