# OpenMuse 逐项移植清单

初步目标是完整移植 OpenMuse 已实现的页面、功能和操作流程，然后再做自己的优化。基准固定为 [CopilotKit/OpenMuse `73a714963b57e5cd1747fd3fbc6833e09a36b81a`](https://github.com/CopilotKit/openmuse/tree/73a714963b57e5cd1747fd3fbc6833e09a36b81a)。以实际源码为准：该版本 FEATURES.md 对图形桌面的描述落后于源码，因此桌面也纳入范围；路线图中的未实现项目不算当前功能。

用户要求的差异：执行器固定 Codex app-server/fullAccess；入口 🦊；个人聊天留在个人助理里；记忆进入后直接显示；设置默认只读，点击编辑后修改。普通 RoomTalk 对话保留原有功能。

截至 2026-10-06，功能代码已推送并部署，匹配 E2B 运行器已发布，手机生产 UI、实际 Codex 委托任务与 E2B 桌面已验收。Google 仍缺少生产 OAuth client secret 和回调配置，未做真实账号连接；界面 fixture 不算外部服务验收。

## 页面和操作流程

| OpenMuse 原实现 | RoomTalk 移植 | 验证 |
| --- | --- | --- |
| App.tsx 主导航、头像、通知头部 | Chat / Activity / Ideas / Goals / Apps；统一菜单、狐狸、名字、实际工作状态与铃铛；没有双重头部或常驻通知横幅 | 手机与桌面浏览器切换、刷新恢复 |
| threads.tsx 主/侧聊天、抽屉 | 主聊天默认打开；新侧聊天、重命名、归档/恢复、历史翻页和快捷入口 | 真实 PostgreSQL 与 Chrome 流程 |
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
| browser PDF downloads | 实际下载字节、导入个人文件库入口；worker 下载/字节检查、手机浏览器下载→导入→填写→下载副本联合回归通过，下载的真实 PDF 字段值已确认 |
| Task file/browser associations | 0058 保存实际源任务、源执行轮次、文件和独立会话；复用邮件附件、跨实例恢复、账号隔离、暂停拒绝写入通过 |

## 电脑和外部连接

| 原实现 | 移植和验证 |
| --- | --- |
| Computer workspace | Docker/E2B Desktop、账号电脑租约、持久命令/退出/超时回执、实际文件编辑、PDF 导入/导出，源版 Browser / Desktop / Terminal / Files 页 |
| Desktop stream / tool cards | 真实 VNC、截图/点击/键盘、操作 ID、暂停/冷恢复、持久截图；原项目 39 项协议检查、实际 E2B HTTP 验收和手机桌面/终端/文件流程通过；真实 Codex view_image 已确认 |
| Google OAuth | PKCE、一次性状态、加密凭据、重连代际、刷新、断开/撤销；真实 PostgreSQL 通过。生产仍缺少 client secret/回调配置，未连接真实 Google 账号 |
| Mail / thread / attachment | 完整 MIME 正文/线程、搜索、已读状态、附件导入；原项目接口测试通过，浏览器使用明确 Google 响应 fixture |
| Draft / reply / send / ReviewDetail | 持久草稿、回复引用、附件、具体内容确认、发送回执与任务续跑；并发一次、取消/暂停、版本/未知结果检查及刷新恢复通过。审阅属于源版产品流程，执行器没有权限审批页面 |
| Calendar / EventEditor | 日历选择、日期范围、时区、事件增删改、ETag 版本审阅；接口、持久回执、手机编辑/保存/重载通过；真实 Google 日历尚未验收 |
| OpenBot | 按源版保留禁用适配器及协议/身份测试；不伪装在线连接 |

## 本地验收记录

- 客户端完整单元检查：108 个文件、1,155 项通过。真实命令字段与任务/桌面回执的最后定向检查：20 项通过。
- 服务端完整检查：1,255 项，首轮唯一失败是测试断言仍匹配旧 room 字段列表；已修正，PostgresStore 43 项定向回归通过，无跳过。
- 个人助理服务 73 项、真实 PostgreSQL 86 项、共享执行/路由/迁移契约 124 项通过；暂停路由与任务最后定向检查 19 项通过。
- Python CLI/broker 40 项、原生截图/计划协议 19 项通过；两端生产构建与 i18n 989 个使用键检查通过。
- 手机 Chrome：个人助理 14 条常规流程逐项通过（首轮 12 条通过、两条测试因旧定位/GET fixture 出错，修正后补跑通过）；实际 E2B 桌面另 1 条通过。
- 最终 E2B 运行器为 0.1.66 / openmuse-parity-v4，已构建、发布和实际检查 CLI/Chromium。真实 Codex 保存记忆、排队任务、填写 PDF、计算财务、查看桌面截图和原生 update_plan 均通过，工具错误为 0；验收沙箱已清理。
- Google fixture 与真实外部连接验收分开；生产缺配置时按源版显示未配置。OCR/扫描表格、其他连接器、APNs/FCM、OpenBot 在线桥接等原项目路线图不宣称已实现。

## 生产发布验收

- 功能源码：`12baa7fc`；浏览器时序/定位修正：`434126f7`、`4acb1ba4`。[实现提交的 CI 五项全部通过](https://github.com/Skymore/roomtalk/actions/runs/37535181815)。
- 生产通过本仓库 `scripts/local-production.mjs --profile edge build app ai-worker`、`up -d --no-build` 发布，保留原 checkout 的 14 项既有 presence 差异。镜像：`sha256:466b21507f51b90e716233065f1e56356772c0ec18ffd85bbb60735d233c996c`。
- 迁移 0042–0058 已应用，历史 checksum 没有改写；总计 59 项迁移验证通过。
- 生产 template 为 `realruitao/roomtalk-code-agent-2026-10-06-openmuse-parity-v4`，artifact 为同名未加 owner 前缀的版本，runner 为 0.1.66；engine sourceRef 保持 `0b5e44eb29ad1bec89b2143737f6917aafa79359`。
- 个人电脑已启用 `e2b-desktop`。生产手机页面实际启动桌面，命令输出 `PERSONAL_DESKTOP_PRODUCTION_OK`、退出码 0，实时 VNC 显示真实桌面；验收后停止电脑，保留工作区。
- 已登录生产账号在源版 DelegateSheet 委托计划；真实 Codex app-server/fullAccess 在匹配 v4 沙箱完成，结果 `Production acceptance: three-step release check` 保存于 PostgreSQL。该私人验收任务的 ID 为 `ab89bb71-3988-4281-9484-08df6a8a6d17`，保留回执供查看。
- 手机 390×844：独立个人聊天与五项导航、🦊、默认只读设置、直接显示记忆、源版 Apps/电脑入口实际可用；普通 RoomTalk 聊天仍独立保留。
- App、AI Worker、PostgreSQL、Redis、对象存储和两个 Tunnel 健康；本地、room.ruit.me、ai-chat.wenlin.dev 的 `/api/status` 均为 HTTP 200 / ready:true，队列没有积压。
- 唯一尚需外部输入的生产连接验收是 Google OAuth 的 client secret/回调配置。OpenBot 在线桥接、其他连接器、OCR 等原项目未实现项目仍保持源版状态，不宣称可用。
