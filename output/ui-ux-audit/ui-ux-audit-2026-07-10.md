# RoomTalk UI/UX 审计、根因复核与修复记录

日期：2026-07-10

环境：本地开发环境，深色与浅色主题，中英文界面

桌面视口：1440 × 900、768 × 900

移动视口：390 × 844、375 × 667；并使用 390 × 500 模拟软键盘占用后的短视口

## 范围与产品约束

- 本报告保留修复前的截图与初步判断，并继续记录根因复核、代码修复、自动化回归和修复后截图；下方“初步发现”正文是历史记录，最终结论以“复核后结论修正”和“修复状态总表”为准。
- 桌面端和移动端分别检查。
- 28 × 28 的紧凑控件是为高信息密度做出的明确选择，本报告不把它本身判定为问题；只有实际出现误触、难发现或状态不清时才记录。
- 已覆盖首页/已保存空状态、已有/失效房间状态、设置页全页、用户名编辑、创建房间基础与发帖时段、无效房间 ID、侧栏折叠、767/768 响应式断点、浅色/深色和中英文布局。
- 修复阶段另以隔离测试房间覆盖消息、AI、图片/视频/文件、贴纸、语音、房间恢复、设置与删除相关链路，避免在用户现有房间中产生测试消息。

## 截图索引

### 桌面端

- [已有但已失效的房间状态](screenshots/desktop-initial.jpg)
- [设置页](screenshots/desktop-settings-localhost.jpg)
- [创建房间弹窗](screenshots/desktop-create-room-dialog-home-verify.jpg)
- [浅色首页](screenshots/desktop-home-light-1440x900.png)
- [浅色设置页下半部分](screenshots/desktop-settings-light-lower-1440x900.png)
- [浅色中文设置页](screenshots/desktop-settings-light-zh-lower.png)
- [21 字符房间名称仍可提交](screenshots/desktop-create-room-light-zh-name-21-enabled.png)
- [创建房间发帖时段展开](screenshots/desktop-create-room-light-zh-schedule.png)
- [侧栏折叠状态](screenshots/desktop-home-dark-zh-sidebar-collapsed-1440x900.png)
- [768px 桌面断点](screenshots/responsive-768-dark-zh-home.png)

### 移动端

- [首页空状态](screenshots/mobile-home-empty-390x844-final.jpg)
- [设置页](screenshots/mobile-settings-390x844-raw.jpg)
- [创建房间全屏表单](screenshots/mobile-create-room-dialog-390x844.jpg)
- [浅色中文首页](screenshots/mobile-home-light-zh-390x844.png)
- [浅色中文设置页首屏](screenshots/mobile-settings-light-zh-top-390x844.png)
- [浅色中文设置页下半部分](screenshots/mobile-settings-light-zh-lower-390x844.png)
- [创建房间短视口/键盘占用模拟](screenshots/mobile-create-light-zh-keyboard-height-390x500.png)
- [创建房间发帖时段展开](screenshots/mobile-create-light-zh-schedule-top-390x844.png)
- [无效房间 ID 错误状态](screenshots/mobile-home-dark-zh-invalid-room-error.png)
- [已保存空状态](screenshots/mobile-saved-light-zh-empty-390x844.png)
- [767px 移动/平板断点](screenshots/responsive-767-dark-zh-home.png)

### 修复后复测

- [桌面端房间与高密度 Composer（1440 × 900）](screenshots/postfix-desktop-room.jpg)
- [桌面端设置页（1440 × 900）](screenshots/postfix-desktop-settings.jpg)
- [移动端首页与 28 × 28 底栏（390 × 844）](screenshots/postfix-mobile-home.jpg)
- [移动端设置页（390 × 844）](screenshots/postfix-mobile-settings.jpg)
- [移动端房间名称即时验证（390 × 844）](screenshots/postfix-mobile-create-validation.jpg)

## 复核后结论修正

1. **BUG-01 不是简单漏写 `setCurrentRoom(null)`。** 原代码在 `Room not found` 分支已经尝试清空当前房间；真正缺失的是“缓存外壳”和“已验证实时会话”的信任边界。localStorage/IndexedDB 的房间与旧消息可先渲染，房间列表则独立从服务端得到 0；在 join ack 前，发送、保存、导出、媒体签名、转录和 Code Agent 请求仍可能把缓存外壳当成在线房间。并发 join 的服务端多段 `await` 还会让 ack 顺序与最终 membership 写入顺序不一致。
2. **BUG-05 的初步描述过度概括了深色主题。** 确认不合规的是浅色 action pair `#c96442 / #faf9f5`（约 3.70:1），以及 A2UI/hover 的旁路配色；深色最终 action pair 使用 `#d97757 / #141413`，约 5.90:1。装饰性橙色图标在非文字 3:1 标准下可以保留。
3. **D-05/M-05 中“已有密码时必须填写当前密码才能启用提交”的初步推断不成立。** 服务端允许“当前密码”或有效登录 token 二选一；最终校验只要求新密码 8–128 字符，不错误地强制当前密码非空。
4. **X-04 的初判不成立；D-06 才是已存在的正向设计。** 原实现只有 optimistic `pending → failed` 的错误外观，没有普通消息 Retry；直接补按钮又会在“服务端已落库但 ack 超时”时重复发送。本轮同时补客户端 Retry 与服务端 `clientMessageId` 持久幂等，再把 X-04 判为已修复。240→72px 折叠侧栏则原样保留。
5. **BUG-03、BUG-08、BUG-11 虽在初稿中写作 RISK，源码与交互复核后确认存在可复现缺口，已按 BUG 修复。**

## 修复状态总表

### 跨端 BUG-01 至 BUG-11

| 编号 | 状态 | 最终处理 |
| --- | --- | --- |
| BUG-01 | 已修复 | 新增 `restoring / ready / unavailable` 会话状态；缓存房间可即时显示但在 join 成功前全局只读。断线立即锁定，新 socket rejoin 成功才解锁；不存在/被移除时清房间、权限、消息视图与缓存代际。服务端按 socket 串行化 register/join/leave/disconnect，客户端对陈旧 join 显式 leave 后重放最新意图。 |
| BUG-02 | 已修复 | 全局错误 8 秒自动收起，支持手动关闭；切换主视图或打开创建/编辑等模态任务时清除。未恢复的房间改用局部 unavailable + Retry，不靠常驻底栏错误。 |
| BUG-03 | 已修复 | 媒体签名 URL 与元素加载分别提供 skeleton、文件名、12/15 秒超时后的通用失败卡和 Retry；陈旧/晚到响应不会覆盖新一次加载。当前不臆测底层签名、网络或解码的具体失败原因。 |
| BUG-04 | 已修复 | 修正 HeroUI 2.7.5 可见 label 与显式 `aria-label` 的重复组合，浏览器无障碍树只保留单一名称。 |
| BUG-05 | 已修复 | action 色改为 light `#ad5237/#faf9f5`、dark `#d97757/#141413`；A2UI、房间类型卡和 HeroUI hover 使用不透明合规实色；本轮涉及的按钮、说明与加载状态文字均 ≥4.5:1。装饰性品牌橙保留。 |
| BUG-06 | 已修复 | 错误使用 `role="alert"`，成功/进度使用 `role="status"`，补 `aria-atomic`；移除同节点重复的显式 live 属性，避免一条结果播报两次。 |
| BUG-07 | 已修复 | Username 可见标签通过稳定 id 与编辑输入框关联；空用户名时保存禁用。 |
| BUG-08 | 已修复 | 全局 `prefers-reduced-motion` 关闭持续动画/长过渡/平滑滚动；MessageList 与 StickerPicker 的 JS 平滑滚动也显式降级为 `auto`。 |
| BUG-09 | 已修复 | 消息区为 `role="log"`，每条消息为带发送者/时间/状态名称的 article；历史/缓存 hydration 时 live 暂停，稳定后才开启。AI token 不逐字播报，完成时一次播报最终内容摘要；失败只走一个专用 alert。 |
| BUG-10 | 已修复 | React Modal 绑定 `#root` 并恢复背景隔离；媒体查看器实现 `aria-modal`、背景 inert、焦点循环、隐藏轮播页过滤、Escape 层级关闭与触发点焦点恢复。 |
| BUG-11 | 已修复 | 每个主视图有唯一 h1 与命名 main；移动底栏改为 nav + `aria-current`；房间设置 tabs 补齐 tabpanel、controls、roving tabindex、左右/Home/End 键。 |

### 房间内 X-01 至 X-06

| 编号 | 状态 | 最终处理 |
| --- | --- | --- |
| X-01 | 已修复 | 图片、视频、普通文件统一进入附件草稿托盘，显示预览/类型、文件名、大小，可逐项移除，最后由 Send 确认；不再选择后立即发送视频/文件。 |
| X-02 | 已修复 | 每项显示等待、压缩、上传百分比、失败；支持取消、失败单项 Retry 与部分成功汇总。XHR 上传支持真实 progress 与 AbortSignal。 |
| X-03 | 已修复 | 校验提示 5 秒自动消失；发送/上传失败持久保留至关闭或重试；错误卡有关闭按钮并使用 alert。 |
| X-04 | 已修复 | 原实现没有普通消息 Retry。现对失败 text/sticker 显示 Retry，复用原 `clientMessageId` 与消息上下文；Redis/PostgreSQL 持久层按 room/client/clientMessageId 原子去重，重复请求返回 canonical message 且不重复广播/推送。 |
| X-05 | 已修复 | 下载/分享结果增加可见文字与单一 status/alert，按钮名称同步变化；失败状态保留足够时间。 |
| X-06 | 已修复 | 导出移除原生 alert；HTML/ZIP 显示格式化成功/失败 banner，按钮有 busy/导出中名称，会话未验证时禁用。 |

### 桌面端与移动端指定项

| 编号 | 状态 | 最终处理 |
| --- | --- | --- |
| D-01 / M-01 | 已修复 | Google/User ID 帮助改为 compact details；Language/Appearance 前移到 Username/User ID 之后，390×844 无需跨过完整登录表单即可访问高频偏好。 |
| D-04 | 已修复 | Chat 与 Code Agent 均显示真实 loading skeleton，8 秒后显示 Cost unavailable；不再把未知成本伪装成 `$0`。 |
| D-05 / M-05 | 已修复 | 房间名 20 字符上限、剩余字数、即时 invalid 与提交禁用；密码 8–128 字符提示和按钮状态；已有 ID 登录的必填状态提前校验。 |
| D-06 | 已验证保留 | 240→72px 折叠侧栏和所有无障碍名称保持，未扩大紧凑控件。 |
| M-03 | 已修复 | 空状态文案缩短为一个直接任务句，Create/Join 主次顺序不变。 |

## 深挖过程中新增发现并修复

- **NEW-01 · 服务端 membership 交错：** Socket.IO 不会等待 async listener；join A/B、leave、register 与 disconnect 可跨多个 `await` 交错。现改为每 socket 串行队列，并结合持久 room list 与 `socket.rooms` 清理未记录订阅。
- **NEW-02 · 客户端 ack 顺序误判：** “最后 ack”不等于“最后 membership mutation”。陈旧成功/超时会等待最新 intent settle，退出所有陈旧 room 后再重放最新成功 join；repair 有全局次数上限，迟到 repair ack 不会递归开启新 epoch。
- **NEW-03 · 缓存清空竞态：** 清空历史/失效房间与 IndexedDB 写入可反序完成。缓存改为持久 generation；旧 generation 写即使最后完成也会条件删除，清空后新 generation 仍可正常写入。
- **NEW-04 · 语音与贴纸跨房：** A 房录音、voice upload、编辑器快照或 sticker 回调可在切到 B 房后完成。现在切房停止录音/转写、abort 上传、撤销 URL，并以 room generation 忽略所有晚到成功/失败。
- **NEW-05 · 恢复态隐藏副作用：** A2UI、音频转录、Load more、Workspace/Threads/Changes、文件浏览、AI Settings、Steer/Interrupt 与已打开编辑/删除弹窗曾绕过主按钮锁。现在 UI disabled/inert 与 handler guard 双层阻断，ready transition 再自动首载。
- **NEW-06 · A2UI 与 hover 对比旁路：** A2UI CSS 和 HeroUI 默认 0.8 hover opacity 绕过了主题基色修复；现统一使用不透明合规 hover 色并用计算测试锁定。
- **NEW-07 · 删除/撤权广播与跨 socket join：** 删除房间原先只更新 owner 列表，其他在线成员不会收到失效事件；join 还可能拿旧 room/member 快照后迟到提交。现同进程 delete/remove/join 进入 room access 串行边界；跨 worker 依靠 provisional subscribe、durable re-read、对目标用户全部 socket 的无条件 invalidation/leave，以及客户端取消 pending generation 并修复上一房间来收敛。删除向整个房间广播 `room_removed` 后执行 `socketsLeave`。
- **NEW-08 · 房间查询与删除 ack 串房：** URL A→B、手动 A→B 的旧 `getRoomById` 响应，以及删除 A 后切 B 的迟到 ack，都可能覆盖新房间。现使用独立 lookup generation，并在 ack 时读取 `currentRoomRef`；删除成功无条件失效目标缓存。
- **NEW-09 · 跨标签缓存复活：** 每个 tab 的 generation/tombstone 原先互不知情。现每次读写都与持久 generation 单调合并，失效房间另有跨 tab tombstone，只有验证 rejoin 才解除。
- **NEW-10 · 历史页覆盖新消息：** 迟到 replace/prepend 可覆盖 `new_message` 或在 clear 后插回旧消息。请求现在携带 base history version，由服务端回显；客户端同时校验 room、server version 与请求基线。
- **NEW-11 · 权限未知 fail-open 与失败切房：** permission fetch 失败时 composer 原先默认可用；错误密码 B 还会让 UI 指向 B、服务端留在 A。现未知权限一律 fail-closed、权限请求有 generation；确定性切房失败回滚已验证 A，并重新打开密码输入。
- **NEW-12 · Playwright 路径误过滤：** 桌面 project 的 `/codex/` ignore 正则原先匹配整条绝对路径；本工作树位于 `.codex/worktrees`，因此 26 条桌面 E2E 被全部静默过滤。现正则只匹配 spec 文件名，`--list` 为 30 条，最终桌面 26 + 移动 4 全部执行。
- **NEW-13 · 假 runner 协议漂移：** 桌面 E2E 恢复后发现 fake Coco 事件缺少现行 `model_step` 与 provider-reported usage，旧断言也仍使用 Code Agent 文案和错误的 edit-and-run 数量。现 fake runner 将显式 `fake` turn sentinel 绑定到当前请求，提供一致的 step/aggregate usage；断言按 Workspace/Coco 和截断语义更新。

## 修复前总结（历史记录）

当前视觉语言整体一致，深色/浅色主题与中英文布局没有发现结构性溢出，创建房间在移动端切换为全屏表单也合适。最需要优先处理的不是控件尺寸，而是失效房间状态没有及时收敛、错误提示生命周期与无障碍语义、主色按钮文字对比度，以及设置页首屏被说明卡片占用过多。

## 跨端 BUG / 风险

### BUG-01 · P1 · 失效房间出现“幽灵房间”状态

现象：进入应用后，主内容区仍显示房间 `TEST` 和旧消息，但左侧列表同时显示 `CHAT ROOMS 0`。服务端确认房间不存在后，页面只出现 `The previously joined room no longer exists.`，没有立刻清除主内容区；切换到设置页再回首页后才恢复为空状态。

影响：页面的两个区域互相矛盾，用户可能继续对不存在的房间执行发送、保存或导出操作。

建议：房间校验失败时立即以一次原子状态更新完成三件事：清除 active room、清理旧消息视图、进入统一空状态。不要依赖用户再次导航触发收敛。

### BUG-02 · P1 · 失效房间错误条持续跨页面、跨弹窗存在

现象：红色错误条从房间页持续到设置页、首页和创建房间弹窗。桌面端覆盖整个底边；移动端固定在底部导航正上方，持续减少可用内容高度并与当前任务竞争注意力。

影响：一次已知且已处理的导航错误持续干扰后续操作，用户也无法判断错误是否仍在发生。

建议：在状态完成收敛后自动消失（例如 5–8 秒），切换主页面或打开模态任务时清除；保留手动关闭。若错误仍未解决，应改为与空状态绑定的局部说明，而不是全局常驻错误条。

### RISK-03 · P2 · 媒体加载阶段缺少明确反馈和恢复入口

现象：本地环境未配置媒体对象存储时，截图中图片消息会先显示为空白灰色矩形。源码复核确认最终 `mediaError` 状态会显示“媒体加载失败”，因此“始终没有失败文案”并不成立；真正缺失的是签名 URL/缓存加载阶段的 skeleton、超时说明和重试入口。

影响：网络慢或存储不可用时，用户在失败状态出现前无法区分“正在加载”“空附件”和“已经失败”；失败后也只能等待页面重新获取。

建议：加载阶段显示带文件类型的 skeleton；超时/失败后显示文件名、失败原因和重试入口。开发环境可额外提示存储未配置，生产前用已配置对象存储复测具体持续时间。

### BUG-04 · P2 · 表单控件的无障碍名称被重复组合

现象：浏览器无障碍树中出现 `Room Name Room Name*`、`Description (Optional) Description (Optional)`、`Password (Optional) Password (Optional)`。输入框同时设置了 `aria-label` 和 `aria-labelledby`，名称被重复朗读。

影响：屏幕阅读器用户会听到重复标签，增加表单理解成本。

建议：保留可见 label 对应的 `aria-labelledby`，移除重复的 `aria-label`；必填状态使用语义属性表达，不拼进重复名称。

### BUG-05 · P1 · 主色按钮文字对比度不满足 WCAG AA

现象：浅色主题下，`#c96442` 主色背景配 `#faf9f5` 文字的实测对比度约为 3.7:1；编辑/复制图标约为 3.54:1，说明卡关闭按钮约为 4.04:1。对应文字为 12–14px 常规字号，不属于可放宽到 3:1 的大号文本。初稿曾推断深色主题也有同类问题；复核证明该推断不成立，见上方“复核后结论修正”。

影响：低视力、低亮度或强光环境下，主操作反而可能比正文更难辨认。

建议：优先保持当前品牌色，将按钮文字改成足够深的颜色；或将按钮背景压深到满足 4.5:1。同步检查所有硬编码的 `bg-[#c96442] text-[#faf9f5]`，不要只修首页按钮。

### BUG-06 · P2 · 全局错误提示不会被屏幕阅读器自动播报

现象：无效房间 ID 错误条的容器和文案均没有 `role="alert"` 或 `aria-live`。消息输入区错误卡、房间设置成功/失败 banner、媒体下载/分享结果也都只改变可见内容或图标，没有对应的 live region。

影响：视障用户执行加入/发送操作后，焦点不移动时可能完全不知道发生了错误。

建议：错误容器使用 `role="alert"` 或 `aria-live="assertive"`；成功/非阻断通知使用 `role="status"` 或 `aria-live="polite"`，并避免同一消息重复播报。

### BUG-07 · P2 · 用户名编辑输入框没有可访问名称

现象：点击“编辑用户名”后，无障碍树只显示一个无名称的 `textbox`；实际输入框的 `aria-label` 是空白字符串，且没有 `aria-labelledby`。

影响：屏幕阅读器用户无法知道当前输入框用于编辑用户名。

建议：让左侧可见“用户名”标签通过 `htmlFor`/`aria-labelledby` 关联输入框，或直接设置本地化的 `aria-label={t('username')}`。

### RISK-08 · P2 · 自定义动画未覆盖减少动态效果偏好

现象：代码中有加载旋转、骨架脉冲、运行状态 ping 以及多处 transition，但没有发现 `prefers-reduced-motion` 或 Tailwind `motion-reduce` 的自定义覆盖。HeroUI 自带控件有降级能力，但自定义动画没有统一处理。

影响：设置“减少动态效果”的用户仍会看到持续旋转、脉冲和位移动画。

建议：为持续动画添加 `motion-reduce:animate-none`，位移/缩放类过渡在减少动态效果下立即完成；保留颜色变化等非运动反馈。

### BUG-09 · P1 · 实时消息列表没有聊天日志语义或新消息播报

现象：消息滚动区和内容区都是普通 `div`，没有 `role="log"`、`aria-live`、`aria-relevant` 或列表/文章语义。AI 流式内容、发送中、发送失败和新到消息只更新视觉文本。

影响：屏幕阅读器用户停留在输入框时无法可靠获知新消息、AI 回答完成或自己的消息发送失败。这是实时聊天的核心任务阻断。

建议：消息容器使用 `role="log" aria-live="polite" aria-relevant="additions text"`，每条消息提供发送者、时间和状态的可访问结构；AI token 不要逐字播报，可在开始时播报“AI 正在回复”，完成后一次性播报结果摘要。

### BUG-10 · P1 · 编辑/删除消息与媒体查看器没有完整隔离背景焦点

现象：编辑和删除消息使用 `react-modal`，但项目没有调用 `Modal.setAppElement('#root')`，并显式设置 `ariaHideApp={false}`；背景应用仍留在无障碍树中。自定义媒体查看器会聚焦 dialog，但没有 Tab 焦点循环、背景 `inert` 或关闭后恢复触发元素焦点。

影响：键盘和屏幕阅读器用户可能从弹窗直接进入被遮挡的聊天界面，关闭媒体后也可能丢失原消息位置。

建议：应用启动时设置 React Modal app element 并移除 `ariaHideApp={false}`；媒体查看器使用成熟的 dialog/focus-scope，打开时隔离背景、关闭时恢复到原媒体按钮。

### RISK-11 · P2 · 页面与导航语义层级不完整

现象：多数主视图直接从 `h2` 开始，页面没有稳定的 `h1`；移动底栏是普通 `div` 而非 `nav`；房间设置虽标记 `tablist/tab`，但没有 `tabpanel`、`aria-controls` 和方向键切换。

影响：屏幕阅读器的标题、地标和 Tab 快速导航不能反映视觉结构，键盘用户需要逐个 Tab 穿过所有设置页签。

建议：每个主视图提供唯一 `h1`（可视觉隐藏）；底栏增加本地化的 `nav aria-label`；完整实现 ARIA Tabs 的 roving tabindex、左右方向键、`aria-controls` 和 `tabpanel`。

## 房间内跨端 UI/UX 建议（源码确认，待真实房间截图复测）

### X-01 · P1 · 图片、视频和文件的“选择后发送”行为不一致

同一个媒体入口中，图片会先插入编辑器草稿，等待用户点击发送；视频选择后立即上传并发送。附件入口选择普通文件后也立即发送，语音则有预览确认。用户难以形成一致预期，误选视频/文件时没有撤销机会。

建议：所有附件统一进入草稿托盘，显示缩略图/文件名/大小，可单项移除，最后由同一个发送按钮确认。若产品确实需要立即发送，应在文件选择器前明确写出行为，并提供短暂撤销。

### X-02 · P2 · 多文件上传只有全局 spinner，没有单项进度

多视频/文件会顺序上传，工具栏只显示统一发送 spinner 并锁定其他操作；没有“第几个/共几个”、百分比、取消或部分失败汇总。若前几个成功、后一个失败，用户需要自行从消息列表判断结果。

建议：草稿托盘逐项显示 `等待 / 压缩 / 上传 xx% / 已发送 / 失败`；允许取消未开始项和重试失败项，最终汇总部分成功状态。

### X-03 · P2 · Composer 错误卡常驻且没有关闭操作

不支持格式、图片数量超限、上传或发送失败都会显示在输入框上方；错误只会在后续成功发送时清除，没有关闭按钮、自动消失或与具体附件关联。

建议：字段/附件错误就地显示；全局发送错误保留重试和关闭；非阻断格式提示自动消失。同步补上 `role="alert"`。

### X-04 · 初判错误 · 消息发送失败只有状态、没有普通消息重试

初次源码抽样误把 AI response retry 当成普通文本 retry。完整链路复核确认：普通 text/sticker 会从 `pending` 变为 `failed` 并保留错误文案，但没有 Retry handler 或入口。且 ack timeout 可能发生在服务端已经落库之后，若只补客户端按钮会产生重复消息。因此最终修复同时覆盖持久幂等和失败消息 Retry，详见上方修复表。

### X-05 · P2 · 媒体查看器操作结果只改变图标

下载成功、分享成功和分享失败分别把工具栏图标短暂改成 check/alert，但按钮的可访问名称仍是“下载媒体”或“分享媒体”，页面也没有文字状态。视觉用户需要猜图标含义，屏幕阅读器用户不会获得结果。

建议：工具栏附近增加短暂文字状态，并用 `role="status"` 播报成功、`role="alert"` 播报失败；失败状态提供重试或复制链接替代路径。

### X-06 · P3 · 导出失败使用浏览器原生 alert

HTML/ZIP 导出失败时调用原生 `alert()`，它会阻断页面、样式不可控，并且没有保留导出格式或重试上下文。

建议：改成贴近 Export 控件的错误 popover/banner，显示失败格式、原因和重试；导出中按钮增加 `aria-busy` 与“正在导出”名称。

## 桌面端 UI/UX 建议

### D-01 · P1 · 设置页首屏应优先展示可操作状态

Google Account 和 User ID Login 的大说明卡片占据了大量垂直空间，真正的输入和外观/语言设置被推到首屏以下。

建议：首次出现时保留说明卡；用户关闭或看过后，折叠为紧凑的状态行，例如 `Google · Not connected`、`User ID login · Not set`，需要时再展开帮助。

### D-02 · P2 · 消息输入区默认高度与当前信息密度不匹配

单行或空输入时，编辑区仍占用约一百多像素的高度，挤压消息历史，但右下角只有 Ask AI / Send 两个主要操作。

建议：默认使用紧凑单行/双行高度，输入多行时自动增长，并设置最大高度后在输入框内滚动。这样能保留产品想要的高信息密度。

### D-03 · P2 · 创建房间中只有一个 Room Type 仍使用选择控件

当前只有 `Chat` 一个选项，但用单选卡片呈现，视觉上暗示还有其他可选类型。

建议：只有一个类型时显示为静态类型说明，存在两个及以上类型时再恢复选择控件。`Room Password` 与 `Password (Optional)` 也可以合并，减少重复标题。

### D-04 · P2 · 顶部次要状态缺少明确的加载/失败语义

截图中 `Session cost: ...` 长时间以省略号出现。它可能是加载中，也可能是不可用，用户无法区分。

建议：短时加载使用 skeleton；超时后显示 `Cost unavailable` 或隐藏该项，并提供 tooltip 解释。不要让 `...` 成为长期状态。

### D-05 · P2 · 表单验证发生得太晚

创建房间提示“最多 20 个字符”，但输入 21 个字符时提交按钮仍然可用，只有点击提交后才进入验证；设置密码、使用已有用户 ID 的按钮在必填字段为空时同样保持可点击。底层处理函数会阻止无效提交，因此不是数据完整性故障，但会制造本可避免的错误回合。

建议：房间名称直接设置 `maxLength={20}` 并显示剩余字符；身份表单在 blur 后显示本地错误，同时让按钮可用状态与最基本的必填/长度条件一致。密码长度 8–128 应在输入前就可见，而不是点击后才告知。

### D-06 · 正向发现 · 折叠侧栏适合高信息密度

侧栏可以从 240px 收到 72px，创建、加入、用户和设置操作仍保留清晰的无障碍名称，主内容区也会立即释放空间。这个设计与产品的高密度目标一致，建议保留。

## 移动端 UI/UX 建议

### M-01 · P1 · 设置页需要更短的首屏路径

390 × 844 下，头像、用户名、User ID 和两张说明卡已经占满首屏，语言、外观等高频设置需要较长滚动才能到达。

建议：将内容分为 `Profile / Login / Preferences` 三个紧凑分区，或使用可折叠 section；已关闭的说明卡不要每次重新占据首屏。

### M-02 · 正向发现 · 28 × 28 底部导航可以保留

复核后，浅色主题未选中图标约为 `#5e5d59`，深色主题约为 `#b0aea5`；选中态同时使用反色圆形背景和图标颜色变化。明暗主题下状态区分和对比度均足够，且每个入口都有明确的无障碍名称。本轮没有发现由 28 × 28 引起的实际误触或可发现性问题。

### M-03 · P2 · 首页空状态的文案与操作可以更紧凑

移动端已经同时提供 Room ID 加入和 Create Room。说明文字可进一步缩短，减少视觉停顿。

建议：例如改成 `Create a room or join with a Room ID.`；主次操作顺序维持不变。

### M-04 · 正向发现 · 创建房间采用全屏表单

390 × 844 下表单无横向溢出，标题、关闭、底部操作区固定且层级清楚。相比居中小弹窗，全屏形态更适合键盘弹出后的移动端编辑。建议保留这一模式，只修复重复无障碍名称和冗余字段标题。

### M-05 · P2 · 移动表单也需要提前验证

与桌面端相同，房间名称可输入超过 20 个字符，设置密码和已有用户 ID 操作在空值时仍可点击。短屏移动端出现错误后，用户还需要滚动回字段位置，成本高于桌面端。

建议：在字段旁就地显示长度/必填状态，并在首次 blur 后验证；错误出现时自动滚动到第一个错误字段，但不要每次输入都打断用户。

### M-06 · P3 · 600–767px 平板宽度利用率偏低

767px 仍使用移动底部导航和约 450px 的居中操作区，左右会出现较大空白；768px 则立即切换为 240px 侧栏。两侧都没有溢出，但断点前后的信息利用率跳变明显。

建议：平板横向宽度可使用 72px 折叠侧栏，或允许移动内容区扩展到约 520–560px；不必改变 390px 手机布局。

### M-07 · P2 · 房间设置页签在触屏上只有图标

General、Schedule、Members、Transfer 使用四个纯图标页签，文字只存在于 `aria-label` 和 `title`。屏幕阅读器可理解，但触屏视觉用户无法依赖 hover 查看 title，皇冠等图标也不一定能直接表达“转移所有权”。

建议：不扩大页签尺寸；在页签条下方或弹窗标题中显示当前页签的短标签，首次进入时可短暂显示全部文字。

## 修复前建议处理顺序（历史记录）

1. 修复失效房间的原子状态清理（BUG-01）。
2. 为实时消息列表补齐聊天日志和新消息播报（BUG-09）。
3. 修复编辑/删除消息和媒体查看器的焦点隔离（BUG-10）。
4. 修复主色按钮文字对比度（BUG-05）。
5. 调整错误条生命周期、跨页面行为和播报语义（BUG-02、BUG-06、X-03）。
6. 统一图片/视频/文件的草稿确认并增加上传进度（X-01、X-02）。
7. 压缩设置页说明卡并建立折叠后的紧凑状态（D-01、M-01）。
8. 修复重复/缺失的表单、标题、导航和页签语义（BUG-04、BUG-07、RISK-11）。
9. 完善媒体加载态、提前表单验证和减少动态效果（RISK-03、D-05、M-05、RISK-08）。
10. 处理输入区高度、单一 Room Type 和平板宽度利用率等体验优化。

## 最终任务流覆盖

- 桌面 E2E：创建/加入/分享/重命名房间，发送、编辑、删除、清空、媒体、AI、Workspace/Coco、双客户端实时同步、刷新/离线/新标签恢复。
- 移动 E2E：创建与发送、输入区覆盖、刷新恢复、Workspace 与 composer 可用性。
- 组件与状态机测试：附件草稿、上传进度/取消/部分失败/Retry，text/sticker delivery Retry，媒体超时与焦点隔离，房间删除/撤权/迟到 ack、历史缓存代际、权限 fail-closed、ARIA log/tabs/status/alert。
- 视觉复测：1440 × 900 桌面和 390 × 844 移动截图；设置高频项顺序、表单即时验证和 28 × 28 底栏均重新测量。

## 最终验证记录

| 范围 | 命令 / 结果 |
| --- | --- |
| 客户端全量单测 | `npm test`：89 files，903/903 passed |
| 服务端全量单测 | `npm test`：87 suites，640/640 passed |
| 房间状态机定向 | `MessagePage.test.tsx` 44/44；`roomHandlers.test.ts` 41/41 |
| X-04 定向 | 客户端 MessageInput/MessageList/MessageItem/messageState 134/134；服务端 handler/Redis/store contracts 95/95 |
| i18n | 635 个实际使用 key 均被 770 个 source key 覆盖 |
| 静态检查 | 客户端与服务端 TypeScript 通过；ESLint 0 warning；`git diff --check` 通过 |
| 构建 | 客户端 Vite production build、服务端 `tsc` build 均通过 |
| 浏览器 E2E | 30/30 passed：桌面 Chromium 26，移动 Chromium 4 |
| 紧凑控件 | 移动 Home/Saved/Chat Rooms/Settings 四入口实测均为 28 × 28；源码保持 `h-7 w-7` |

构建仍会报告既有的 socket 静态/动态混用拆包提示，以及主 bundle 约 4.1 MB 超过 1.5 MB warning；不阻断本轮构建。

## 已知残余与验证边界

- **RISK-12 · P1 · 授权检查与消息写入尚非同一原子边界：** `send/edit/delete/clear` 在授权后仍有后续 `await`；若成员恰在此窗口被移除，已在途操作理论上可能完成。UI 与后续请求会立即收敛，但严格后端 fencing 仍需把成员版本/授权条件带进事务或 Lua。
- **RISK-13 · P2 · Ask AI 组合请求缺少 assistant-run 原子 claim：** 普通 text/sticker Retry 已持久幂等，且 UI 明确不为 Ask AI 显示普通 Retry；但重复的 `send_message_and_ask_ai` 仍可能在 canonical user message 之外重复启动 AI，需要独立的 run claim。
- **RISK-14 · P2 · 仍有局部原生弹窗：** 导出 X-06 已移除 `alert()`；编辑失败、删除失败和成员操作失败仍有 4 个原生 `alert()`，应在下一轮统一为非阻断 banner。
- PostgreSQL 存储 contract 和全量服务端测试已通过；专用 PostgreSQL 浏览器 E2E 因本机未配置安全的 `E2E_DATABASE_URL` 而未执行。跨 worker 删除/撤权时序由定向状态机测试覆盖，未做真实多实例网络故障注入。
