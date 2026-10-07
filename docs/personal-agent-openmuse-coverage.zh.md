# OpenMuse 逐项移植清单

初步目标是完整移植 OpenMuse 已实现的页面、功能和操作流程，然后再做自己的优化。基准固定为 [CopilotKit/OpenMuse `73a714963b57e5cd1747fd3fbc6833e09a36b81a`](https://github.com/CopilotKit/openmuse/tree/73a714963b57e5cd1747fd3fbc6833e09a36b81a)。以实际源码为准：该版本 FEATURES.md 对图形桌面的描述落后于源码，因此桌面也纳入范围；路线图中的未实现项目不算当前功能。

用户要求的差异：执行器固定 Codex app-server/fullAccess；入口 🦊；个人聊天留在个人助理里；记忆进入后直接显示；设置默认只读，点击编辑后修改。普通 RoomTalk 对话保留原有功能。

2026-10-06 再次按完整源码复查，发现此前清单遗漏了 JEV 交互式选项，不能把静态比较结果卡片算作完整移植。该模块现已移植原版服务、校验、排序、证据、持久选择、精炼和客户端交互，并接入 Codex。生产没有 TYPESAFE_API_KEY，因此保持原版默认 JEV_MODE=off；sample 仅用于明确标记的自动化测试。Google OAuth 已于 2026-10-07 完成独立客户端、生产凭据、回调、五项范围和真实账号连接；Gmail 列表与线程读取已验证。Calendar API 条款已确认并启用；生产真实日历列表、主日历读取及订阅日历事件详情已验证。以下历史验收只证明相应模块，不能代替全部功能或外部服务验收。

## 本轮源码复查与修正

- JEV：原版 adapter/domain/service/tools、selection/retry/stale/ranking/grounded evidence 逻辑已移植；RoomTalk 的接受回执在服务器确认选择之后返回，不把执行器的提前启动回执当成成功选择。选择不清空编辑器中尚未发送的草稿。
- 工具卡片：个人助理的聊天不再丢弃配对后的 tool_result，修复选择一直“准备中”和任务卡片读不到成功回执的问题；普通工作区仍沿用原有配对显示。原版邮件、搜索和通用保存工具的内联卡片已经移植，保留暂停/错误/空结果状态、来源去重与截断提示；邮件可打开完整线程，目标和记忆直接打开对应页面。卡片按工具调用的顺序显示。
- 移动 UI：采用原版的图标导航尺寸、窄内容宽度、连接器搜索和分组；已连接状态不再额外占一张助手卡片；目标/任务/监控说明正确截断；记忆首次加载有实际加载反馈。白色 canvas、蓝色按钮/用户气泡、灰色助手气泡与尾部圆角采用 ui.tsx/chat.tsx 原值；个人页面和所有弹窗共享独立 palette，普通聊天样式保持原值。排队消息采用原版列表和移除按钮；失败发送可用同一消息 ID/图片重试而不清空新草稿。
- 测试：原版 JEV adapter 16 项、真实 PostgreSQL restart/race/selection 14 项、owner/turn/evidence HTTP 路由 3 项、运行器工具 29 项、执行器会话与个人上下文 108 项通过。Chrome 中已验证脚本样例选项的真实按钮点击、PostgreSQL 选择、刷新重放及草稿保留；样例不算真实 Jev 服务验收。
- 公共搜索：按原版 search.ts 移植真实 MCP/Parallel 匿名会话、无 Cookie/认证头的项目标识、引用、超时/取消与输出边界，默认启用。原版 17 项网络/结果测试与 owner/turn/pause 路由通过；真实 Parallel 搜索 OpenMuse 已返回仓库 URL 和摘录。`roomtalk search web` 用于主聊天和委托任务；完整回执持久保存，任务详情可重放来源。
- Mail tools：按原版 conversation.ts 返回最多 20 条摘要/240 字符 snippet，读线程返回最后 20 条消息/12000 字符正文和真实截断状态；直接 Mail 页面仍可读取全部线程。真实正文与已配对工具回执均不会只读 4 KiB preview。
- E2B：choices 模块 runner 0.1.67 / v5 已发布并实际检查；新增 search CLI 后升级 0.1.68 / v6，发布验收记录见下方最新模块。新增 Google 配置仍未提交，Jev 也没有启用样例冒充真实能力。
- CI：v5 首次构建揭露前端隔离镜像缺少 JEV 协议依赖和 ACP artifact 常量仍为 v4；已分别修正客户端自带原版协议/显式 zod 依赖及 artifact 常量，未跳过任何校验。
- v6 CI 复核：编辑窗口在发送确认前打开时持有临时 ID，保存会被服务器拒绝；现在跟随同一 clientMessageId 的持久 ID，确认消息不会重置编辑草稿。另一个失败是工具卡片 E2E 使用 PostgresStore 编译产物但没有先构建服务端，已在 Codex E2E 脚本加入必要的构建前置步骤。
- 表单：个人页面采用原版独立标签、白色圆角输入框和单行 Remember 输入；标签占据正常布局空间，不再与上一段说明重叠。

## 页面和操作流程

| OpenMuse 原实现 | RoomTalk 移植 | 验证 |
| --- | --- | --- |
| App.tsx 主导航、头像、通知头部 | Chat / Activity / Ideas / Goals / Apps；统一菜单、狐狸、名字、实际工作状态与铃铛；没有双重头部或常驻通知横幅 | 手机与桌面浏览器切换、刷新恢复 |
| threads.tsx 主/侧聊天、抽屉 | 主聊天默认打开；新侧聊天、重命名、归档/恢复、历史翻页和快捷入口 | 真实 PostgreSQL 与 Chrome 流程 |
| MailToolCard / SearchToolCard / ServerToolCard / JevToolCard | 邮件摘要与完整线程、真实网页来源、保存工具入口、Jev 选项和精炼；按原版状态、布局和跳转 | 定向组件检查、真实持久选择、手机线程/记忆跳转；Google/Jev live 需配置 |
| DelegateSheet | 计划、PDF 邮件、财务 CSV、通用任务；先持久保存输入再排队 | 队列/并发/账号隔离；真实 Codex task CLI |
| TaskCard / TaskDetail / TaskThreadCard | 实际计划步骤、状态、暂停/恢复/重试/取消、执行记录、输入请求、审阅结果、文件和独立浏览器 | 手机操作、PostgreSQL 执行围栏、续跑、原生工具回执 |
| Identity / MemoryRow | 源版只读资料与编辑按钮、sky/sand/lilac 狐狸色、语气、更新偏好；记忆行内修改、遗忘、来源和时间 | 手机行内修改、冲突、旧资料迁移、真实 Codex 记忆保存 |
| IdeasScreen / refreshIdeas | 目标/PDF 邮件/日程协调规则、两类建议、证据、编辑/接受/忽略；同源去重和已处理任务排除 | 源规则、真实 PostgreSQL、手机流程 |
| GoalsScreen | 四类目标、查看后编辑、里程碑、任务结果联动 | 手机查看/编辑/完成；持久结果和并发检查 |
| MonitorSheet | 默认 15 分钟、条件/间隔/检查次数/最近结果、暂停/恢复/停止、重试与通知 | 实际网页变化、去重、重启恢复、Activity 任务控制 |
| ActivityScreen | 筛选、任务详情、Google 操作分组和回执、Workspace timeline | 真实数据库与手机流程 |
| NotificationsSheet | New / Read、View task、Mark read、来源；既有账号 Web Push | 持久提醒、恢复、已读和账号隔离；没有物理设备展示证明 |
| Apps / ConnectionsScreen | 搜索、真实能力/连接状态、Google、OpenBot 禁用状态、文件/记忆/邮件/日历/电脑入口 | 手机入口；Google 未配置状态如实显示 |

## 文件、结果和浏览器

| 原实现 | 移植和验证 |
| --- | --- |
| FilesScreen / FileDetail | 账号私有对象存储、PDF 上传/预览/下载、元数据和字段；手机浏览器通过 |
| PDF typed input / filled copy | 实际 AcroForm 文本/复选框，保存独立副本，原件保持原字节；真实下载读取字段、跨账号拒绝、持久输入回答与续跑通过 |
| ArtifactCard | 计划、文档、网页、比较，源版内联卡片及真实结果下载；交互网页与刷新回放通过 |
| FinanceArtifact / finance.ts | 完整 CSV 解析、收入/支出/分类/日期、事务记录、储蓄目标；单元、数据库、内联卡片、真实 Codex CLI 计算通过 |
| Chromium / browser sessions | 独立会话、实际截图、接管、输入、关闭/恢复、登录状态、源任务关联；真实 Chromium/Chrome 交互通过 |
| search.ts / SearchToolCard | 原版匿名 Parallel MCP 服务、持久匿名会话、URL/摘录/警告/截断、错误/取消；CLI 接入主聊天和任务，任务来源回放；17 项原版测试及实际外部搜索通过 |
| browser PDF downloads | 实际下载字节、导入个人文件库入口；worker 下载/字节检查、手机浏览器下载→导入→填写→下载副本联合回归通过，下载的真实 PDF 字段值已确认 |
| Task file/browser associations | 0058 保存实际源任务、源执行轮次、文件和独立会话；复用邮件附件、跨实例恢复、账号隔离、暂停拒绝写入通过 |

## 电脑和外部连接

| 原实现 | 移植和验证 |
| --- | --- |
| Computer workspace | Docker/E2B Desktop、账号电脑租约、持久命令/退出/超时回执、实际文件编辑、PDF 导入/导出，源版 Browser / Desktop / Terminal / Files 页 |
| Desktop stream / tool cards | 真实 VNC、截图/点击/键盘、操作 ID、暂停/冷恢复、持久截图；原项目 39 项协议检查、实际 E2B HTTP 验收和手机桌面/终端/文件流程通过；真实 Codex view_image 已确认 |
| Google OAuth | PKCE、一次性状态、加密凭据、重连代际、刷新、断开/撤销；真实 PostgreSQL 通过。独立 Personal Agent 客户端、Keychain 密钥、回调、范围和真实账号连接已验证；原普通登录客户端保留 |
| Mail / thread / attachment | 完整 MIME 正文/线程、搜索、已读状态、附件导入；原项目接口与 fixture 流程通过；2026-10-07 生产真实 Gmail 列表及邮件详情读取通过 |
| Draft / reply / send / ReviewDetail | 持久草稿、回复引用、附件、具体内容确认、发送回执与任务续跑；并发一次、取消/暂停、版本/未知结果检查及刷新恢复通过。2026-10-07 生产向连接账号自身发送测试邮件，Google 返回消息 ID，收件箱打开并核对正文通过。审阅属于源版产品流程，执行器没有权限审批页面 |
| Calendar / EventEditor | 日历选择、日期范围、时区、事件增删改、ETag 版本审阅；接口、持久回执、手机编辑/保存/重载通过；2026-10-07 生产三个日历及订阅日历详情读取、主日历无参会人的测试事件创建/改名/删除通过，创建和修改后均实际重新读取，测试事件已清理 |
| OpenBot | 按源版保留禁用适配器及协议/身份测试；不伪装在线连接 |

## 前一轮 v4 验收记录

- 客户端完整单元检查：108 个文件、1,155 项通过。真实命令字段与任务/桌面回执的最后定向检查：20 项通过。
- 服务端完整检查：1,255 项，首轮唯一失败是测试断言仍匹配旧 room 字段列表；已修正，PostgresStore 43 项定向回归通过，无跳过。
- 个人助理服务 73 项、真实 PostgreSQL 86 项、共享执行/路由/迁移契约 124 项通过；暂停路由与任务最后定向检查 19 项通过。
- Python CLI/broker 40 项、原生截图/计划协议 19 项通过；两端生产构建与 i18n 989 个使用键检查通过。
- 手机 Chrome：个人助理 14 条常规流程逐项通过（首轮 12 条通过、两条测试因旧定位/GET fixture 出错，修正后补跑通过）；实际 E2B 桌面另 1 条通过。
- 最终 E2B 运行器为 0.1.66 / openmuse-parity-v4，已构建、发布和实际检查 CLI/Chromium。真实 Codex 保存记忆、排队任务、填写 PDF、计算财务、查看桌面截图和原生 update_plan 均通过，工具错误为 0；验收沙箱已清理。
- Google fixture 与真实外部连接验收分开；生产缺配置时按源版显示未配置。OCR/扫描表格、其他连接器、APNs/FCM、OpenBot 在线桥接等原项目路线图不宣称已实现。

## 前一轮 v4 生产发布验收

- 功能源码：`12baa7fc`；浏览器时序/定位修正：`434126f7`、`4acb1ba4`。[实现提交的 CI 五项全部通过](https://github.com/Skymore/roomtalk/actions/runs/37535181815)。
- 生产通过本仓库 `scripts/local-production.mjs --profile edge build app ai-worker`、`up -d --no-build` 发布，保留原 checkout 的 14 项既有 presence 差异。镜像：`sha256:466b21507f51b90e716233065f1e56356772c0ec18ffd85bbb60735d233c996c`。
- 迁移 0042–0058 已应用，历史 checksum 没有改写；总计 59 项迁移验证通过。
- 生产 template 为 `realruitao/roomtalk-code-agent-2026-10-06-openmuse-parity-v4`，artifact 为同名未加 owner 前缀的版本，runner 为 0.1.66；engine sourceRef 保持 `0b5e44eb29ad1bec89b2143737f6917aafa79359`。
- 个人电脑已启用 `e2b-desktop`。生产手机页面实际启动桌面，命令输出 `PERSONAL_DESKTOP_PRODUCTION_OK`、退出码 0，实时 VNC 显示真实桌面；验收后停止电脑，保留工作区。
- 已登录生产账号在源版 DelegateSheet 委托计划；真实 Codex app-server/fullAccess 在匹配 v4 沙箱完成，结果 `Production acceptance: three-step release check` 保存于 PostgreSQL。该私人验收任务的 ID 为 `ab89bb71-3988-4281-9484-08df6a8a6d17`，保留回执供查看。
- 手机 390×844：独立个人聊天与五项导航、🦊、默认只读设置、直接显示记忆、源版 Apps/电脑入口实际可用；普通 RoomTalk 聊天仍独立保留。
- App、AI Worker、PostgreSQL、Redis、对象存储和两个 Tunnel 健康；本地、room.ruit.me、ai-chat.wenlin.dev 的 `/api/status` 均为 HTTP 200 / ready:true，队列没有积压。
- Google OAuth 的 client secret/回调配置和可选 Jev live 的 TYPESAFE_API_KEY 仍需外部输入；Jev 保持原版默认 off。OpenBot 在线桥接、其他连接器、OCR 等原项目未实现项目仍保持源版状态，不宣称可用。

## 最新 search / inline UI 模块验收（2026-10-06）

- Chrome 390×844 的五条流程通过：Google fixture 邮件审阅与真实持久草稿、日历时区编辑、目标里程碑、明确脚本 Jev 选择/刷新/草稿保留、Source mail 与 memory 卡片跳转；未把 fixture 当成真实 Google/Jev 连接。
- 搜索：17 项原版 MCP/结果测试通过，实际匿名 Parallel 返回真实仓库来源；broker 和 mail 摘录边界验收通过。
- 运行器 CLI：30 项通过；0.1.68 / v6 已发布，真实 E2B 沙箱核对 manifest、源版本、search/choices CLI 均通过。服务端 22 项搜索/路由/artifact 契约通过；客户端组件/交互 81 项通过。两端生产构建通过。生产状态在实际部署后补充。
- OAuth：Chrome 登录了实际 RoomTalk 项目；回调与五项范围已准备为未提交的表单。创建密钥/扩大敏感访问的 Computer Use 动作确认仍待用户回复，未保存、未启用 Google API，也未读取真实邮箱。

- 字段复查：采用 ui.tsx Field 的外置小标签、白色输入框、浅边框和圆角；新增记忆使用源版单行 Field/42px Remember 按钮。仅作用于个人助理，普通聊天表单不变。20 项组件回归与生产构建通过；手机联合表单流程再次复查。

## v7 真实集成复核

- v6 已部署后，真实 Codex 调用 `roomtalk search web` 返回 `room_context_broker_path_denied`。原因是运行器私有 Unix socket 代理遗漏了 search/choices 路径和 PATCH 放行；并非 Parallel 搜索不可用。已补齐两条路径，搜索等待时间覆盖原版 45 秒期限。43 项运行器测试通过，包含真实私有 socket 的 search/choices CLI 转发；不能用先前的 CLI help 检查代替实际调用。
- 新对话原先残留普通房间的空状态。已按 chat.tsx 移植欢迎文案和 Hacker News、copilotkit.ai、网站监控三个入口。
- 本轮 v6 镜像 `sha256:d000cb7d00c83f4e5c65a47acc63d277309b8b69b21ce2b3c0dc152946892932` 部署健康，本地及两个公网状态均 ready；v7 运行器升级为 0.1.69，后续真实调用结果单独记录。
- v7 模板已发布并在安装后的 E2B 沙箱中实际检查私有代理转发（上游明确为 fixture）。生产独立聊天 `ac3JEZYNew` 实际使用 v7，由真实 Codex 调用匿名 Parallel 搜索，返回 10 个来源及官方仓库链接；刷新后工具卡片和来源完整恢复，数据库中该房间 artifact 为 v7，执行状态 idle。
- 功能版本 `4c563e14` 的 [CI 五项全部通过](https://github.com/Skymore/roomtalk/actions/runs/37548702259)。43 项运行器、66 项相关客户端、3 项 artifact 契约通过；Chrome 390×844 验证记忆直接显示、设置查看/编辑/取消、目标说明截断、原版欢迎页及网站监控入口。
- 暗色复查：对话 canvas 继承个人页面背景，避免嵌套黑色矩形；来源链接采用原版浅蓝 palette，保证深色卡片上的可读性。本地、room.ruit.me、ai-chat.wenlin.dev 均 ready。最终部署证据单独保存在 `/tmp/roomtalk-openmuse-verification-20261006.json`。
- Google OAuth 回调、权限范围仍为未提交草稿；没有新建 secret、启用 Gmail/Calendar API、或声称真实账号连接成功。Jev live 缺少 TYPESAFE_API_KEY，保持源版默认 off。
- 跨标签页复查发现：普通房间记录被另一个标签页覆盖后，个人页面刷新会加入主聊，却仍选中侧聊，导致一直加载。恢复流程现优先使用个人助理自己的已选对话；53 项页面测试通过，包含根路径、个人入口和普通聊天独立恢复的回归。

## OAuth 真实账号连接复核（2026-10-07）

- RoomTalk 项目 `roomtalk-499220` 的独立 Web 客户端为 RoomTalk Personal Agent，回调为 `https://room.ruit.me/api/personal-agent/google/callback`。新密钥已存入生产 Keychain 并部署，普通 RoomTalk 登录客户端保留。
- Google Cloud 显示 Data access changes saved；范围为 gmail.readonly、gmail.send、calendar.calendarlist.readonly、calendar.events.readonly、calendar.events。Gmail API 和 Calendar API 状态均为 Enabled。
- 真实账号连接后的 Google 回调显示 Google is connected；RoomTalk 刷新显示账号与断开连接入口。生产 Gmail 列表与完整邮件详情已实际读取，写权限在 Google 授权页已勾选并授予。用户要求真实测试后，通过生产 UI 向当前连接账号自身发送 `RoomTalk OAuth live mail test 2026-10-07`，Gmail 回执消息 ID `1a115be834e1e766`；收件箱刷新后打开该邮件，收件人和完整正文均一致，无附件或其他收件人。
- 用户于 2026-10-07 确认接受 Calendar API 条款后，Google Cloud 显示 Enabled。生产读到三个真实日历；订阅的美国节假日日历返回四项事件，并打开 Columbus Day 详情。用户要求真实测试后，通过生产 UI 在主日历创建 `RoomTalk OAuth live test 2026-10-07`，时间为 2026-10-08 09:00–10:00 America/Los_Angeles，无参会人。Google 返回事件 ID `10eevkigm1itaq2544fegogl84`，重新读取可见；更新标题为 `RoomTalk OAuth live test 2026-10-07 UPDATED` 并重新读取通过；最后删除同一测试事件，Google 回执 Completed，日期列表为空。只读日历的创建、删除和审阅按钮保持禁用。
- 真实测试反复遇到 Gmail 每分钟配额错误。代码确认个人助理每次快照轮询都会通过建议服务同步 Gmail，错误连带阻断快照。现将 Google 同步留在明确的建议刷新请求中，快照只用已保存的邮件/目标生成建议，与原版快照读取本地数据的边界一致；Google 错误仍在主动刷新时如实显示。
- Google Verification Center 的 Prepare for verification 按钮禁用，提示必须先验证并发布品牌。Branding 缺少必填的公开隐私政策链接，已请求用户提供；尚未提交审核，不将已连接账号的验收扩大为公开应用审核通过。
- 完成目标的旧 E2E 断言已更新；18 项组件测试、个人助理全流程、手机目标及长对话浏览器检查通过。提交 `593b1a94` 的 [CI 五项全部通过](https://github.com/Skymore/roomtalk/actions/runs/37597423310)。本轮仅更新验收记录与 Google Cloud 配置，无需重建应用或 E2B。
- 当前截图、连接结果和未完成事项记录于 `/tmp/roomtalk-openmuse-verification-20261006.json`。
