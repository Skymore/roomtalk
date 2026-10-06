# Personal Agent：Codex 优先实施计划

[English](personal-agent-implementation-plan.md)

状态：独立界面和 OpenMuse 记忆库已部署，生产验证完成
更新：2026-10-06

## 产品范围

在 RoomTalk 增加独立的个人 Agent 入口。第一版每个登录账号一个 Agent，采用 Muse 的长期主聊天、专题聊天、头像状态、目标追踪和活动记录布局。执行器固定为 `codex-app-server`，复用 E2B 执行、回合、队列和文件。个人 Agent 固定完全访问，个人界面不显示模型选择、权限模式或工具审批。

本次完成后部署现有本地生产服务，并验证公网实际行为。本版不引入 OpenMuse/CopilotKit Gateway，也不增加邮箱、支付、连接器市场或其他运行后端。

## 模型认证

本次首发复用系统现有的 Codex 订阅连接，执行器固定为 app-server；不新增 API provider 或 OAuth 应用。模型认证与执行器保持分离，之后可以接入 API。

官方限制旧 app-server 认证用于商业或托管服务。公开托管的订阅产品需要适用的 Sign in with ChatGPT 接入资格；本次复用已有连接不代表取得该资格，技术登录成功不能作为托管授权证明。

官方来源：

- [Codex app-server 认证限制](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [Sign in with ChatGPT 套餐使用](https://developers.openai.com/siwc/token-sharing-open-source)
- [Muse 产品设计](https://introducing.muse.ai/)

## 功能和数据边界

1. 登录后创建个人资料和私密主聊天；资料包含名字、头像、做事偏好和记忆。
2. 专题聊天和目标执行复用 `codeAgent` room，但记录个人所有者与主/任务类型。
3. 个人资料、记忆、目标、日程保存在 PostgreSQL；沙箱仅承载执行与工作文件。
4. 私密聊天在列表、加入、消息、媒体、工作区、实时订阅、上下文读取上检查所有者，不允许普通房间分享、成员邀请或转移所有权。
5. 记忆可查看、修改、删除；每次执行读取当前个人资料，并将其传给 Codex，不把内部上下文重复写进聊天。
6. 目标支持手动、每日、每周执行，保存本地时间和时区；可修改、暂停、删除、立即运行。
7. 后台任务先持久写入执行请求，再由现有回合队列执行；重启后恢复，多个 App 实例不得重复认领同一次调度。
8. 页面关闭不取消执行。任务状态和结果可在活动页回看；完成时使用现有账户推送设施。

## 界面

- 桌面侧栏和手机底栏增加“个人 Agent”。
- 个人首页显示头像、名字、当前工作状态与主聊天入口。
- 聊天、目标、活动、记忆/设置分区保持简洁；专题聊天可重新打开。
- 独立 `PersonalAgentConversation` 不渲染 `CodeAgentRoomView`，隐藏普通房间导航和工作区面板。对话气泡、简短进度、发送/停止、附件和结果链接组成聊天页；停止保留草稿。
- 所有按钮连接真实持久化或运行能力，反馈沿用 `StatusMessage`。

## 实施步骤

- [x] 添加向前迁移、资料/目标仓储和原子调度认领。
- [x] 添加个人 API 与所有者授权，封闭普通房间入口泄露路径。
- [x] 接入 Codex 个人上下文、后台调度与完成通知。
- [x] 实现桌面和手机个人入口、聊天、目标、活动、记忆设置。
- [x] 完成首发 Codex 认证路径并验证真实回合。
- [x] 运行授权/仓储/调度/会话测试、客户端测试和双方构建。
- [x] 通过真实 UI 验证主聊天、专题任务、记忆、目标、刷新恢复和私密性。
- [x] 推送 `origin/master`，核对生产 checkout，再部署。
- [x] 验证本地和公网 readiness、部署后的页面入口，以及真实 Codex 沙箱记忆读写。

## 发布要求

新增迁移只能追加，不能更改已经部署的迁移。本次扩展沙箱内的 `roomtalk memory` 工具，因此必须遵循 `CLAUDE.md` 的 runner 版本、E2B artifact 重建和生产 pin 更新规则，并验证实际沙箱工具与记忆写回。

验证应覆盖第二个账号直接访问个人 room ID、多个实例的调度认领、任务持久化后重启恢复、时区和夏令时，以及浏览器离开页面后仍执行。不能用只有 mock runner 的测试宣称实际 Codex 可用。

发布命令：`node scripts/local-production.mjs --profile edge up -d --build`。源码推送、Compose 发布、E2B artifact 状态和公网 smoke 分开记录。

## 2026-10-05 首发验证记录

- 前后端生产构建通过；授权、持久化、调度、会话及客户端相关测试通过。
- 独立 PostgreSQL 数据库验证并发主聊天创建、记忆 CAS、原子调度认领、队列持久化与回滚，5 项通过。
- Runner/broker/CLI/app-server/daemon/ACP Python 测试 83 项通过。
- E2B artifact `roomtalk-code-agent-2026-10-05-personal-memory-v1` 已构建并发布；runner 版本 `0.1.55`。
- 客户端相关单元测试 101 项通过，ESLint 与双方生产构建通过；独立发布分支也完成双方构建。
- Chrome Playwright 2/2 通过：记忆保存/刷新、私密主聊天与专题任务、目标暂停/编辑/恢复、运行中离开聊天并刷新后继续执行、结果重开、另一账号的 metadata 404 / messages 403、旧私密聊天缓存清除。
- 浏览器端到端使用真实 PostgreSQL、Redis 与模拟 Codex runner；真实模型能力由下述生产验证单独确认。
- 功能源码发布到 `origin/master`：`6816032f`。生产从原 checkout `54dd1e73` 构建，保留其两项既有本地 presence 改动；这些本地改动没有随本次功能发布到远端。
- 已执行 `node scripts/local-production.mjs --profile edge up -d --build`，生产镜像 `sha256:962b9f835b0f904ca304caec42661d61b0b7ac1ac5d2c6fb64d042e025707a7b`。迁移 `0032_personal_agents` 已应用并记录 checksum。
- App、AI Worker、PostgreSQL、Redis、对象存储和两个 Tunnel 服务健康。本地、`https://room.ruit.me`、`https://ai-chat.wenlin.dev` 的 `/api/status` 均返回 HTTP 200、`ready: true`；公网浏览器确认个人入口与未登录提示。
- 生产 template/artifact pin 均为 `roomtalk-code-agent-2026-10-05-personal-memory-v1`；engine source pin 保持 `0b5e44eb29ad1bec89b2143737f6917aafa79359`。
- 使用已有 Codex 订阅连接完成真实 `codex-app-server` 回合：沙箱执行 `roomtalk memory get/set`，读回与 PostgreSQL 记忆一致；回合及最终消息为 `complete`。等待执行 lease 释放后，已删除临时目标/任务/沙箱，并通过 CAS 移除测试记忆，保留原有内容。
- 完成推送通过服务测试验证多设备扇出与所有者隔离；本次没有验证物理设备上的通知展示。

## 2026-10-06 独立 UI 与 OpenMuse 记忆库升级

已查看 [Muse 官方设计页](https://introducing.muse.ai/) 的活动、目标和结果截图，并检查两套 OpenMuse 源码：

- [CopilotKit/OpenMuse](https://github.com/CopilotKit/openmuse/tree/73a714963b57e5cd1747fd3fbc6833e09a36b81a)：`remember_fact` 保存用户明确提供或确认的偏好，保留来源和时间，同一账号共享。
- [diggerhq/OpenMuse](https://github.com/diggerhq/openmuse/blob/2fff664dac90f8d24b67b754912485106660c034/scripts/templates/memory.ts)：个人 profile 保存跨话题偏好；topics 保存概要、决策、来源、完成和待办，版本检查防止并行覆盖。

追加 `0033_personal_agent_memory_library`，PostgreSQL 是记忆权威。条目分为偏好、确认的信息、话题笔记，保存来源对话/回合与时间。用户可以搜索、分页查看、修正、忘记，并打开仍存在的来源对话。原有“关于你”内容保留，个人资料和条目编辑都检查最后读取的更新时间。

每次执行读取最新资料、常用偏好和当前任务匹配的摘要，完整条目由 agent 按需查询。采用支持中文的关键词检索，无需额外 embedding API key；没有宣称向量语义检索。正常 Codex 回合保存用户确认的长期信息，沉淀长话题的决策和后续工作；修改前检索已有条目，冲突后重读，只有工具成功才报告已记住。忘记后不从旧聊天擅自重建。

CLI 支持 `roomtalk memory list/search/save/forget`；更新和删除携带读取时间，来源由服务端生成。broker 验证账号、私密聊天和当前执行 lease。runner 为 `0.1.56`，E2B artifact 为 `roomtalk-code-agent-2026-10-06-personal-memory-library-v1`。

### 升级验证与部署记录

- 服务端完整测试 1098/1098、客户端完整测试 1135/1135、Python runner 测试 84/84 通过；最终相关服务测试 113/113、ESLint 与双方生产构建通过。
- Chrome Playwright 3/3 通过，覆盖独立聊天界面、固定完全访问、记忆新增/搜索/编辑/忘记、停止后保留草稿、目标后台执行、刷新恢复及其他账号隔离。浏览器测试使用真实 PostgreSQL/Redis 与模拟 Codex runner，现已加入 CI。
- 功能源代码 `29d38bbe` 的 [CI 全部通过](https://github.com/Skymore/roomtalk/actions/runs/37405389564)。历史迁移测试的种子数据结构与最新仓储不匹配已修复；并行事件测试改为使用实际提交的事件 ID，消除对请求胜出顺序的假设。
- E2B artifact 已重新构建、发布并更新生产 pin。追加迁移 `0033_personal_agent_memory_library` 已应用，现有个人聊天改为完全访问。
- 生产从 `4f3d7109` 构建，保留既有两项本地 presence 改动；镜像为 `sha256:137459045effc0bc418b49ee180874843718621e03d90b4ce6c4bab39e4fdd6d`。App、AI Worker、数据库、Redis、对象存储与两个 Tunnel 健康，本地及两个公网 `/api/status` 返回 HTTP 200、`ready: true`。
- 部署后使用已有 Codex 订阅执行四个真实沙箱回合：记住带来源的话题笔记、在新对话找回未写入该次提示的内容、修正同一条目而不重复新增、忘记该条目。四步均完成，数据库结果与工具执行一致；执行 lease 释放后已清理临时目标、聊天、沙箱及测试记忆，保留原有资料。


## OpenMuse 后续模块顺序

每轮完成一个可独立验证、上线的模块，沿用 RoomTalk 的账号、PostgreSQL、回合队列与执行器，不搬入 OpenMuse 的整套网关或托管线程依赖。结构化记忆和独立聊天界面是现有基础。

| 顺序 | 模块 | 当前基础与下一步 |
| --- | --- | --- |
| 1 | 聊天管理 | 已完成：稳定主聊天、独立专题、搜索、改名、归档、恢复 |
| 2 | 对话中的目标与后台任务 | 已完成：共用日程、聊天工具、里程碑、真实执行状态、取消和成果完成；已用真实 Codex 验证 |
| 3 | 记忆整理 | 已完成：主题交接、同名重复校验、审阅合并、来源保留和聊天关联；真实 Codex 已验证 |
| 4 | 结果卡片 | 已完成并部署：持久计划、文档和网页卡片，支持预览、下载和跨聊天读取 |
| 5 | 浏览器与接管 | 已完成并部署：实际 Chromium、同会话接管、不可变来源截图、加密登录状态；真实 Codex 已验证 |
| 6 | 主动建议与持续追踪 | 已完成并部署：来源建议、网页条件检查、变化去重、暂停/恢复与持久提醒；真实 Codex 已验证 |

### 模块 1：聊天管理

参考 [OpenMuse 的专题聊天管理源码](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/mobile/src/threads.tsx) 的稳定主聊天、专题改名、归档和恢复。聊天面板拆为 `PersonalAgentChats`，保持搜索框和每条对话的重命名和归档/恢复按钮，不加入工作区控件。

追加 `0034_personal_agent_conversation_archive`，归档保存在 room 元数据中。只修改当前账号的专题聊天；主聊天不能归档或通过专题接口改名。归档不删除消息、沙箱执行或共享记忆，不取消目标日程。活动页保留后台工作，记忆来源和原聊天链接仍可打开。恢复保留原 room ID；实时事件包含归档的提交后状态，旧事件不改写，其他运行状态更新不清空归档。

验证：服务端 API、真实 PostgreSQL、历史迁移、事件协议与仓储测试 120/120 通过；客户端相关测试 11/11、双方生产构建、i18n 检查与相关 ESLint 通过。Chrome Playwright 的完整个人 Agent 流程通过：专题改名、搜索、归档、刷新、恢复、重开原消息，以及归档运行中的目标后继续完成；另一账号修改返回 404。发布验证另行记录。本模块没有修改 runner、工具或沙箱文件，因此保留已验证的 E2B artifact。


### 模块 2 第一阶段：共用目标服务与准确日程

参考 [OpenMuse 的持久目标服务](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/server/src/engine/service.ts) 的保存后返回记录原则。先将表单保存提取到 `personalAgentGoals`，下一阶段的聊天工具复用同一套校验与版本规则。界面拆出独立 `PersonalAgentGoals`，支持明确选择每周的星期、一次性执行日期，以及编辑时使用读取到的版本，避免覆盖另一段聊天的新修改。

追加 `0035_personal_agent_goal_schedules`：旧每周目标按原时区中的创建星期回填；单次任务在创建私有执行聊天、保存提示和入队的同一事务中清空下次执行时间。服务重启和重复定时领取不再触发第二次。目标运行采用事务内读取的标题和提示。修改已删除的旧版本返回冲突，不会重新创建已删除目标。定时任务要求明确时区；单次日期保存为带时区的绝对时间。

验证：服务端 API、共用保存规则、夏令时、调度器与真实 PostgreSQL 共 27/27 通过，包含旧每周日程迁移、单次入队/重启/重复领取和删除后旧编辑；客户端相关测试 11/11、双方生产构建、i18n 与相关 ESLint 通过。真实 Chrome 表单流程创建星期五任务与单次任务，刷新后保存结果一致，并完成原有聊天、记忆、任务执行及账号隔离流程。聊天工具和目标执行状态仍属于模块 2 的后续工作，尚未声称完成。


### 模块 2 第二阶段：聊天目标工具、里程碑和执行状态

参考 OpenMuse 对目标成果、里程碑与后台执行的区分。新增 `roomtalk goal list/create/update/run/pause/resume/cancel/delete`，通过当前回合的私有 broker 访问同一套目标服务。聊天工具读取已保存版本后修改；普通房间、其他账号、已结束回合和只读模式不能写入。提示明确日程时区、先查询相关目标、按真实结果更新进展，正在执行某个目标的聊天不能再递归运行自己的目标。

追加 `0036_personal_agent_goal_progress` 保存里程碑和成果完成时间。执行状态从持久排队消息、回合和实际 lease 读取；一次执行完成不会自动完成整个目标。手动重复运行复用仍在排队或执行的聊天。取消先暂停未来日程，再通过现有队列和 runner 请求停止；界面区分取消请求和实际停止。删除保留执行聊天并产生正确的 room 事件。独立目标界面支持里程碑、完成/重新开启、查看工作和取消执行；星期改用直接按钮，避免长表单中下拉无法展开。

验证：目标 API、共享校验和真实 PostgreSQL 28/28；回合、上下文和日程回归 114/114；客户端相关 12/12；Python broker/CLI 27/27；双方构建、i18n 与相关 ESLint 通过。真实 Chrome 完整流程通过，包括星期/单次日期、里程碑、完成后刷新与重新开启、后台执行取消、手机宽度和账号隔离。浏览器使用真实 PostgreSQL/Redis 与模拟 runner；真实 Codex 和发布结果随后单独记录。Runner 升级到 0.1.57，E2B `roomtalk-code-agent-2026-10-06-personal-goals-v1` 已构建并发布。

发布验证：使用已有 Codex 订阅完成五个真实工具回合和两次后台执行。跨聊天创建、修改/暂停、运行、确认成果完成、重新开启、取消和删除均与数据库一致；被取消的回合实际为 `cancelled` 且 lease 释放。七个私有执行聊天、临时目标和沙箱已清理，未修改原有目标与记忆。模板直接检查确认 runner 0.1.57 和全部 goal 命令。发布时遗漏的 ACP artifact 识别常量已同步，相关后端/配置测试 21/21 通过。


### 模块 3：主题交接和记忆整理

参考 [OpenMuse 的文档式主题记忆](https://github.com/diggerhq/openmuse/blob/2fff664dac90f8d24b67b754912485106660c034/scripts/templates/memory.ts)。继续主题会创建关联同一条记忆的私有聊天；每个回合读取完整最新文档，包含背景、已确认结论、来源、实际验证和下一步，不复制截断摘要。追加 `0037_personal_agent_topic_handoff`，关联与来源保存在 PostgreSQL；旧 room 事件保持原样，新事件记录提交后的关联。

同类同名条目经过大小写、Unicode 和空白归一后禁止重复新增，返回已有条目供审阅。语义相近或矛盾的内容由用户或当前聊天读取原文后整理，不能仅按时间判断真伪。独立记忆页面支持选择、审阅原文和保存合并；`roomtalk memory merge` 调用同一服务。合并检查每条原文版本，在同一事务保留一个 ID、全部来源，改绑已有聊天并删除重复条目。并发更新返回冲突，保留编辑草稿；忘记文档清空关联，后续提示不再注入。

验证：服务端/API/真实 PostgreSQL/事件与 runner 配置 139/139；仓储与历史迁移 99/99；客户端相关测试 13/13；Python CLI/broker 28/28；双方构建、i18n、相关 ESLint 通过。Chrome 主题流程通过：完整交接、同名重复、并发编辑冲突、审阅合并、来源保留、原聊天关联、刷新、手机宽度和遗忘。Runner 0.1.58 与 E2B `roomtalk-code-agent-2026-10-06-personal-topics-v1` 已发布；模板直接检查与五项 CI 均通过。真实 Codex 验证结果另行记录。

发布验证：新模板直接检查确认 runner 0.1.58 和 memory merge 命令；生产 App、AI Worker 及依赖健康，本地和两个公网接口均 ready。已有 Codex 订阅完成五个真实回合：保存完整带来源主题文档；新聊天无需检索读取 500 字之后的交接内容；合并用户确认的修正并保留来源；原聊天改绑后读取最新文档；遗忘后解除关联。数据库和实际工具执行一致，临时目标、聊天、沙箱与记忆已清理。代码提交 `76472a99` 的五项 CI 全部通过。生产镜像为 `sha256:a12ae066bb1f83999d5c8290b7cd5a582e0273294625f8d76083c1d0d5cf7ff6`，保留原有本地 presence 修改。


### 模块 4：持久结果卡片

参考 [OpenMuse 的聊天结果卡片](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/mobile/src/thread-artifacts.tsx) 的按持久 ID 加载原则。追加 `0038_personal_agent_results`，保存真实回合来源、标题、摘要、文件名和对象存储位置；下载链接不写进消息。文件保存在现有私有对象存储，与临时沙箱生命周期分离。聊天回放按 room/turn 读取卡片，打开时重新鉴权读取实际文件。

新增 `roomtalk result save/list/get`。保存只接受当前账号的私有可写活动回合；数据库插入再次检查同一 room/turn 的实际 lease。跨聊天可读取已保存文件，再修改并保存新版结果。计划使用 Markdown；文档可预览 Markdown、文字、PDF 和图片，其他格式下载后用对应应用打开；网页采用单文件 HTML，在独立 frame 中运行脚本并提供下载。界面只有标题、简短摘要、打开和下载，不增加工作区面板。文本上限 512 KiB，文件上限 4 MiB。归档保留结果；清空来源历史或删除聊天时删除关联记录并清理文件。

验证：服务端、API、仓储、实际 PostgreSQL 和回合/事件回归共 260 项通过；客户端 14 项、Python CLI/broker 30 项、双方构建、i18n 和相关 ESLint 通过。Chrome 完成保存三种结果、回放刷新、计划阅读、真实 PDF 下载字节一致、交互网页按钮、手机布局和结束回合拒绝保存。浏览器采用实际 PostgreSQL/对象存储与模拟 runner；真实 Codex 和生产发布结果另行记录。Runner 0.1.59、E2B `roomtalk-code-agent-2026-10-06-personal-results-v1` 已发布并直接检查结果命令。

发布验证：已有 Codex 订阅完成两个真实回合，保存计划、有效 PDF 和自包含交互网页；PDF 经 MuPDF 读取，网页经实际 Chromium 点击验证。销毁来源 E2B 沙箱后，文件字节保持一致。新聊天只接收结果 ID，实际取回计划和 PDF、读取未提供给新提示的确认码并保存修改版；原版不变。两个临时目标、聊天、沙箱及四个私有对象均已清理。生产 App/AI Worker 与依赖健康，本地及两个公网 ready；镜像 `sha256:e38f77ed37e02e3176096347d5e3b6913c09db3f0d6d7e6a4954258cb57908ed` 保留原有 presence 工作。

CI 修复：结果卡片单测隔离 Iconify 异步图标加载，避免 jsdom 关闭后的回调异常；旧工作区浏览器测试在完成后展开工具记录再检查，避免依赖短暂的运行中状态。客户端完整 105 个文件、1,142 项断言和相关 Chrome 三项流程通过；此修复只改测试和文档，无需重建应用或 E2B 模板。


### 模块 5：浏览器与接管

参考 OpenMuse 的 [来源卡片](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/mobile/src/browser-tool-card.tsx)、[用户接管控制台](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/server/src/browser-console.ts) 和 [实际 Playwright 浏览器](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/worker/src/browser.ts)。同一个 RoomTalk E2B 环境维护实际 Chromium 会话，代理通过 `roomtalk browser` 操作；用户在独立浏览器弹层接管同一页面、点击、输入、按键、滚动和缩放。使用既有房间执行 lease，让代理和用户依次操作。

迁移 `0039_personal_agent_browser` 持久化每次代理操作的来源 URL、标题和截图；回放使用当时记录，不替换成之后的网页。登录 cookies、localStorage 和 IndexedDB 使用既有 Codex 加密密钥保存，关闭浏览器后重新打开时恢复。截图通过账号认证接口读取，清空聊天或删除房间会移除相应来源对象和登录状态。界面保留简单聊天入口，无执行器选择或权限审批。

验证：真实 Chromium 引擎检查、Python CLI/broker 32 项、浏览器服务/API 5 项、实际 PostgreSQL 15 项、既有仓储及回合 149 项、客户端 18 项、双方构建和相关 ESLint 通过。完整 Chrome 个人 Agent 5 个流程通过；浏览器流程使用实际 PostgreSQL、Redis、对象存储及 Chromium，模型回合为模拟 runner。Runner 0.1.60 和 E2B `roomtalk-code-agent-2026-10-06-personal-browser-v1` 已发布并直接验证实际 Chromium、截图与 CLI 命令。真实 Codex 与发布结果另行记录。


### 模块 6 实现依据（待实现）

OpenMuse 的 [engine/service.ts](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/server/src/engine/service.ts) 从实际来源生成建议，其中没有里程碑的未完成目标会得到制定计划的建议；接受建议会关联执行任务，已接受、已忽略或已处理的来源不会重复生成。RoomTalk 初期使用已有个人目标、记忆和结果来源，不接入演示邮箱或新增第三方账号。建议应展示理由与来源，用户可修改任务文字后接受，或忽略；重复接受必须返回同一任务。

同一源码的持续追踪支持页面变化、包含指定文字以及美元价格阈值。首次观察作为基线；文字/价格条件由未满足变为满足才提醒，同一结果不重复提醒，重新变为不满足后可以再次触发。保留实际页面来源和检查时间，检查失败不当作页面变化；沿用有界退避和明确暂停/恢复。通知参考 [BackgroundUpdates](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/mobile/src/background-updates.tsx) 的简短聊天更新，提供已读/关闭与背景更新偏好。使用现有 PostgreSQL 队列和浏览器执行环境，页面指纹采用规范化文字比较，无需新增哈希或签名系统。


模块 5 发布验证：生产 App 和 AI Worker 使用镜像 `sha256:107a55843d87c5fb36aedf2221764fd055271c8e67d530b0c16ad647daa38e93`，迁移 `0039_personal_agent_browser` 和 browser-v1 artifact 已生效。已有订阅在 `codex-app-server` 下完成两个真实 fullAccess 回合：创建并打开实际 HTTP 页面；用户接管输入一个未写入下一次提示的值；下一回合从同一浏览器读回该值并重新加载确认；关闭后以数据库中的加密状态恢复浏览器仍读到该值。旧来源 URL 保持不变。已移除临时目标、聊天、沙箱和六张来源截图，确认无剩余 fixture 或活动 lease。手机缩放后点击验证通过；本地及两个公网 `/api/status` 均为 HTTP 200、`ready: true`。

模块 5 CI 修复：旧 SQL 仓储模拟器未识别新增的浏览器状态清理语句，导致清空历史/媒体清理的两项旧测试失败；已补齐测试模拟器，43 项仓储契约测试通过，实际 PostgreSQL 15 项已通过。此修复只有测试，不需重建已验证的运行版本。


### 模块 6 第一阶段：来源建议

新增独立“建议”页面：展示实际理由和保存的来源，用户可修改指令后开始任务，也可忽略。没有步骤的未完成目标可以生成制定计划的建议；记忆、结果和网页建议由代理使用 `roomtalk idea propose` 引用真实记录。来源标题、摘录、时间和所属账号均从数据库读取。

迁移 `0040_personal_agent_ideas` 持久化来源版本与接受/忽略决定。同一来源版本只生成一条建议，接受与私有任务、队列指令在同一个事务提交；并发或重复接受返回同一个任务。来源改变或删除后，旧建议不再启动。Runner 0.1.61 与 ideas-v1 artifact 为匹配版本。

本地验证：实际 PostgreSQL 事务和来源/API 6 项、既有仓储/目标/调度回归 70 项、Python CLI/broker 33 项、客户端 14 项、双方构建与相关 ESLint 通过。Chrome 真实 UI 流程验证修改后接受、重复接受、忽略与刷新，使用实际 PostgreSQL/Redis，模型部分使用测试 runner；390px 手机截图已检查。页面跟踪、变化提醒和通知偏好仍属于模块 6 后续工作，不能将第一阶段视为整个模块完成。生产及真实 Codex 验证另行记录。


模块 6 第一阶段发布验证：实现提交 `701ed500` 的 [CI 37457176010](https://github.com/Skymore/roomtalk/actions/runs/37457176010) 五项全部通过。生产 App/Worker 镜像为 `sha256:2c1b26cb6f4985336e7c99c247e7669970bca4cbbe74141f612148f61b6aa0de`，迁移 `0040_personal_agent_ideas` 和 ideas-v1 模板已生效。真实 Codex app-server 完成两个 fullAccess 回合：保存实际记忆并提出引用该记录的建议，随后接受修改后的指令，在新任务中读回未写入该指令的参考值；重复接受未生成新任务，忽略决定在重新创建服务后仍保留。临时目标、聊天、沙箱、记忆和建议均已清理，确认无活动 lease。公网 Chrome 390px 页面验证展开来源、编辑、忽略及刷新；临时测试账号也已移除。本地和两个公网 `/api/status` 均为 HTTP 200、`ready: true`。

模块 6 下一阶段实现约束：每条页面跟踪使用独立且持久的浏览器房间，复用已有 E2B 浏览器与房间执行 lease，避免导航用户正在聊天的页面。检查无需反复启动模型；使用实际 URL、标题、规范化正文和检查时间。页面变化首次仅建立基线；文字或美元价格首次符合条件即可提醒，之后仅未满足到满足时提醒，同一检查结果及通知重试不重复生成通知。暂停/恢复会使旧检查失效，失败不会更新变化基线，五次连续失败暂停并允许手动恢复。数据库同时提交检查状态与通知；背景任务完成与页面提醒采用简短已读/关闭通知，并保留账号级显示和推送偏好。


### 模块 6 第二阶段：网页跟踪与持久提醒

已实现独立跟踪页和实际浏览器检查，支持网页变化、出现指定文字、美元价格阈值，保留实际来源。每条跟踪有独立的浏览器与加密登录状态，用户可以打开网页接管；重复创建不会产生额外房间。首次变化观察建立基线，条件持续满足不重复提醒，条件退出后允许再次触发。失败保留基线，按 2/4/8/16 分钟退避，连续五次失败暂停。暂停和恢复使旧检查失效；到期判断使用 PostgreSQL 时钟，避免立即检查因毫秒精度差而错过。

迁移 `0041_personal_agent_tracking_notifications` 同时保存检查结果和提醒。后台任务的最终消息与完成/失败提醒同事务提交，取消任务不提醒，主聊天不制造后台提醒。动态页保留已读历史，首页简短提示支持关闭；账号提供显示和推送偏好，推送仍沿用现有订阅与设备隔离。Runner 0.1.62 与 tracking-v1 模板已发布并通过真实 Chromium/CLI 直接检查。

本地验证包含实际 PostgreSQL 去重、旧 lease/旧版本拒绝、提醒原子回滚、已读及偏好持久化；HTTP 503 不当作变化、数据库故障不当作页面故障；私有 turn/public owner API、Python 私有 broker、客户端失败草稿和提醒处理测试通过。端到端和生产发布状态另行记录。


模块 6 第二阶段生产验证：迁移 `0041` 和 tracking-v1 已生效。本地及两个公网入口就绪。两个真实 fullAccess Codex app-server 回合通过私有工具创建跟踪、列出跟踪、读取实际更新、暂停并标记已读；第二次指令没有包含来源参考值，模型从保存的网页提醒中正确找回。实际 E2B Chromium 完成三次后台检查，验证初始未匹配、网页变化后提醒，以及持续匹配时去重；最终消息对应的完成提醒也能读回。临时目标、房间、跟踪、通知、沙箱及网页服务均已移除。公网 390px Chrome 验证添加、实际来源提醒、已读刷新、显示/推送偏好与动态深链接，临时账号已清理。网页失败和五次失败暂停另由真实 PostgreSQL 和 Chrome 非成功 HTTP 测试验证；未声明物理设备收到系统推送。

发布校验发现并修正了 ACP 版本常量仍指向 ideas-v1 的遗漏；版本校验测试通过。手机导航改为两行展示六个入口，避免隐藏记忆等页面。六个模块的实现、来源依据与逐模块验证均记录在本计划；最终发布以 master CI 和公网就绪检查为准。
