# RoomTalk 全量 Commit Review（163 commits）

[English](COMMIT_REVIEW.en.md)

Reviewed: 2026-07-12

> 当前状态：历史审查记录。本文覆盖 `5a991ae` → `7238ebe` 的 163 个
> commit，不覆盖当前 `master` 后续提交。旧段落中的“疑似仍在现行代码中”
> 已有后续“现行代码核验与修复跟进”说明，阅读时以后者为准。

> **计划 + 评审记录**。对 master 历史 `5a991ae`（Initial commit）→ `7238ebe` 共 163 个 commit 逐一评审：每个 commit 看完整 diff，记录改动内容、质量评价与发现的问题，按特性阶段分 7 批并行进行，每完成一批回填本文档。
>
> 开始时间：2026-06-10 ｜ 状态：⏳ 评审中 / ✅ 已完成
>
> 每条 commit 记录格式：**改动**（做了什么）/ **评审**（质量与设计评价）/ **问题**（发现的具体问题，按 [高]/[中]/[低] 标注严重度）。

## 计划与进度

| 批次 | 主题 | 范围（旧→新） | 数量 | 状态 |
|------|------|---------------|------|------|
| 1 | 项目奠基：基础聊天、图片消息 v1、Fly 部署 | `5a991ae` → `e171699` | 36 | ✅ |
| 2 | v1.0：流式 AI 助手、设计系统、多模型接入与构建修复 | `76c669b` → `5abad60` | 27 | ✅ |
| 3 | E2E 测试体系、桌面侧栏、Postgres 持久化与迁移 | `74b2690` → `c4692c7` | 25 | ✅ |
| 4 | 移动端键盘/composer、回复与 AI speaker、Gemini、乐观发送 | `c09f4bd` → `4b8059b` | 26 | ✅ |
| 5 | 私有图片存储、语音消息与流式转写、移动端打磨 | `5214626` → `b0d7fab` | 18 | ✅ |
| 6 | 历史分页与版本化缓存、首屏性能、媒体统一对象存储 | `251682b` → `2137a3d` | 17 | ✅ |
| 7 | 房间管理与安全、会话恢复与排序可靠性 | `968b6df` → `7238ebe` | 14 | ✅ |

> 过程记录：首轮 7 批并行评审中，6 批因会话用量限额中断，仅批次 3 完成。19:40 限额重置后分两波重跑（先 1/2/4，后 5/6/7），并改为边评审边写入 `tmp/commit-review/batch-N.md` 以保留中间进度。

---

## 批次 1：项目奠基（36 commits，`5a991ae` → `e171699`）

**批次小结**：本批 36 个 commit（2025-03-26 ~ 04-25）完成从零到上线的奠基：先以 Express+Socket.IO+Redis 搭出"房间 ID 即访问凭证"的匿名聊天骨架，随后整体 TS 化并把消息存储重构为按房间分 key；中段密集打磨移动端布局、Markdown/KaTeX 渲染与图片消息链路（contentEditable 混合编辑器 → base64 直传 → 客户端压缩 → 服务端分块上传 + sharp 转 WebP）；末段接入 Winston 日志、Docker/Fly.io 部署与 socket.io redis-adapter 多实例支持。技术方向基本踩对（消息分 key、会话态 Redis 化、websocket-only 适配多实例），但工程纪律松散：多主题大杂烩 commit 与名实不符的 message 频出；依赖管理粗放（三个图标包与 react-markdown/remark/rehype 全家桶装而不用，两次漏提依赖/lockfile 直接断构建）；图片链路先后引入两次用户可见回归（>1MB 断连、双重 data: 前缀致图片全挂）；安全上 KaTeX trust:true 与无限制分块上传留下 XSS/DoS 敞口。

**重点问题**：
- `2a14e96` [高] 图片以 base64 走 socket.io，超默认 1MB 缓冲即断连，常见照片发送即失败（130c338/91197fa 修复）
- `d0c6113` [高] MessageItem 无条件加 `data:` 前缀与既有 data URL 双重叠加，全部图片渲染失败约两周（e811f66 修复）
- `d0c6113` [高] 分块上传无大小/数量/超时限制可内存 DoS；稀疏分块下 `Buffer.concat` 在 try 外抛出致 unhandled rejection 可崩进程
- `09be082` [中] KaTeX `trust: true` 允许 `\href{javascript:...}` 等受信命令，恶意消息可构造点击型 XSS（e811f66 后仍在）
- `317538c` [中] 编译产物静态托管路径解析到 server/client-heroui/dist，生产 start 不可用（2a14e96 修复）
- `16b9ff5` [中] 部署 workflow 触发分支写死 main 而仓库用 master，自动部署从未触发（后续 5b85fe1 修复）
- `16b9ff5` [中] socket:clients/socket:rooms/room members 等 Redis 键无过期，实例被 auto_stop/崩溃后脏会话与虚高人数永久累积
- `4c6165c` [中] 日志仅写本地文件、无 stdout 输出，容器化部署下日志不可见且随实例销毁丢失
- `91197fa` [中] 漏提 browser-image-compression 依赖致构建失败（a0f6b93 补）；.env.development 被改指生产地址
- `d0c6113` [中] sharp 进 package.json 但 lockfile 未更新，`npm ci`/Docker 构建断档至 42ce237
- `e811f66` [中] 注释掉 React.StrictMode 回避双挂载问题；无用 markdown 依赖进一步膨胀
- `e171699` [中] VM 内存 1GB→256MB 与 sharp 大图处理（且分块上传无上限）冲突，易 OOM
- `2a14e96` [中] 成员计数按 clientId 存内存且多标签页同用户一关全减，计数失真（16b9ff5 迁 Redis 后仍有脏数据问题）

#### `5a991ae` Initial commit: RoomTalk - Real-time Chat System with Redis
- 改动：一次性提交全套骨架：React+HeroUI+i18n 前端（房间列表、消息页、localStorage 保存房间）、Express+Socket.IO 后端、Redis 存储（全部消息存单一 list，rooms 存 hash）、HTTP API 与静态托管。
- 评审：脚手架完整可跑、注释清晰，但存储与"鉴权"均为玩具级：身份完全信任客户端自报 clientId。
- 问题：[中] 所有消息存单个 list "messages"，每次读历史 `lRange(0,-1)` 全量拉回再 JS 过滤，O(总消息数)（317538c 重构修复）；[中] `register` 后把全部房间发给任意客户端，房间 ID 即访问凭证却被全量泄露（6c778fb 修复）；[低] `create_room` 不校验 name（ba4e1b6 修复）、saveRoom 失败仍回调 room.id；[低] MessageList 卸载时 `socket.off('message_history')` 不带 handler 会移除所有同名监听。

#### `274f5ce` Update README to reflect project name as RoomTalk
- 改动：仅 README/README.zh 各两行，统一项目名为 RoomTalk。
- 评审：纯文档微调，名实相符。
- 问题：无明显问题

#### `6c778fb` feat: add clipboard copy functionality for User/Room IDs and fix room list filtering
- 改动：MessagePage 增加点击复制 User/Room ID（navigator.clipboard）；服务端 `register` 改为只下发该用户创建的房间。
- 评审：服务端改动实质是修掉初始版把全部房间（即全部访问凭证）泄露给任意客户端的问题，价值大于标题所示；剪贴板带成功提示。
- 问题：[低] `navigator.clipboard` 仅在 HTTPS/localhost 可用，失败只 console.error 无用户提示；commit 把 UI 功能与服务端安全修复混在一起，粒度偏粗。

#### `57aad04` fix: update URL parameters on room leave and enhance search parameter handling
- 改动：clearRoomUrlParam 从手写 `window.history.pushState` 改用 react-router 的 setSearchParams，并在离开房间时清除 `?room=` 参数。
- 评审：修复离开房间后刷新/导航再次弹出"加入房间"确认框的真实 bug，改法与 react-router 状态保持一致，正确。
- 问题：无明显问题

#### `3803d8c` fix: update socket.io-client to version 4.8.1 and add type definitions
- 改动：升级 socket.io-client 至 4.8.1，新增 `@types/socket.io-client` 并把返回类型改成 `typeof Socket`。
- 评审：方向错了：socket.io-client v4 自带类型，`@types/socket.io-client` 是 v1.x 时代的过期类型包，引入后才被迫用 `typeof Socket` 这种别扭写法。
- 问题：[低] 引入过期 DefinitelyTyped 包与 v4 自带类型冲突，类型质量倒退；标题说 "fix" 实际无运行时缺陷被修复。

#### `ba4e1b6` fix: 1. update create_room websocket endpoint and post api/rooms to require roomData.name 2.update get('api/messages') to require only roomId and return messages of that room
- 改动：create_room/POST api/rooms 强制要求 roomData.name；GET /api/messages 改名为 /api/room_messages，只需 roomId 即返回整房消息。
- 评审：补上 name 校验是对的；消息接口从"仅创建者可读自己消息"放宽为"凭 roomId 任意读"，与 WS join_room 的凭证模型一致，算有意的对齐。
- 问题：[低] README 表格仍写 `/api/messages`，与新端点 `/api/room_messages` 不符；POST /api/rooms 请求体结构破坏性变更（pre-release 可接受）。

#### `317538c` feat: add TypeScript configuration and update package scripts for TypeScript support; enhance README for clarity and detail
- 改动：server.js 整体迁移为 server.ts，同时重构存储：消息改按房间分 key（`room:{id}:messages`）、新增 `user:{clientId}:rooms` 索引，HTTP API 全部 RESTful 化（`/api/rooms/:roomId/messages` 等），join_room 增加房间存在性校验。
- 评审：实质是"TS 迁移 + 存储模型重构 + API 重设计"三合一，修复了初始版 O(总消息数) 的读取问题，是关键演进；但 commit message 只提 TypeScript 配置，严重低估改动范围，粒度过粗。
- 问题：[中] tsconfig `outDir: dist` 后编译产物在 `server/dist/`，`__dirname + '../client-heroui/dist'` 解析为 `server/client-heroui/dist`，`npm start` 跑编译产物时静态托管路径错误（2a14e96 修复）；[低] 又引入 `@types/redis`、`@types/socket.io` 两个对 v4 无效的过期类型包；[低] readRoomsByUser 中 set 与 hash 可能不一致时 `JSON.parse(room!)` 产生 null 元素。

#### `2a14e96` feat: add image messages and user identity features
- 改动：图片消息 v1（contentEditable 混合编辑器、base64 直传直存）、用户名/头像随消息携带、房间成员计数与 join/leave 广播、socket 重连配置与断线重发、修正编译产物静态路径为 `../../client-heroui/dist`。
- 评审：一次塞入 5 个特性（message 自己都列了 5 条），粒度过粗；功能面完整但多处实现有硬伤。顺带修复了 317538c 的 dist 静态路径问题。
- 问题：[高] 图片以 base64 经 socket.io 发送，而服务端 maxHttpBufferSize 默认 1MB，>约 750KB 的图片会直接被断开连接，主打特性对常见照片不可用（130c338/91197fa 修复）；[中] base64 图片永久存进 Redis list，内存膨胀；[中] `roomMembers` 为单实例内存态且按 clientId 去重，多标签页同用户一关即整体计为离开，计数不准，后续多实例部署后更失真；[中] `handleSubmit` 先调 `parseEditorContent()`（异步 setState）随即读旧 `contentItems`，存在丢最后输入的竞态；[中] 编辑器把每个 DIV/文本节点拆成独立消息逐条发送，多行文本被拆成多条消息（097e155 修复，本 commit 引入）；[低] username/avatar 完全由客户端自报，可冒充任意昵称。

#### `04b4418` fix: enhance image message handling and improve styling for message display
- 改动：MessageItem 将图片消息从文本气泡 Card 中拆出，单独无气泡样式并限制 max-h-300px。
- 评审：紧跟上一 commit 的样式补丁，合理；遗留 `${isMine ? '' : ''}` 无意义三元表达式。
- 问题：无明显问题（仅 [低] 死代码三元）。

#### `cfc6f6a` feat: implement unique room ID generation using nanoid instead of uuidv4 and improve collision handling
- 改动：房间 ID 改用 nanoid 10 位（62 字母表），创建时 hExists 碰撞检测重试 5 次，失败退化为 12 位；HTTP 创建房间请求体又改回平铺结构。
- 评审：短 ID 利于分享，碰撞处理对 ~59.5 bit 熵纯属心理安慰但无害；客户端显示也适配了短 ID。
- 问题：[低] nanoid v5 仅发 ESM，CommonJS 编译产物 `require('nanoid')` 只有在支持 require(ESM) 的较新 Node 上才能跑，平台兼容性踩线；[低] POST /api/clients/:clientId/rooms 请求体结构与 ba4e1b6 定的 `{roomData}` 又不一致，API 形状反复横跳；[低] 房间 ID 即访问凭证，熵从 UUID 122 bit 降到 ~59.5 bit（在线猜测仍不可行，可接受）。

#### `40f4365` feat: comment out unused imports and temporarily disable member event display in MessagePage
- 改动：注释掉 react-icons 引入与成员加入/离开提示 UI。
- 评审：实为 chore/disable 而非 feat；用注释而非删除留下死代码（与"要删就删干净"的惯例相悖）。
- 问题：[低] 死代码以注释形式滞留。

#### `676bc47` feat(UI): update layout and enhance mobile experience
- 改动：删除独立 LanguageSwitcher 组件并入 Dropdown 菜单、tab 文案精简、加 aria-hidden；MessagePage 大面积 Prettier 重排（单引号→双引号、折行）。
- 评审：664 行 diff 中绝大部分是格式化噪声，真实逻辑改动很小，格式化应与功能改动分开提交以便回溯。
- 问题：[低] 格式化与功能混提，diff 可读性差。

#### `61d1116` feat: implement dynamic viewport height handling and improve layout responsiveness
- 改动：监听 resize/orientationchange 用 JS 维护视口高度，替代 h-screen，解决移动端地址栏/键盘把输入框顶出屏幕的问题；viewport meta 加 user-scalable=no。
- 评审：思路是当时主流做法（visualViewport 之外的兜底），但同样的高度逻辑在 App.tsx 和 MessagePage 各写一份，双层 height 容器冗余。
- 问题：[低] `user-scalable=no, maximum-scale=1` 禁用缩放损害可访问性；[低] 视口高度逻辑重复两份。

#### `3d10e7a` feat: add copy icon next to room ID in MessagePage for improved user experience
- 改动：房间 ID 旁加一个 copy 图标，单行改动。
- 评审：微小 UI 增量，名实相符。
- 问题：无明显问题

#### `ab0d3ed` feat: persist room and tab state
- 改动：用 localStorage 持久化当前房间与 tab 视图，挂载时校验房间仍存在后自动恢复并 rejoin；用 isInitialMount ref 防止首渲染误清存储。
- 评审：恢复流程考虑了 URL 参数优先、房间已删除清理、视图联动，思路完整；依赖 socket.io 的 emit 缓冲在未连接时也能工作。
- 问题：[低] commit message 写的 key 名（roomtalk_last_room_id/last_view）与代码实际（roomtalk_current_room/current_view）不符；[低] getRoomById 无超时，服务端不回调时 isLoadingRoom 永久卡 true。

#### `097e155` fix(message): fix multi-line message split issue with enter key 修复(消息): 修复带回车的消息被错误拆分为多条的问题
- 改动：handleSubmit 改为把相邻文本项用 `\n` 合并，仅以图片为分隔点拆分发送。
- 评审：修复 2a14e96 引入的多行消息被拆条问题，逻辑正确、范围克制。
- 问题：[低] 仍未解决 handleSubmit 读取 stale `contentItems` 的竞态（见 2a14e96）；合并后文本与图片仍是多条独立消息，无原子性（可接受的产品取舍）。

#### `09be082` feat(UI): enhance MessageItem component with Markdown support and improve layout styling
- 改动：新增 MarkdownContent 组件：markdown-to-jsx 渲染 + KaTeX 公式（自写 $/$$ 解析为 MathBlock/MathInline 标签）+ react-syntax-highlighter 代码块带复制按钮；文本消息全部走 Markdown。
- 评审：功能丰富，但安全与依赖管理粗糙：聊天消息是不可信输入，渲染管线却未做一致的信任设计。
- 问题：[中] `katex.render` 开了 `trust: true`，KaTeX 文档明确该选项允许 `\href{javascript:...}` 之类受信命令，恶意消息可构造点击执行 JS 的 XSS（e811f66 重构渲染时此配置仍延续，需后续批次确认现状）；[低] 同时引入 react-markdown+rehype-sanitize+remark-gfm 却只用 markdown-to-jsx，sanitizer 装而不用，三个依赖为死依赖；[低] 每个消息实例向 document.head 注入一份相同 <style>，百条消息即百个重复节点；[低] 底部 Like/Dislike/Refresh/Edit 按钮全是空 onClick 的占位 UI。

#### `7d78ea9` feat(i18n): add translation support for tooltip texts in MarkdownContent component
- 改动：MarkdownContent 五个 tooltip 文案接入 i18n，新增对应词条。
- 评审：小步 i18n 补全，名实相符。
- 问题：无明显问题

#### `ace755a` feat(UI): update color for messageitem and markdowncontent
- 改动：调整气泡、行内代码、katex-error 等颜色为新配色。
- 评审：纯样式微调；用硬编码 hex/gray-* 而非 HeroUI 语义色，主题一致性走弱，但属审美选择。
- 问题：无明显问题

#### `c34fb5b` feat(UI): update MessageItem component layout and add new translations for like actions
- 改动：MarkdownContent 大幅重写：CodeBlock/入口组件 memo 化、useMemo 缓存解析结果、新增 ContentActionButtons（本地 like/dislike 状态）；附带加了 3 个图标包。
- 评审：memo 化对长消息列表是正确优化；但 like/dislike 仅是组件本地状态，不上服务器也不持久化，属装饰性功能。
- 问题：[低] `@heroicons/react`、`heroicons`、`@tabler/icons-react` 三个包加进 package.json 却无任何 import（iconify 字符串 "tabler:*" 不需要它们），纯死依赖；[低] commit message 说 MessageItem layout，实际主体是 MarkdownContent 重写，名实不符。

#### `4c902a4` feat(i18n): add accessibility labels and improve aria attributes for better screen reader support
- 改动：为输入框、各 icon-only 按钮补 aria-label/role/title，新增 messageInput 词条。
- 评审：实打实的可访问性补全，方向正确；顺手改了一处 katex 边距与标题不符但影响极小。
- 问题：无明显问题

#### `bbb53e0` feat(UI): refactor CodeBlock component layout and improve styling for better usability
- 改动：CodeBlock 布局层级简化与样式调整，移除内层滚动容器。
- 评审：纯样式重构，无逻辑变化。
- 问题：无明显问题

#### `4c6165c` feat(logging): implement Winston logger with daily rotation and add log directory structure
- 改动：新增 src/logger.ts（Winston + daily-rotate，error/combined 两路文件，HTTP 中间件按状态码分级），server.ts 迁入 src/ 并全面替换 console.log；顺带塞入一个 k6 loadtest.js。
- 评审：日志结构（按模块 Logger、图片内容截断）设计得当；但 Console transport 被注释掉、只写本地文件，与下一个 commit 的 Fly 部署组合后 `fly logs` 看不到任何输出且容器重启日志即丢。
- 问题：[中] 仅文件日志、无 stdout 输出，容器化部署下日志不可见且随实例销毁丢失（很久之后才由 1a4f9bc 修复）；[低] loadtest.js 与日志主题无关且本身写错（URL 里 `:clientId` 字面量未替换、用裸 ws+JSON 协议打 socket.io 端点，跑不通）；[低] `@types/winston` 是过期 stub 还装进 dependencies。

#### `16b9ff5` feat(deploy): add Fly.io deployment and multi-instance support docs: update project documentation
- 改动：上线基建：Dockerfile（node:22-alpine 单阶段，前后端同镜像构建）、fly.toml（auto_stop、min=0）、GitHub Actions 自动部署；接入 @socket.io/redis-adapter，把 socket↔clientId、socket↔rooms、房间成员集合全部迁到 Redis 以支持多实例；CORS 改读 CLIENT_URL。
- 评审：从单机玩具到可水平扩展部署的关键一步，会话状态 Redis 化方向正确；但运维细节多处欠考虑。
- 问题：[中] workflow 触发分支写死 `main` 而仓库实际用 `master`，自动部署从未触发（后续 5b85fe1 修复，批次 2）；[中] `room:{id}:members`、`socket:clients`、`socket:rooms` 永不过期，实例被 Fly auto_stop/崩溃时 disconnect 清理不会执行，脏会话与虚高成员数在 Redis 永久累积；[低] 静态路径再改为 `../../../client-heroui/dist`，仅匹配 Docker 内布局，本地编译运行又错位（路径随部署形态反复横跳，应改用 env/绝对根）；[低] 单阶段镜像携带全部源码与前端 node_modules，体积浪费。

#### `28238e3` feat(docs): update README with system architecture and Redis Persistence
- 改动：README 双语补架构图与 Redis 持久化说明；server.ts 仅加 4 行注释。
- 评审：纯文档，名实相符。
- 问题：无明显问题

#### `f1d81d9` fix(docs): update Dockerfile to use Node.js 22-alpine
- 改动：仅 DeploymentGuide.md 里示例 Dockerfile 的基镜像版本号 18→22。
- 评审：文档与实际 Dockerfile 对齐的一行修订；标题说 "update Dockerfile" 实为更新文档中的示例，易误读。
- 问题：无明显问题

#### `91197fa` feat(MessageInput): enhance image handling with compression and preview support
- 改动：接入 browser-image-compression（maxSizeMB:2、WebWorker），编辑器内改用 blob 预览 URL + WeakMap 关联原始 File，发送时才压缩转 base64；预压缩上限放宽到 10MB。
- 评审：把"贴进编辑器即整段 base64 进 DOM"改为轻量预览、延迟压缩，方向正确，并部分缓解 2a14e96 的超限断连问题（与 130c338 配合后闭环）。
- 问题：[中] import 了 browser-image-compression 却没改 package.json，本 commit 处于编译不过/构建失败状态（a0f6b93 补上）；[中] 把 .env.development 的 VITE_SOCKET_URL 改成生产地址，本地开发默认直连线上环境；[低] handleSubmit 只发送带 file 的图片项，无 File 关联的图片（如 HTML 粘贴）被静默丢弃。

#### `130c338` feat(server): configure Socket.IO with custom buffer size and ping settings
- 改动：Socket.IO 服务端 maxHttpBufferSize 提至 5MB，pingTimeout 60s/pingInterval 25s。
- 评审：修复 2a14e96 引入的"图片超 1MB 默认缓冲即断连"问题，与客户端 2MB 压缩上限（base64 后约 2.7MB）匹配；ping 参数对移动端弱网合理。
- 问题：无明显问题

#### `d0c6113` feat(MessageItem): support additional image MIME types and update image source handling feat(fly.toml): increase max HTTP request body size to 10MB fix(socket): enforce WebSocket transport and disable automatic upgrade chore(package): add sharp for image processing
- 改动：服务端新增 start/chunk/finish 三段式图片分块上传协议，sharp 转无损 WebP 后以裸 base64+mimeType 存储；客户端 MessageItem 给图片 src 统一加 `data:...;base64,` 前缀；socket 强制 websocket-only（适配多实例无粘性会话）；fly.toml 加请求体上限；server 加 sharp 依赖。
- 评审：一个 commit 干四件事（标题自己都拼了四段），粒度严重过粗；分块上传协议本身无任何防护。
- 问题：[高] MessageItem 无条件给 content 加 data: 前缀，而当时客户端 send_message 发的图片 content 本就是完整 data URL，双重前缀导致所有新发图片与历史图片全部渲染失败，直到 e811f66 才修（被本 commit 引入）；[高] imageUploadSessions 的 totalChunks/单块大小/总量均无上限、会话无超时，恶意客户端可无限堆 Buffer 造成内存 DoS；且 `Buffer.concat(session.chunks)` 在 try 外，稀疏分块（只发最后一块凑 length）会抛异常进 async 处理器形成 unhandled rejection，可使进程崩溃；[中] sharp 写入 package.json 但 lockfile 未更新，`npm ci`（含 Docker 构建）从此失败直至 42ce237；[低] 无损 WebP 对照片通常比原 JPEG 更大且 CPU 开销高，"压缩"目标存疑；[低] fly.toml 的 `[http] max_request_body_size` 疑似非有效配置键（未验证）。

#### `a0f6b93` feat(dependencies): add browser-image-compression package for enhanced image handling
- 改动：client package.json/lock 补上 browser-image-compression ^2.0.2。
- 评审：本质是给 91197fa 补漏的修复（依赖忘提交），却以 feat 呈现；应当与 91197fa 同一 commit。
- 问题：[低] 名实不符（fix 写成 feat），暴露 91197fa 后构建断档。

#### `5269253` feat(server): enhance image upload events with optional username and avatar support
- 改动：分块上传 start/finish 事件透传可选 username/avatar，落到生成的图片消息上。
- 评审：补齐分块上传消息与普通消息的字段对齐，小而合理；但 username 取自 finish 的 payload 而非 start 时的会话，同一上传两处可不一致（无实害）。
- 问题：无明显问题

#### `9788d78` Merge branch 'master' of github.com:Skymore/roomtalk
- 改动：merge commit，仅引入 a0f6b93 的依赖变更，无冲突解决的实质改动。
- 评审：常规同步合并。
- 问题：无明显问题

#### `42ce237` fix: add sharp in package-lock.json
- 改动：server/package-lock.json 补录 sharp 及其平台二进制依赖树。
- 评审：修复 d0c6113 遗漏 lockfile 导致的 `npm ci` 失败（Docker 构建断档约半天）；说明提交前没本地跑过 npm install/构建验证。
- 问题：无明显问题（本身即补救）。

#### `4ab3472` fix(server): 添加类型注解，增强代码可读性
- 改动：给若干回调参数补显式类型注解（err: Error、socket: Socket 等），8 处。
- 评审：纯类型注解整理；这些参数本可由泛型推断，多数注解冗余但无害；"fix" 前缀名实不符（无缺陷被修）。
- 问题：无明显问题

#### `e811f66` feat: 增强图片处理，重构markdown渲染。
- 改动：MessageItem 对 content 是否以 `data:` 开头做分支，修复 d0c6113 的双重前缀；MarkdownContent 整体重写（mermaid 图表渲染、明暗主题跟随、CodeBlock 简化）；package.json 加 mermaid/highlight.js/remark-math/rehype-katex/rehype-highlight/remark-breaks 等；main.tsx 注释掉 React.StrictMode。
- 评审：图片显示修复是关键（修复被 d0c6113 引入的全量图片渲染故障）；markdown 重写仍基于 markdown-to-jsx，KaTeX `trust: true` 的 XSS 面原样保留。
- 问题：[中] 新加的 react-markdown(降级到 9)/remark-*/rehype-* 全家桶依旧一个都没用上，无用依赖进一步膨胀；[中] 注释掉 StrictMode 是回避双挂载副作用问题的 workaround，掩盖 effect 不幂等的真因；[低] mermaid 渲染走 innerHTML 注入 SVG（默认 securityLevel=strict 有消毒，风险可控）；[低] 大量 console.log 调试残留；[低] removeSeparators 会把用户消息里合法的 `---` 水平线整行删掉，悄悄改写内容。

#### `e171699` refactor: remove unused React import and reduce memory allocation in Fly configuration
- 改动：删 main.tsx 未用的 React import；Fly VM 内存 1GB→256MB。
- 评审：两件不相干的小事合一提交；降内存是成本优化，但与服务端 sharp 无损 WebP + 多 MB base64 Buffer 的图片管线相冲突。
- 问题：[中] 256MB 内存配合 sharp 处理大图（分块上传无大小上限）极易 OOM 重启，缺乏依据的激进降配。

---

## 批次 2：v1.0 重构与多模型接入（27 commits，`76c669b` → `5abad60`）

**批次小结**：本批 27 个 commit 横跨两个阶段：2025-09 的 v1.0 AI 助手首发（76c669b/32bd7e7 两个 2.5k+ 行 mega commit，流式管线能跑但埋下历史覆盖丢数据、消息级零鉴权、无频控三大结构性隐患），与 2026-05 的密集重构周（RoomTalk 设计系统、5 语言 i18n 工具链、e10f4a0/204a683 server+client 模块化拆分并补 2k+ 行测试、OpenRouter→DeepSeek/Anthropic 官方 API 多 provider 接入与成本核算）。后期工程质量显著提升（纯函数拆分、fake Redis 测试、AST lint），但 manualChunks TDZ 四连修（17ff0e0→823f344→69f6925→9cbd4cd 净产出为零）与 Fly CI 三连修暴露"不在本地验证、靠线上报错驱动迭代"的交付习惯；个别 commit message 名实不符（026bbea）。批末 saveMessageHistory 覆盖竞态与 edit/delete 无鉴权仍未解决。

**重点问题**：
- `32bd7e7` [高] AI 流结束以截断到 40 条的上下文 DEL+RPUSH 覆盖整个房间历史，旧消息与流式期间并发新消息永久丢失
- `32bd7e7` [高] `edit_message`/`delete_message` 无作者/房间成员鉴权，任何注册客户端可篡改、删除任意房间任意消息（本批结束仍未修）
- `76c669b` [中] `ask_ai` 无频控且不校验房间成员身份，可对任意 roomId 刷 OpenAI 调用（成本滥用面）
- `76c669b` [中] 硬编码 temperature 0.7 与默认 `OPENAI_MODEL=gpt-5` 不兼容，默认配置即报错（b33da66 修复）
- `e10f4a0` [中] refactor 名义下静默修改历史保存语义；DEL+RPUSH 竞态与无鉴权原样迁移保留
- `204a683` [中] `useRoomMessageEvents` effect 依赖过宽，打开编辑/删除弹窗即清空消息并重拉（流式抖动部分由 adbc107 修复）
- `17ff0e0` [中] 拍脑袋 manualChunks 引发生产 TDZ/useLayoutEffect 连环故障，经 823f344/69f6925/9cbd4cd 三步全量回退
- `3eed7f3` [中] Opus 4.7 定价写错 3 倍（9c039d3 修复）；cache_control 仅标 system 块，"99%+ cache hits"言过其实
- `edb44e7` [中] SelectItem 缺 `textValue` 致触发器显示异常，且把客户端正确定价覆盖为错误值（均由 9c039d3 修复）
- `026bbea` [中] message 声称"restore single-origin CORS"实际仅加一个尾逗号，名实不符且 `'*'`+credentials 隐患仍在
- `cb24306` [中] `~google/gemini-pro-latest` 模型 ID 带可疑 `~` 前缀，疑似笔误致该选项不可用
- `00d1b01` [低] `deleteRoom` 吞异常后仍回调成功，删除失败静默化

#### `76c669b` feat: add streaming AI assistant and refresh RoomTalk UI
- 改动：v1.0 大提交（约 2.8k 行）：服务端集成 OpenAI 流式 chat completions（`ask_ai`/`ai_chunk`/`ai_stream_end`/`ai_stream_error` 事件、取最近 20 条文本消息做上下文）；客户端拆出 AppHeader/BottomNav/ChatHeader/AIRoleManager/RoomJoinModal/SettingsView 等组件，MessageList 增加流式渲染；新增 `.env.example`，监听改 `0.0.0.0`。
- 评审：流式管线设计合理（先广播空消息再推 chunk，结束后才落 Redis）；API key 走环境变量未泄漏。但一个 commit 同时塞进 AI 特性、整站 UI 重构、i18n、文档与品牌，粒度过大，难以回溯。
- 问题：[中] `ask_ai` 无任何频控，且不校验请求者是否在该房间内，任何注册客户端可对任意 roomId 触发 OpenAI 调用（成本滥用/跨房间刷消息）。[中] 硬编码 `temperature: 0.7` 与 `.env.example` 默认 `OPENAI_MODEL=gpt-5` 不兼容，默认配置下 AI 请求直接报错——被后续 `b33da66` 修复。[低] 流式消息在结束前不落库，中途加入的用户看不到正在生成的消息、崩溃即丢失；最终消息用流结束时刻覆盖 timestamp，与客户端看到的顺序有漂移。[低] `fullContent.length % 100 === 0` 的日志条件几乎不会命中，属无效节流。

#### `a395d23` docs: optimize README structure and add v1.0 tech stack updates
- 改动：仅中英 README 重组：按版本组织特性、合并重复配置段、补 OpenAI SDK 技术栈。
- 评审：纯文档提交，粒度恰当，message 名实相符。
- 问题：无明显问题

#### `3623e58` Merge pull request #1 from Skymore/dev
- 改动：将 dev 分支（76c669b+a395d23）合入 master 的 merge commit。
- 评审：`git show` 无 diff --cc，merge 结果与第二父完全一致，干净合并，无夹带改动。
- 问题：无明显问题

#### `b33da66` fix(server): Adjust AI assistant temperature to 1 for GPT-5 series models
- 改动：`ask_ai` 的 `temperature` 由 0.7 硬编码改为 1。
- 评审：修复 76c669b 引入的默认配置即报错问题（GPT-5 系列仅支持 temperature=1）。更稳妥的做法是按模型条件设置或干脆省略该参数，现在换 `gpt-3.5-turbo` 等旧模型就失去采样温度调节。
- 问题：[低] 一刀切 temperature=1 对所有模型生效，丢失可配置性；修复方式治标。

#### `32bd7e7` feat: comprehensive message management and enhanced chat experience
- 改动：又一个 2.5k 行 mega commit：消息编辑/删除/重试、房间删除（creatorId 权限）、AI 改为纯历史上下文驱动（支持 vision 图片）、`appendMessage`+`saveMessageHistory` 持久化模式、resizable panels、Hindi i18n。
- 评审：delete_room 权限检查正确；retry/edit 截断上下文的思路合理。但持久化改造引入严重数据丢失模式，且消息级操作完全没有鉴权。message 后半段自夸（"robust error handling"）与实际不符。
- 问题：[高] AI 流结束后 `saveMessageHistory(roomId, [...contextMessages, finalAiMessage])` 用 `DEL`+`RPUSH` 以"被截断到 40 条的上下文"整体覆盖房间历史——超过 40 条的旧消息被永久删除；流式期间他人新发的消息（已 `appendMessage`）也会在覆盖时丢失（竞态）。[高] `edit_message`/`delete_message` 不校验请求者是否消息作者或房间成员，注释明言"移除限制，允许编辑所有类型的消息（包括AI消息）"——任何注册客户端可篡改/删除任意房间任意消息。[中] `saveMessageHistory` 的 read-modify-write 无任何原子性（无 MULTI/锁），并发编辑/删除互相覆盖。[低] 图片消息以完整 base64 进入 OpenAI 上下文，token 成本不可控；MessageList 卸载时不再 `socket.off`（注释称由下次 setup 清理），unmount 后监听器泄漏。

#### `a9ff175` feat(ui): add RoomTalk design foundation
- 改动：新增 DESIGN.md 设计系统文档与暖色调（paper/ivory/terracotta）品牌色板，HeroUI light/dark 主题 token、圆角规范；App.tsx 改用 `visualViewport`+CSS 变量 `--app-height` 处理移动端视口。
- 评审：粒度恰当、名实相符。视口高度从 React state 改为 CSS 变量避免了每次 resize 触发整树重渲染，且 visualViewport 能正确响应移动端软键盘，是实质改进。
- 问题：无明显问题

#### `4f2464f` feat(i18n): add multilingual translation layer
- 改动：i18n 扩到 5 语言（en/zh/hi/ja/ko），新增 `languages.ts`、AI 批量翻译脚本 `translate-i18n.mjs`（OpenAI/OpenRouter 可选）与键一致性校验脚本 `check-i18n-keys.mjs`；各组件硬编码文案换成 `t()`。
- 评审：工具链思路好——用校验脚本防翻译键漂移；API key 全部走环境变量/.env，未入库。机器翻译质量未经人工校对直接入库是常见取舍。
- 问题：[低] 翻译脚本默认模型写死 `google/gemini-3-flash-preview` 等具体型号，模型下线时脚本静默失效；机翻文案无人工复核流程。

#### `07e8943` fix(ui): improve room surfaces and dark contrast
- 改动：7 个组件的纯样式调整（+204/-197），统一房间卡片表面色与暗色对比度，落实 a9ff175 的设计 token。
- 评审：纯样式 commit，与前两个提交同一工作区按主题拆分提交（间隔不到 1 分钟），拆分习惯良好。
- 问题：无明显问题

#### `7002532` feat(ai): add OpenRouter model costs
- 改动：内置模型目录改走 OpenRouter（GPT-5.5/Claude Sonnet 4.6/DeepSeek/Kimi/GLM/MiniMax + legacy GPT-5 系列），带每百万 token 单价；`stream_options.include_usage` 取真实用量、估算兜底（chars/4，图按 1000 token）；`incrByFloat` 原子累计房间成本；顺带修 IME Enter 误发送（isComposing/keyCode 229 三重判断）。
- 评审：实现质量明显高于前期：`normalizeAIModel` 只允许目录内模型，客户端传任意模型会回落默认，杜绝了"点名昂贵模型"的滥用面；成本计算区分 cached input。IME 修复正确。
- 问题：[中] 单价为硬编码快照，上游调价后成本统计静默失真，且无来源注释/更新机制。[低] IME 修复与"model costs"主题无关，混入同一 commit（message 有提及）。[低] 32bd7e7 的历史覆盖问题在此仍未修复，cost 字段也随被截断历史一同丢失。

#### `5b85fe1` ci: deploy master to Fly
- 改动：Fly 部署 workflow 重写：deploy 前先构建 server+client、按 ref 并发组、部署前用 `flyctl secrets list | grep` 校验 OPENROUTER_API_KEY 存在；顺带删掉服务端 `OPENAI_MODEL`/`OPENAI_MODEL_OPTIONS` env 回退。
- 评审：部署前验证 runtime secret 的思路好（防止上线即 500）。但 grep 表格输出的校验方式脆弱——立刻被 0ddb7ec 重写；server.ts 的 env 清理与 CI 主题无关。
- 问题：[低] secret 检查依赖 flyctl 表格输出格式，紧接着就坏了（见 0ddb7ec）；混入 server env 行为变更，commit 主题不纯。

#### `4df5bba` ci: trigger Fly deployment
- 改动：空 commit，仅用于触发 CI。
- 评审：用空提交触发部署是 push-loop 调试 CI 的信号；workflow_dispatch 才是正解。
- 问题：[低] 空提交污染历史，说明 workflow 缺手动触发入口。

#### `0ddb7ec` ci: make Fly secret check robust
- 改动：secret 校验改为 `flyctl secrets list --json | grep '"name": "OPENROUTER_API_KEY"'`。
- 评审：修复 5b85fe1 引入的脆弱检查（5b85fe1→4df5bba→0ddb7ec 三连反映 CI 全靠线上试错）。grep JSON 字符串仍依赖输出缩进格式，jq 才算真正 robust。
- 问题：[低] 名为 robust 实仍是文本匹配 JSON，格式变化照样误报。

#### `cb24306` fix(ui): add more OpenRouter models
- 改动：服务端目录与客户端 fallback 同步新增 Grok 4.3、Tencent Hy3 free、`~google/gemini-pro-latest` 三个模型；顺带统一 Tooltip/Select 弹层样式。
- 评审：模型目录在 client/server 两处重复维护，已现漂移风险；type 用 `fix(ui)` 但实质是 feat（加模型）+样式，名实不符。
- 问题：[中] `~google/gemini-pro-latest` 的 `~` 前缀疑似笔误，作为 apiModel 直发 OpenRouter 大概率 404（不确定 OpenRouter 是否支持该前缀语法，但其余模型均无此前缀）。[低] 双份目录无单一事实来源；commit type 标错。

#### `0dda8f9` fix(i18n): localize date formatting
- 改动：`formatters.ts` 弃用硬编码 `zh-CN`/中文星期，按当前语言映射 locale 走 `Intl.DateTimeFormat`/`RelativeTimeFormat`；`check-i18n-keys.mjs` 增加基于 TS AST 的硬编码文案与 `toLocale*` 调用检测。
- 评审：实现规范，无效日期返回空串、按自然日界计算 diffDay 都考虑到了；用编译器 API 写 lint 防回归，工程素养好。
- 问题：[低] 自然日差用固定 86,400,000ms 计算，跨 DST 边界会偏差一档（如"昨天"算成"今天"）；lint 脚本 103 行混入"date formatting"主题，粒度略宽。

#### `e10f4a0` refactor(server): split runtime modules and add coverage
- 改动：把 1600 行 server.ts 拆为 repositories（RedisStore 类）/services（aiModels 注册表、aiHistory、messageDomain、imageUploadSessions）/socket（room/message/media/ai handlers）/routes，并补约 1.1k 行单测。
- 评审：拆分边界合理（纯函数 domain 与 IO 分离，便于测试），测试覆盖核心选择逻辑，是本批质量最高的提交之一。但它在"refactor"名义下静默改了语义：AI 完成后保存 `buildFinalAIHistory(historyUsedForContext,…)`（完整历史）而非 32bd7e7 的 `contextMessages`（截断到 40 条），等于偷偷修了"40 条外历史被覆盖丢失"的高危 bug，却未在 message 中声明。
- 问题：[中] refactor 提交夹带行为修复（历史覆盖范围变更），破坏"重构不改行为"的可审计性。[中] 32bd7e7 的两个根本问题仍在：`saveMessageHistory` 的 DEL+RPUSH 覆盖式写入在 AI 流期间仍会吞掉并发新消息；`edit_message`/`delete_message` 依旧无作者/成员鉴权（迁移时原样保留）。

#### `204a683` refactor(client): extract chat modules and add coverage
- 改动：客户端对称重构：抽出 ChatRoomView/RoomCard/RoomCreateModal 等组件、useRoomMessageEvents/useAIModelSelection/useAIRoles hooks，以及十余个纯函数 util（messageState/roomState/imageInput/keyboardComposition…）并配套测试。
- 评审：质量好：socket 监听改为"具名 handler + 按引用 off"，修复了此前全局 `socket.off` 与 unmount 泄漏；所有事件加 roomId 过滤、`upsertMessage` 去重、scroll timer 统一清理、reconnect 时重拉历史。
- 问题：[中] `useRoomMessageEvents` 的 effect 依赖含 `messageToDeleteId`/`messageToEditId` 与多个回调，任一变化（如打开删除/编辑弹窗）都会整体 teardown→`updateMessages([])`→重新 `get_room_messages`，造成消息闪空与多余请求；流式期间触发还会打断渲染——后续 `adbc107` 正是来收拾流式更新不稳的。[低] console.log 调试输出全保留。

#### `17ff0e0` chore(client): add quality tooling and split bundles
- 改动：新增 ESLint（react-hooks 规则设为 error）+ vitest；vite 加函数式 `manualChunks`，把 react/heroui/icons/markdown/socket.io/mermaid 等拆成 9 个 vendor chunk。
- 评审：质量工具链部分没问题；但按包名硬切 chunk 极易制造跨 chunk 循环依赖与初始化顺序问题，是后续 TDZ 报错连环修复（823f344→69f6925→9cbd4cd）的根源。
- 问题：[中] 引入的 manualChunks 策略在生产构建触发 TDZ 运行时错误（被 823f344/69f6925/9cbd4cd 渐次修复），且 elkjs/d3/dagre/cytoscape/mermaid 等规则对应的依赖项目里根本没有，属拍脑袋配置。[低] chunkSizeWarningLimit 提到 1500 掩盖包体问题。

#### `3eed7f3` feat(server): route DeepSeek and Anthropic through official APIs with prompt caching
- 改动：新增 `@anthropic-ai/sdk` 与 DeepSeek 官方端点，`getAIClientForModel` 改返回带 provider 标签的 wrapper；Anthropic 走 `messages.stream`（system 块加 `cache_control: ephemeral`），`buildAnthropicMessages` 处理 base64 图片；usage 归一化兼容 `cache_read/creation_input_tokens`；附 testCacheHit.ts 实测脚本。
- 评审：多 provider 抽象干净，缺 key 时 fail-fast；用脚本实测缓存命中率而非拍脑袋，值得肯定。但 commit message 的"99%+ cache hits"与实现不符：`cache_control` 只标在 system 块上，缓存前缀只覆盖 system prompt，会话历史每轮全价重算（除非依赖隐式缓存行为，未验证）。
- 问题：[中] Opus 4.7 定价写成 $15/$75 per M，后续 `9c039d3` 改为 $5/$25——上线期间成本展示虚高 3 倍。[低] `buildAnthropicMessages` 不保证首条为 user 且未合并连续同角色消息，聊天室场景（多用户连发/检索到以 assistant 开头）可能触发 Anthropic API 的角色约束报错（API 当前是否仍严格要求轮替未验证）。[低] `max_tokens: 8096` 疑为 8192 笔误；`.claude/settings.local.json` 这类本地工具配置不应入库；客户端光标修复混入服务端 feat。

#### `edb44e7` feat(client): show provider badge and premium gem after model name in selector
- 改动：模型选择器在名称后渲染 provider 徽章与 premium 宝石图标；客户端 fallback 目录同步 3eed7f3 的官方 API 路由与定价。
- 评审：UI 改动本身合理，但把 SelectItem children 从纯文本换成复合 JSX 而未提供 `textValue`，导致触发器显示异常——被 9c039d3 修复。另把客户端原本正确的 Opus 4.7 定价（$5/$25）改成服务端的错误值（$15/$75），错误反向传播。
- 问题：[中] 缺 `textValue` 的 SelectItem 回归（9c039d3 修复）；[中] 将正确定价覆盖为错误定价（同被 9c039d3 改回）。

#### `823f344` fix(client): merge socket.io into vendor chunk to fix TDZ init error
- 改动：删除 vendor-socket 手动 chunk 规则并入 vendor；顺带固定 dev `port: 3011`。
- 评审：TDZ 连环修复第一刀，只移除当下报错的那条规则，未审视整个 manualChunks 策略（被 17ff0e0 引入）；同一问题随后在其他 chunk 复发。
- 问题：[低] 头痛医头：保留的其余 chunk 规则同样有循环依赖风险，2 小时后即由 69f6925/9cbd4cd 继续拆除；dev port 改动与主题无关。

#### `026bbea` fix(ui): remove button nesting in RoomCard; restore single-origin CORS
- 改动：RoomCard 去掉 `isPressable/onPress` 改为 `as="div"`+`onClick` 修复嵌套 button 告警；server.ts 仅加了一个尾逗号。
- 评审：commit message 后半句"restore single-origin CORS"与 diff 不符——CORS 配置实质零变化（仍是 `origin: CLIENT_URL || '*'` 且 `credentials: true`），名实严重不符。RoomCard 用 onClick 替代 press 丢失键盘可达性，后续 5abad60 修复。
- 问题：[中] message 声称的 CORS 改动不存在，误导历史审计；且现状 `'*'`+credentials 组合本身不可用/不安全（未设 CLIENT_URL 时）。[低] 可访问性回退（5abad60 修复）。

#### `69f6925` fix(build): remove all risky manual chunks to prevent TDZ errors
- 改动：删除 mermaid/d3/markdown 等"高风险"chunk 规则，保留 react/ui/icons 三组。
- 评审：TDZ 第二刀，仍是渐进回退而非一次定论；删除的 elk/d3/dagre 规则本来就匹配不到任何依赖。缩进还留了个错位的 `return "vendor"`。
- 问题：[低] 保留的 vendor-react/vendor-ui 拆分正是 useLayoutEffect 报错来源，数小时后 9cbd4cd 全删。

#### `9cbd4cd` fix(build): remove all manualChunks to fix TDZ and useLayoutEffect init errors
- 改动：整个 `rollupOptions.manualChunks` 连同辅助函数全部删除，回到 Vite 默认分包。
- 评审：TDZ 终局：17ff0e0→823f344→69f6925→9cbd4cd 四连击后净产出为零、纯历史噪音。这串修复反映两点：分包优化没有先在生产构建验证就上线；每次只删一点靠线上报错驱动迭代。最终"放弃手动分包"反而是正确决定。
- 问题：无明显问题（本身是正确的止血）；[低] `chunkSizeWarningLimit: 1500` 残留无意义。

#### `9c039d3` fix(pricing): correct Claude Opus 4.7 to $5/$25/M; fix SelectItem textValue for trigger display
- 改动：client+server 两处 Opus 4.7 定价 $15/$75→$5/$25；SelectItem 补 `textValue`。
- 评审：两个小修复都对症（分别收拾 3eed7f3 与 edb44e7 留下的回归），3 行改动干净利落；两件事并入一个 commit 但标题如实列明，可接受。
- 问题：无明显问题

#### `00d1b01` fix(server): harden room deletion and cache usage
- 改动：`generateUniqueRoomId` 的 12 位回退 ID 也做碰撞检测（再不行升 16 位）；`deleteRoom` 包 try/catch；`normalizeUsage` 兼容 DeepSeek 的 `prompt_cache_hit_tokens` 字段；`max_tokens` 提为常量。各处补测试。
- 评审：碰撞回退补检与 DeepSeek 字段兼容都是实打实的修复，测试用 fake Redis 类构造碰撞/失败场景，写法到位。
- 问题：[低] `deleteRoom` 吞掉异常后调用方仍回调 success，删除失败对用户呈现为成功（静默失败比抛错更糟）；`DEFAULT_ANTHROPIC_MAX_TOKENS = 8096` 仍保留疑似 8192 的笔误。

#### `adbc107` fix(client): stabilize message streaming updates
- 改动：流式更新不再每个 chunk 调 `sortMessages`（仅 history 载入时排序）；scroll 定时器去抖为单 timer；自我消息判定从 `socket.id` 改为应用层 `clientId`；usage/cost 合并 `||`→`??`；清理 console.log。
- 评审：对症修复 204a683 引入的流式抖动：每 chunk 全量重排序既浪费又会因占位消息时间戳在流中被重排导致跳动；`socket.id` 与注册用 clientId 本就不是一回事，自己发消息不强制滚动的 bug 一并修掉。配套测试齐全。
- 问题：无明显问题

#### `5abad60` fix(client): make room cards pressable
- 改动：RoomCard 恢复 `isPressable`+`onPress`（撤销 026bbea 的 `as="div"`+onClick），新增 jsdom 测试覆盖卡片按压与内部操作按钮不冒泡。
- 评审：修回 026bbea 丢失的键盘可达性，并首次为组件交互补了回归测试，方向正确。
- 问题：[低] 026bbea 当初移除 isPressable 正是为了消除嵌套 button 告警；此处恢复 isPressable 而内部操作按钮未见调整，嵌套问题可能复现（取决于 HeroUI 渲染方式，未验证；批次 3 的 f9b1515/c4692c7 显示该问题后来确实再次反复）。

---

## 批次 3：E2E 测试与 Postgres 持久化（25 commits，`74b2690` → `c4692c7`）

**批次小结**：本批从零搭起 Playwright E2E 体系（计划 → harness → 用例），随后完成桌面侧栏布局与 `lastActivityAt` 排序，再以三个紧凑的 feature commit 落地 Postgres 持久化（store 抽象 + 事务化 PostgresStore）、Redis 短 TTL 消息缓存与幂等迁移脚本，并配套 runbook、覆盖计划、contract/迁移/大数据量/多客户端/smoke 等多层测试，最后用真实 Postgres E2E 暴露并修复了"消息未落库就发起 AI 请求"的竞态（86377a2），又以原子化定点操作根治 edit/delete/truncate 的读改写竞态（840a274）。整体工程质量高：参数化 SQL 无注入、事务 + 行锁、fail-closed 启动、错误路径有测试、文档诚实记录未验证项；演进脉络清晰，"暴露问题 → 根因修复 → 补测试"的闭环执行得很好。主要瑕疵是多个 `test:` 标题的 commit 夹带生产行为变更、parity 测试跑在手写 fake 上而非真实引擎、以及迁移 runbook 缺少写冻结与"切换后禁止重跑"的警示。

**重点问题**：
- `48dafbf` [中] `failInterruptedStreamingMessages` 在每个实例启动时全局把 streaming 消息标为 error，多实例部署下会误杀其他实例正在进行的流式响应
- `a0b8679` [中] cache-aside 回填与并发写存在经典竞态，可能把陈旧历史写回缓存达 TTL 30s，AI 读上下文可能缺最新消息（86377a2 仅部分缓解）
- `8e3d78f` [中] runbook 无迁移→cutover 间的写冻结步骤，且未警示 cutover 后重跑迁移会用陈旧 Redis 历史覆盖 Postgres 新数据（saveMessageHistory 为整体替换语义）
- `d969a31` [中] "parity" contract 测试跑在手写 MemoryRedis/StatefulPostgresPool fake 上（`script.includes`/正则匹配 SQL），真实 Lua/SQL 语义并未被执行验证
- `f9b1515` [中] RoomCard 从 HeroUI Card 退化为 `div role="button"` 内嵌 Button 的嵌套交互结构（a11y/语义回归），后续 `c4692c7` 修复
- `840a274` [低] "fix" 标题夹带 `rename_room` 全新特性；`1919bc3`/`4861002`/`b2d1210` 等 test 标题 commit 同样夹带生产代码变更，污染历史语义

#### `74b2690` test(e2e): document user flow coverage plan
- 改动：新增 172 行 E2E 规划文档：四阶段（harness、核心房间/消息流、AI/媒体/分享流、CI 集成）、验收标准与 commit 计划。
- 评审：目标明确（"UI 看着对但用户走不通"的回归），强调隔离 Redis DB、fake AI、不依赖真实 key，与后续三个 commit 实际交付吻合。
- 问题：无明显问题。

#### `eab9097` test(e2e): add playwright harness
- 改动：新增 playwright.config.ts（双 webServer 自动起前后端、Redis DB15 隔离、桌面+移动双 project）、`/api/e2e/reset`、aiHandlers 内 60 行 fake AI 流式分支、组件补 testid/aria-label、vitest 排除 e2e。
- 评审：harness 设计完整，fake AI 受 `E2E_TEST_MODE && E2E_FAKE_AI` 双开关守卫且复用真实 cost/save 路径，验证面真实。MessageInput 顺手修了 `getRangeAt(0)` 在 rangeCount=0 时的崩溃，属夹带 bugfix。
- 问题：[低] `/api/e2e/reset` 是无鉴权的 `flushDb` 端点，仅靠环境变量守卫，若生产误配 `E2E_TEST_MODE=true` 即暴露破坏性接口；[低] fake AI 大段测试逻辑内嵌生产 handler，膨胀可读性。

#### `d9f9ade` test(e2e): cover user operation chains
- 改动：新增 4 个 spec + helpers（396 行）：房间卡片/创建/按 ID 加入、消息发/编/删/清、premium 双确认、fake AI 流式与 metadata、retry 不重复、edit-and-ask、图片上传、分享链接、移动端核心链路。
- 评审：断言均为用户可见结果（dialog、计数、cache hit 文案），用 API 播种 + reset 隔离，确实能拦住"点击不跳转/事件不更新 UI"类回归。
- 问题：[低] 断言硬编码英文文案与 fake AI 字符串，i18n 文案改动会连带改测试；属可接受的取舍。

#### `dbe9e7b` ci: use node24 github actions
- 改动：fly-deploy workflow 的 `actions/checkout`、`actions/setup-node` 从 v4 升 v5。
- 评审：v5 actions 运行时为 Node 24，标题尚算名实相符；项目自身 node-version 仍为 22，无行为风险。
- 问题：无明显问题。

#### `6c91a45` style(markdown): tune code colors
- 改动：提取代码块 frame/header/copy/body 与行内 code 的 class 常量并调整明暗配色；index.css 将 `code` 移出强制继承色规则。
- 评审：CSS 调整与组件改动配套正确（不移出 `!important` 继承则新色不生效），mermaid 与普通代码块统一复用常量，重复消除合理。
- 问题：无明显问题。

#### `818c05c` feat(ui): add desktop sidebar layout
- 改动：新增 662 行 DesktopSidebar（折叠、创建/加入、房间列表、语言/主题），MessagePage 接入并按 `lastActivityAt` 排序；服务端 Room 增加 `lastActivityAt`，append/saveHistory 返回更新后 Room 并向 creator 发 `room_updated`；ChatRoomView 移除 react-resizable-panels。
- 评审：标题是 UI，实际含跨端数据模型变更（`lastActivityAt` 协议字段 + 各 handler 广播），message 低估了范围。客户端排序与 `room_updated` 合并逻辑有单测；侧栏与 RoomList 存在创建/加入逻辑重复，`i18n: any` 类型偷懒。
- 问题：[中] RedisStore 此时 `rPush` + get→set 更新 lastActivity 是两步非原子，且 `appendMessage` 失败后 messageHandlers 仍无条件广播 `new_message`（幽灵消息），均被本批 `48dafbf` 修复；[低] lastActivityAt 无条件覆盖可倒退，后续 `d969a31` 改 GREATEST。

#### `48dafbf` feat: add postgres durable persistence
- 改动：核心架构 commit：新增 `DurableRoomStore`/`RealtimeRoomStore`/`CompositeRoomStore` 抽象、PostgresStore（事务 + `FOR UPDATE` 行锁 + position 唯一索引 + ON CONFLICT upsert）、schema/pool、Redis 三个 Lua 脚本保证房间校验与写消息原子化；AI 流程改为 placeholder/final `upsertMessage` 定点持久化（不再整段重写历史），错误态带重试与 `ai_persistence_error`；启动 fail-closed（infra ready 才 listen），含 `failInterruptedStreamingMessages` 启动恢复；附 ~1000 行测试。
- 评审：设计与执行均属高水准：SQL 全参数化无注入；行锁使 `MAX(position)+1` 无竞态；AI 改 upsert 修复了"流式期间他人消息被最终 save 覆盖"的旧缺陷；持久化失败不再广播幽灵消息。`PERSISTENCE_STORE` 开关 + Composite 组合让回滚是纯配置操作，rollout 策略稳妥。
- 问题：[中] 启动恢复对全库 streaming 消息一刀切标 error，多实例（项目本身用 Redis adapter 支持多实例）下会误伤其他实例的在途流；[中] `saveMessageHistory` 为 DELETE + 循环逐条 INSERT，编辑/删除路径上大房间 O(N) 往返且持有行锁（后续 `840a274` 改定点操作）；[低] retry/edit 截断仍是"读历史→整体重写"，窗口内并发新消息会丢（`840a274` 修复）；[低] 客户端尚未监听 `ai_persistence_error`，事件暂为死信。

#### `a0b8679` feat: add redis message cache
- 改动：Postgres 模式下以 Redis 作 30s TTL 的 room message cache：`CompositeRoomStore` 读路径 cache-aside、写路径成功后失效；`scanIterator` 批量全量失效，降级 `KEYS`；缓存任意失败不阻塞 durable 读写。
- 评审：职责切分干净（缓存逻辑全在 Composite 层，`ignoreCacheFailure` 包裹），TTL 可配置、≤0 禁用。失效时机正确（写成功才失效）。
- 问题：[中] cache-aside 固有竞态：durable 读取快照 → 并发写 invalidate → 读方再回填陈旧快照，最长 30s 内 `readMessagesByRoom`（含 AI 取上下文）可能读不到最新消息；后续 `86377a2` 通过持久化 ACK 串行化"发消息→问 AI"主链路，但跨客户端窗口仍在，靠 TTL 兜底。[低] `ROOM_MESSAGES_CACHE_TTL_SECONDS` 配非法值时静默禁用缓存而非回退默认值。

#### `f179373` feat: add redis to postgres migration
- 改动：新增 `migrateRedisToPostgres` 脚本：dry-run、逐房间 saveRoom + 整体覆盖式 saveMessageHistory + `setRoomAICostTotal` 精确赋值，逐房间失败隔离、统计输出、失败 exit 1；PostgresStore 增 `setRoomAICostTotal` 与 `pool.end`。
- 评审：幂等设计正确（upsert + 替换 + 赋值而非累加），source/target 接口化便于测试，main 守卫 `DATABASE_URL`。坏 JSON 房间跳过并告警，稳健。
- 问题：[中] 纯离线迁移，无双写/增量能力：迁移期间老部署继续写 Redis 的消息会在 cutover 时丢失（窗口取决于操作流程，见 `8e3d78f`）；[低] 同一 message id 出现在两房间时全局 PK upsert 会"搬移"消息，uuid 下概率可忽略。

#### `8e3d78f` docs: add postgres rollout runbook
- 改动：新增 121 行 rollout runbook（preflight/dry-run/迁移/cutover/验证/回滚/清理窗口），更新 README 双语与 `.env.example`。
- 评审：步骤具体可执行，回滚是纯配置且强调保留 Redis 数据，质量好。
- 问题：[中] 缺两点关键警示：迁移与 cutover 之间无"停写/维护窗口"步骤（窗口内 Redis 新消息丢失）；幂等性描述会诱导"切换后可随时重跑"，而 cutover 后重跑会用陈旧 Redis 历史整体覆盖 Postgres 新数据。

#### `c480560` chore: raise fly memory for postgres
- 改动：fly.toml 内存 256mb→512mb。
- 评审：pg 连接池 + 缓存路径带来的内存增长，调整合理，单行明确。
- 问题：无明显问题。

#### `aced733` docs: add postgres test coverage plan
- 改动：新增 828 行中文文档：迁移开发复盘 + 六阶段测试覆盖计划（contract parity、Upstash 10MB 回归、大数据量、PG 模式 E2E、多客户端、smoke）。
- 评审：缺口分析以真实风险驱动（线上暴露的 Upstash 限制、模式漂移），每阶段有验收标准与建议 commit，后续 commit 基本逐项兑现。
- 问题：无明显问题。

#### `d969a31` test(server): add durable store parity coverage
- 改动：新增 609 行 storeContract 共享测试套件，同一组断言跑 RedisStore 与 PostgresStore；顺带把两个 store 的 append 路径 `lastActivityAt` 改为 GREATEST 语义（修掉时间可倒退）。
- 评审：契约共享的思路对（防双实现语义漂移），GREATEST 修复是真实正确性改进且两端同步。
- 问题：[中] 套件跑在手写 fake 上：MemoryRedis 用 `script.includes(...)` 识别并以 TS 重新实现 Lua 语义，StatefulPostgresPool 正则解析 SQL——真实 Lua/SQL 不被执行，fake 与生产脚本漂移时测试照样绿；真实引擎验证延迟到 smoke/PG E2E。[低] "test" commit 夹带生产行为变更。

#### `1919bc3` test(server): strengthen redis postgres migration coverage
- 改动：迁移 source 增加 Upstash 10MB 防御：`lRange(0,-1)` 失败时降级逐 `lIndex` 读取；测试覆盖 105 条消息顺序一致、二次迁移幂等、fallback 也失败时记 `read_room_data` 失败。
- 评审：测试断言到 id/content 全序一致，符合计划中"不能只 mock happy path"的要求，质量好。
- 问题：[低] 又一个 test 标题夹带生产 fallback 逻辑；[低] `lIndex` 逐条读在 Redis 侧是 O(N) 寻址，整体 O(N²)，超大房间迁移会很慢（一次性脚本可接受）。

#### `4861002` test(server): cover large histories and persistence failures
- 改动：edit/delete 持久化失败改为 fail-closed（回调报错、不广播）；新增大历史 API 测试（120×2KB，断言全序与 >200KB 基线并写入 test-results 工件）、saveRoom 失败不广播、clear 抛错不广播等失败路径测试。
- 评审：失败路径测试真实有效（断言"未广播"而非仅"未崩溃"）；fail-closed 与 `48dafbf` 的 append 语义对齐。
- 问题：[低] 标题为 test 但改变了 edit/delete 的对外错误契约；[低] 单测写磁盘基线文件并断言绝对字节数，略偏 benchmark 化、有轻微脆性。

#### `7c18406` test(e2e): add postgres mode user flow coverage
- 改动：新增 `playwright.postgres.config.ts`（强制 `E2E_DATABASE_URL` 且库名须含独立 test/e2e token、shellQuote 注入防护）、`E2E_RESET_ON_START` 启动重置、PG 模式 spec：跨 reload/新 context 持久化、cache miss 回填、AI/图片/分享链路。
- 评审：数据库名 token 守卫 + URL 协议校验 + `E2E_TEST_MODE` 双层防护，对"破坏性测试打到真实库"的防御做得认真；用 `expectPostgresMode` 先验证模式避免静默跑错后端。
- 问题：[低] 两份 playwright config 大量重复（端口、env、webServer），后续易漂移。

#### `b2d1210` test(e2e): cover multi-client realtime flows
- 改动：新增双 context 实时同步 spec（成员数、发/编/删/清、AI 流式、late joiner）；协议修复：`ai_stream_end` 携带完整 `content`，客户端 `completeAIMessage` 用其覆盖，修复迟加入者错过 chunk 后内容残缺；fake AI chunk 延迟可配。
- 评审：late-joiner 测试设计巧妙（先填 ID、流开始后再点 Join），真实复现了 chunk 丢失场景；`content` 兜底是正确的协议级修复且有单测。
- 问题：[低] 实质性的协议变更（事件 payload 扩字段 + 客户端语义）藏在 test 标题下，应拆为独立 fix commit。

#### `4dfa749` test: add persistence mode smoke coverage
- 改动：新增 319 行 `persistenceSmoke.ts`：拉起真实 server 子进程，验证 Redis 正向、PG 正向（有安全测试库时）、切回 Redis、PG 不可达时 fail-closed（非零退出且不监听）；Redis 仅允许本地、PG 库名 token 守卫。
- 评审：fail-closed 断言（先 exit 再确认端口不可达）正是 `48dafbf` 启动门控的回归保障，补上了"模式切换只有 runbook 没有自动化"的缺口。
- 问题：[低] URL 安全校验逻辑已是第三份拷贝（playwright.postgres.config、smoke、reset 端点各自为政）；[低] 12s/20s 固定超时在慢机器上可能误报。

#### `0c43e67` docs: record postgres test coverage completion
- 改动：在覆盖计划与复盘文档记录阶段完成状态、commit 清单与本地验收矩阵（103/103 等），明确标注 PG 正向 smoke/E2E 因无测试库尚未执行。
- 评审：诚实记录未验证项而非宣称全绿，文档与实际 commit 一一对应，可信度高。
- 问题：无明显问题。

#### `86377a2` fix: coordinate message persistence before ai requests
- 改动：`send_message`/`ask_ai` 增加持久化 ACK 回调；客户端 `emitWithAck`（连接等待 + 断线/超时防护），`handleAskAI` 改为 await 消息落库 ACK 后才发 `ask_ai`，发送循环逐条 await；e2e `seedClient` 改为仅新 clientId 时清状态、`sendTextMessage` 等待按钮 loading 结束。
- 评审：这是真实 PG E2E 暴露的竞态（Postgres 落库慢于 Redis 时 AI 读到空 prompt）的协议级根治：服务端在 durable 写成功后才 ACK，客户端以 ACK 为序。`emitWithAck` 的 settle/cleanup 状态机写得严谨；server 端 ask_ai 在 placeholder 落库后即 ACK，语义清晰。回调均为可选参数，旧客户端兼容。
- 问题：[低] 多图/混合消息发送由并发变串行，发送延迟随条数线性增长（换取顺序与可靠性，合理取舍）；[低] 跨客户端的缓存陈旧窗口（见 `a0b8679`）并未由本修复消除，只是主链路被串行化。

#### `a859d6f` docs: record local postgres validation
- 改动：记录用本机临时 PostgreSQL 17 集群补齐 PG 正向 smoke 与 E2E（3/3），含 initdb/pg_ctl 复现命令；记录真实 PG E2E 暴露的两个 bug 及修复方式。
- 评审：与 `86377a2` 的实际改动完全对应，"真实环境测试发现 mock 测不出的竞态"这条经验记录得很有价值。
- 问题：无明显问题。

#### `840a274` fix: harden durable message persistence
- 改动：为两个 store 新增原子定点操作：`updateMessageContent`/`deleteMessageById`/`truncateBefore(After)Message`/`updateMessageAndTruncateAfter`（Postgres 事务 + 行锁，Redis 单条 Lua）及 `updateRoomName`；edit/delete handler 弃用"读全史→内存改→整体重写"；新增 `edit_message_and_ask_ai` 事件合并编辑+截断+AI，截断后广播 `message_history` 让全员重同步；新增 `rename_room`（creator 鉴权 + 20 字符校验）；storeContract/aiHandlers/roomHandlers 测试同步扩展。
- 评审：本批最重要的正确性修复——彻底消除 edit/delete/retry 路径上"并发新消息被整体重写吞掉"的竞态，且 Redis/Postgres 两端语义对齐、有共享契约断言；`rename_room` 鉴权先查 creator 再 UPDATE 双重校验。Postgres 截断按 position、Redis 按列表序，语义一致。
- 问题：[中] 名实不符：`rename_room` 是全新特性（服务于 `f9b1515` 的 UI），却混入"fix: harden persistence"，且与 f9b1515 形成跨 commit 的隐式依赖；[低] Redis `updateRoomName` 仍是 get→set 非原子，与 Lua 路径并发时可能丢一次 lastActivity 更新；[低] `truncateBeforeMessage` 用 `>=`（含目标本身）的命名易误读；[低] cjson 重编码消息可能改变 cost 浮点的文本精度（%.14g），实际无害。

#### `9ecf227` docs: outline code agent sandbox plan
- 改动：新增 401 行 Code Agent 沙盒方案草稿：E2B 沙盒 + 工具调用（bash/读写文件），房间双模式、沙盒生命周期、流式工具结果展示、分阶段实施。
- 评审：作为产品+技术草稿结构完整、对标明确（E2B/Claude managed agents），与本批主题无关但纯文档无风险；E2B 150ms 冷启动等外部数据未经仓内验证，文内日期（05-08）与提交日（05-16）不一致。
- 问题：无明显问题（草稿性质）。

#### `f9b1515` feat: refine room management UI
- 改动：新增 RoomRenameModal（校验 + ACK 式 `renameRoom`）、RoomCard/侧栏/ChatHeader 加重命名入口、保存房间 unsave、桌面端 saved 视图重定向到 rooms、MessageList 的 edit-and-ask 改走原子 `edit_message_and_ask_ai`、retry 失败回退刷新历史、`getRoomById` 加超时防护；扩展 room-flows/mobile e2e。
- 评审：客户端正确消费 `840a274` 的新协议（依赖顺序对）；rename 三处状态（rooms/currentRoom/savedRooms）同步更新，错误经 Modal 内显示而非 alert，交互完整。
- 问题：[中] 为塞进操作按钮把 RoomCard/SavedRoomList 从 HeroUI `Card isPressable` 改成 `div role="button"` 内嵌真实 `<button>`，形成嵌套交互控件（a11y violation、键盘焦点混乱），后续 `c4692c7` 修复；[低] `setSavedRooms(prev.map(...))` 只更新 state 未回写 localStorage，刷新后 rename 在保存列表中可能回退旧名。

#### `c4692c7` fix: restore room cards to heroui card
- 改动：RoomCard/SavedRoomList 恢复为 HeroUI `Card` 外壳：可点选区域收敛为内部单个 `<button>`，操作按钮以兄弟节点放在按钮外，事件改 `onPress` 并删掉 stopPropagation 补丁。
- 评审：正确修复 `f9b1515` 引入的嵌套交互结构——选卡与操作按钮不再互为祖先，stopPropagation 类 hack 自然消失，结构更干净；测试同步更新。
- 问题：[低] 测试用 `className).toContain('rounded-lg')` 断言样式实现细节，脆性高、保护价值低。

---

## 批次 4：移动端与回复/AI speaker（26 commits，`c09f4bd` → `4b8059b`）

**批次小结**：本批 26 个 commit（2026-05-16 至 06-01）覆盖四条主线：移动端 composer/键盘 viewport 修复系列、消息回复+AI speaker 上下文、Gemini 接入（新模型、价格制 premium、AI 生成角色）、进房 UX 与乐观发送。键盘 viewport 是贯穿性痛点，经历四次方向翻转：cf6b027 压缩 `--app-height`→df42bbc 补 `offsetTop`→cd96e8c 推翻为"冻结高度+keyboard-inset overlay"→4b8059b 两小时后整体回滚回 dvh 方案并以消息窗口化（80 条）治本，说明该问题域缺少真机回归手段、靠生产试错收敛，但 41a6d3e 的中文复盘文档是难得的沉淀。功能类 commit（回复、Gemini 角色生成、乐观发送）分层清晰、测试纪律好（02cd7cf 一次带 ~800 行测试），总体实现质量高于工程流程质量。最大流程问题是 dev/master 双分支工作流制造了 4 对内容相同的重复提交（a0ce183/445ec72、e8c008f/af4b2b8、dd294b8/ca96841、7a9d30d/e0e5782）与成对 merge，直至 9a8a4c6 才对齐，历史可读性受损。

**重点问题**：
- `cf6b027` [中] 只写 visualViewport height 不处理 offsetTop，iOS 键盘平移场景仍错位（df42bbc 补救）。
- `a0ce183` [中] 回复校验用 `readMessagesByRoom` 整房拉取（含 base64 图）只为 find 一条消息，O(N) 重 IO。
- `e8c008f` [中] 环境变量配置的未知模型无 pricing 时 `isPremiumAIModel` 恒 false，昂贵模型绕过二次确认，默认方向选反。
- `dd294b8` [中] `/api/ai-role-draft` 无鉴权无限流，每次调用烧真实 OpenRouter 费用，可被刷。
- `a7da0cd` [中] 乐观恢复路径 `get_room_messages` 先于 `join_room`，间隙内广播的消息静默丢失。
- `02cd7cf` [中] `send_message_and_ask_ai` 的 ack 把"消息已保存"与"AI 启动失败"混为一个 success 位，已持久化的消息会被客户端标为发送失败。
- `4b8059b` [中] 回滚 cd96e8c 全部 viewport 方案+新增窗口化混在一个 commit，message 未提回滚，可追溯性差。

#### `c09f4bd` feat: compact chat composer controls
- 改动：重构 composer 布局，把 `MessageInputAIControls`（角色/模型选择、Ask AI、发送按钮）从输入框下方移入框内同一行，按钮改为圆形紧凑样式；新增 `ModelPriceGrid` 在模型下拉项里展示 IN/CACHE/OUT 三栏价格。
- 评审：纯前端 UI 重组，props 原样传递无逻辑变化；`formatPriceRate` 对非有限数返回 "—"，边界处理得当；移动端用 `hidden sm:inline` 隐藏按钮文字，思路合理。
- 问题：[低] 角色/模型 Select 用 `flex-[0.9]`/`flex-[1.25]` 硬分配宽度，窄屏（<360px）上一行 6 个控件容易挤压截断——这正是下一个 commit 立刻要修的，说明本次提交前缺少小屏验证。

#### `936b2fe` fix: improve mobile composer controls
- 改动：对上一 commit 的小屏跟进：控件在 <640px 降为 32px 圆钮、调整 flex 比例与字号；新增 `matchMedia('(max-width:640px)')` hook 切换下拉 popover 位置与 AI 设置 Modal（移动端改 bottom-sheet）；AIRoleManager 列表项加 truncate/min-w-0 防溢出。
- 评审：与 c09f4bd 间隔仅 18 分钟，属于"先提交再补移动端"的修补；matchMedia 监听有正确清理；Tailwind 断点 (sm:640px) 与 JS matchMedia 阈值保持一致，避免了样式/行为分叉。
- 问题：[低] `query.addEventListener('change', ...)` 在 iOS Safari <14 不存在（需 `addListener` 回退），对老设备会抛错；考虑到目标用户面窄，风险有限。

#### `cf6b027` Fix mobile keyboard viewport layout
- 改动：键盘 viewport 系列第一弹：viewport meta 加 `viewport-fit=cover, interactive-widget=resizes-content`；把 App.tsx 内联的 `--app-height` 逻辑抽成 `utils/appViewport.ts`（rAF 合并更新、去掉 visualViewport `scroll` 监听）并配 96 行 vitest；`body`/`#root` 改 `position:fixed; inset:0`；输入区移动端字号升为 `text-base`（16px）。
- 评审：方向正确——16px 防 iOS 聚焦自动缩放、`interactive-widget=resizes-content` 让 Android Chrome 108+ 直接 resize 布局、rAF 防抖、`100vh→100dvh→var(--app-height)` 三级回退都规范，且带单测（含 scroll 事件忽略的显式用例）。
- 问题：[中] 刻意忽略 visualViewport `scroll` 事件并只写 height、不处理 `offsetTop`：iOS 键盘弹出时 visual viewport 相对 layout viewport 有偏移，`position:fixed` 的应用根仍钉在 layout 顶部，会被键盘"顶出"可视区——这正是 16 天后 df42bbc 要补的洞，说明本次只在 Android 语义下验证过。

#### `ab50128` Merge pull request #3 from Skymore/codex/mobile-keyboard-viewport-fix
- 改动：把 cf6b027 合入主线（父：936b2fe + cf6b027）。
- 评审：纯 merge，combined diff 为空，无冲突解决改动。
- 问题：无明显问题。

#### `526d188` Merge pull request #4 from Skymore/codex/mobile-keyboard-viewport-fix
- 改动：与 ab50128 完全相同父提交（936b2fe + cf6b027）的再次 merge，间隔仅 6 秒，对应 dev/master 双分支各开一个 PR。
- 评审：无冲突改动；同一分支开两个 PR 分别合入两条主线，是双分支工作流造成的历史噪音。
- 问题：[低] 重复 merge 使历史出现两个等价合并节点，后续 `git log --first-parent` 追溯易混淆。

#### `df42bbc` Fix mobile keyboard viewport offset
- 改动：补 cf6b027 的洞：新增 `--app-viewport-top`（取 `visualViewport.offsetTop`），`.app-shell` 改 `position:fixed; top:var(--app-viewport-top)` 跟随视口平移；重新挂回 cf6b027 刚删掉的 `scroll` 监听（仅更新 top），并引入 'all'/'top' 两级 rAF 合并调度。
- 评审：正确命中 iOS 键盘把 visual viewport 相对 layout viewport 上推的根因；调度合并逻辑写得严谨，测试同步从"忽略 scroll"改为"scroll 只更新 top 不动 height"。22 分钟内对同一监听器先删后加、测试断言反转，典型的"无真机回归、靠线上试错"的迭代方式。
- 问题：[低] `offsetTop` 在 pinch-zoom 下也非零且随手势连续变化，shell 以 rAF 周期追赶会有一帧延迟的抖动；scroll 高频触发下每次 cancel+re-request rAF 略浪费但无碍。

#### `6c86f77` Merge pull request #5 from Skymore/codex/mobile-keyboard-offset-fix
- 改动：把 df42bbc 合入主线。
- 评审：纯 merge，无冲突解决改动。
- 问题：无明显问题。

#### `41a6d3e` docs: record iOS keyboard viewport fix
- 改动：新增 157 行中文复盘文档 `docs/mobile-keyboard-viewport-fix.zh.md`，记录两轮键盘修复的现象、layout/visual viewport 根因、事件→更新矩阵和 PR 时间线。
- 评审：质量很高的事后复盘：明确承认第一轮（PR#4）漏掉 `offsetTop` 导致真机仍复现，事件处理表与代码实现一一对应；把试错沉淀成文档，是对反复修复的正面回应。
- 问题：无明显问题。

#### `ea58f0b` Merge pull request #6 from Skymore/codex/mobile-keyboard-viewport-doc
- 改动：合入 41a6d3e 文档。
- 评审：纯 merge，无冲突解决改动。
- 问题：无明显问题。

#### `a0ce183` Add message replies and AI speaker context
- 改动：全栈引入消息回复：`Message.replyTo`（messageId/username/messageType/preview 快照）贯穿类型、Postgres（`reply_to JSONB` + 幂等迁移）、socket `send_message`（带 `replyToMessageId`，服务端查原消息生成 `createReplyReference`）与 UI（回复按钮、composer 引用条、气泡内引用块）；同时给 AI 上下文注入 `[Sender: xxx]`/`[Replying to ...]` 行，使 AI 能区分多人发言；顺带 `normalizeDisplayName` 统一清洗用户名（控制符→空格、截 48 字符）。
- 评审：设计成熟：preview 用服务端快照而非外键关联，被引消息后续删改不影响展示且无悬挂引用；`buildAIProviderMessages` 把图片消息从纯 image 数组改为 text+image 块并相应把过滤器 `every`→`some`，配套正确；server/client/store 三层都补了测试。多 provider 注入逻辑统一收口在 `formatHumanContextForAI`，收敛得好。
- 问题：[中] `messageHandlers` 校验引用时 `store.readMessagesByRoom(roomId)` 整房拉取（含 base64 图片内容）只为 find 一条 id，大房间下每次回复都是 O(N) 重 IO，应有按 id 单查接口。[低] 用户名/preview 直接拼进 `[Sender: ...]` 提示行，`]`、换行虽被清洗但仍可构造伪装，提示注入面未完全封死。

#### `445ec72` Add message replies and AI speaker context
- 改动：与 a0ce183 同补丁的重复提交（同一 AuthorDate、--stat 完全一致，1 分钟后提交到另一分支基底）；树差异仅为基底缺 df42bbc+41a6d3e，补丁本身一致。
- 评审：dev/master 双分支工作流的历史噪音（见批次小结）。
- 问题：无。

#### `2e8bbeb` Merge pull request #8 from Skymore/codex/message-replies-ai-speakers-dev
- 改动：把 445ec72 合入 dev 线。
- 评审：纯 merge，combined diff 为空，无冲突解决改动。
- 问题：无明显问题。

#### `d754531` Merge pull request #7 from Skymore/codex/message-replies-ai-speakers
- 改动：把 a0ce183 合入 master 线，与 2e8bbeb 为同一特性在两条主线的成对 merge。
- 评审：纯 merge，无冲突解决改动。
- 问题：无明显问题。

#### `e8c008f` Add Gemini 3.5 Flash and price-based premium models
- 改动：目录新增 `google/gemini-3.5-flash`（OpenRouter）；premium 判定从"模型名含 gpt/claude/gemini 等关键词"改为价格规则 `outputPerMillion > $10`，删除散落的 `isPremium: true` 硬编码；Tencent Hy3 从 `:free` 改为付费定价。
- 评审：用客观价格阈值替换脆弱的名称启发式是正确方向（旧规则会把任何带 "gemini" 字样的廉价模型误判为 premium），client/server 双端同步并更新测试。
- 问题：[中] 服务端 `createConfiguredOpenRouterModel` 不再带 pricing 也不再算 isPremium，环境变量配置的未知模型 `pricing` 为空 → `(pricing?.outputPerMillion ?? 0) > 10` 恒为 false，昂贵模型会绕过二次确认——未知定价默认"非 premium"方向选反了，按成本控制初衷应默认保守。

#### `af4b2b8` Add Gemini 3.5 Flash and price-based premium models
- 改动：与 e8c008f 同补丁的重复提交（同 AuthorDate、--stat 一致，54 秒后提交到 dev 基底）。
- 评审：双分支历史噪音。
- 问题：无。

#### `dd294b8` Add Gemini-assisted AI role creation
- 改动：新增"AI 帮我创建角色"：服务端 `aiRoleGenerator.ts` 用 Gemini 3.5 Flash（OpenRouter，`response_format: json_object`）由用户 idea 生成 `{name, systemPrompt}`，REST 端点 `POST /api/ai-role-draft`（idea 非空且 ≤2000 校验，失败 502）；客户端 AIRoleManager 加 "Create with AI" Modal，生成结果回填手动表单。
- 评审：分层干净（generator 纯函数化、route 只做校验、client 只管 UX），`parseAIRoleDraft` 对 LLM 输出做了 JSON/类型/截断三重防御，双端长度上限一致，生成中禁止关 Modal 防竞态，三层都有测试。
- 问题：[中] `/api/ai-role-draft` 无鉴权也无限流，每次调用都产生真实 OpenRouter 费用，可被脚本刷爆账单。[低] `completions.create({...} as any)` 绕过类型检查；上游调用无超时控制，OpenRouter 挂起会长时间占住 HTTP 请求。

#### `ca96841` Add Gemini-assisted AI role creation
- 改动：与 dd294b8 同补丁的重复提交（同 AuthorDate、--stat 一致，21 秒后提交到 master 基底）。
- 评审：双分支历史噪音。
- 问题：无。

#### `7a9d30d` Center empty room views
- 改动：MessagePage 的 rooms/saved 两个视图容器补 `w-full`，使空房间列表的空态内容能水平居中。
- 评审：两行 class 修补，粒度恰当；flex 父容器下子 div 不自动撑满宽度，加 `w-full` 是对症的。
- 问题：无明显问题。

#### `e0e5782` Center empty room views
- 改动：与 7a9d30d 同补丁的重复提交（同 AuthorDate、同 --stat）。
- 评审：双分支历史噪音。
- 问题：无。

#### `a7da0cd` Optimize chat room entry UX
- 改动：进房 UX 三合一：(1) 列表点击改传完整 `Room` 对象（`onRoomSelect(room)`），免去 `getRoomById` 往返即时进房；(2) localStorage 恢复改为乐观：先 `setCurrentRoom(storedRoom)` 渲染房间壳，后台验证，`pendingRestoreRoomIdRef` 防过期回调覆盖手动选择；(3) 服务端 `join_room` 不再推送 `message_history`/`ai_cost_total`（客户端本就拉取，消除双份大 payload）；另把 composer 改为绝对定位悬浮，列表 `bottomPaddingPx` 由 ResizeObserver 动态供给。
- 评审：去掉 join 时的重复历史推送是实打实的带宽优化（base64 图片历史很重），配套测试同步更新；`pendingRestoreRoomIdRef` 的过期守卫把乐观恢复的竞态处理得干净。
- 问题：[中] 乐观恢复路径事件顺序反转：chat 视图先挂载即发 `get_room_messages`，`joinRoom` 要等 `getRoomById` 返回后才发，两者之间房间里广播的新消息既不在拉到的历史里、socket 又尚未入房，会静默丢失直到重连或重进（正常点击路径无此问题）。[低] 验证完成前用户已可发消息，自己看不到回显；commit 把"进房优化"与 composer 悬浮重构捆在一起，粒度偏粗。

#### `9a8a4c6` Merge dev history for branch alignment
- 改动：把 dev 线（含各重复对的另一半）并入特性分支，收拢双分支历史。
- 评审：combined diff 为空——重复补丁内容相同故自动合并无冲突；这是双分支重复提交最终"对齐"的节点，message 名实相符。
- 问题：[低] 对齐本身无害，但正是它把每个特性的两份等价 commit 都留在了 master 可达历史里。

#### `307450e` Merge pull request #9 from Skymore/codex/phase1-chat-entry-ux
- 改动：把 a7da0cd+9a8a4c6 合入 master。
- 评审：纯 merge，无冲突解决改动。
- 问题：无明显问题。

#### `cd96e8c` Fix mobile composer reflow
- 改动：键盘策略第三次重写：`--app-height` 不再跟随 visualViewport 收缩（恒取 `window.innerHeight`/`100svh`，聚焦期间只增不减），新增 `--app-keyboard-inset`（=布局高−可视高，仅 activeElement 可编辑时非零）；composer 改用 `bottom: max(0, inset − bottomNav 高)` 浮到键盘上方，消息列表 padding 改为固定 240px 常量，键盘开合不再整页 reflow；`.app-shell` 从 `top:offsetTop` 改 `translate3d` + `will-change` 走合成器；e2e 升级为注入 inset 断言"列表几何零变动、composer 上浮"。
- 评审：从"压缩布局"转向业界标准的"稳定布局+键盘悬浮 overlay"，方向正确且终于解决打字时列表跳动；宽度变化才允许重置布局高的判别、focusin/focusout 触发、'all'/'keyboard' 合并调度都考虑周到，单测+e2e 双层覆盖。这是 cf6b027→df42bbc→cd96e8c 三连环的收敛点：每次都推翻前一次的核心假设，说明该问题域缺乏先行设计、靠生产反馈迭代。
- 问题：[低] 列表底部 padding 固定 240px 与 composer 实际高度解耦，编辑区撑满 max-h-36+回复条时 composer 可能超 240px 遮住末条消息。[低] `--rt-bottom-nav-height` 用 3.3125rem 魔数与导航实际高度隐式耦合，nav 改高会静默错位。

#### `2c475a6` Merge pull request #10 from Skymore/codex/fix-mobile-composer-reflow
- 改动：把 cd96e8c 合入 master。
- 评审：纯 merge，无冲突解决改动。
- 问题：无明显问题。

#### `02cd7cf` Implement optimistic text send and atomic AI request
- 改动：纯文本消息改乐观发送：本地先插 `temp-<clientMessageId>` 气泡（pending 半透明），ack/broadcast 按 `clientMessageId` 优先、id 兜底去重对账（`upsertMessage` 重写），失败标红环+错误文案；新增服务端 `send_message_and_ask_ai` 把"存用户消息+广播+启动 AI 流"合成一次往返；含 ~800 行新测试。
- 评审：对账模型设计正确——服务端广播原样回带 `clientMessageId`，先到广播或先到 ack 都收敛，`markMessageSent` 对 failed 状态的保持/翻转语义自洽；乐观路径只限单段文本、图片仍走阻塞旧路，范围克制；测试覆盖是全批最佳。
- 问题：[中] `send_message_and_ask_ai` 的 ack 把"消息保存"与"AI 启动"两个结果混在一个 success 里：用户消息已持久化并广播后若 `startAIResponse` 失败，ack 返回 false，客户端会把这条已保存的消息标成 `failed`（红环+"发送失败"），与服务器真实状态矛盾且无法重试纠正。[低] 失败气泡无重试/删除操作，编辑器已清空，用户只能手动复制重发；历史重拉（重连）会整表替换，瞬时丢弃在途 pending 气泡；对 pending 气泡点回复会引用 `temp-` id，服务端必报 Quoted message not found；`clientMessageId` 不落 Postgres 但随 Redis JSON 持久化，两存储轻微不一致。

#### `4b8059b` Stabilize mobile chat composer rendering
- 改动：双重内容：(1) 整体回滚 cd96e8c 的键盘 inset 方案——appViewport.ts 与 index.css 经 `git diff df42bbc 4b8059b` 验证逐字节回到 df42bbc 状态，composer 回到 `bottom-0` + `bottomPaddingPx=composerHeight+12`；(2) 新增消息窗口化渲染：初始只渲染最近 80 条，"加载更早"按钮 +80，配 `preserveScrollRef` 在 useLayoutEffect 里按 scrollHeight 差值保位，`isNearBottomRef` + ResizeObserver 在贴底时自动重新钉底。
- 评审：窗口化才是标题里 "stabilize" 的实质——长房间全量渲染 Markdown/KaTeX 是键盘开合卡顿的根因之一，限 DOM 数量+resize 钉底让 dvh 收缩方案重新可用；保位算法（scrollTop+=ΔscrollHeight）与 rAF 合并滚动写得正确，有 jsdom 测试覆盖。但 cd96e8c 的 overlay 方案从合入 master 到被回滚只活了约 2 小时，这是键盘 viewport 第 4 次方向翻转，且 commit message 完全未提"回滚 PR #10"，后人读史无从知晓 inset 方案为何被弃。
- 问题：[中] 提交粒度与可追溯性：回滚+新特性混在一个 commit，message 名实只对了一半；应拆为 revert + feature 两个提交并注明取舍原因。[低] 窗口化只省 DOM，`message_history` 仍整房全量（含 base64 图）下发，传输层瓶颈未动；e2e 断言随回滚弱化，键盘场景重新失去自动化覆盖。

---

## 批次 5：图片存储与语音消息（18 commits，`5214626` → `b0d7fab`）

**批次小结**：本批 18 个 commit 集中在 2026-06-03~04 两天内，三条主线：(1) 图片资产私有化（5214626 一次性落地对象存储 + `room_members` 鉴权 + 迁移脚本，f606cd6→bdc5d36 的"内存安全化-回退"往返最终以 36e18b2 的"迁移只在本地跑"运维决策收场，闭环合理）；(2) 语音消息五连击（a940c25 首发即在 Postgres CHECK 约束上翻车且带 CI 红灯合入，01337e4 补流式转写，a0d15f6 系统性收尾三个真缺陷，d95195e 18 小时内把手势交互推倒重写为状态机），节奏是典型的"先上车后补票"，但每轮修复质量都在提升；(3) 移动端打磨（0be5726/284c38e/aaa41ff/ccb1614/b0d7fab）属低风险样式线。服务端改动普遍带双 store 契约测试，工程纪律好于客户端；最大的架构反复是图片刚出库、语音 base64 又入库，直到后续 f905702 才统一为 media 资产。

**重点问题**：
- `a940c25` [高] Postgres `message_type` CHECK 未加 'voice'，语音消息在 Postgres 持久化下发送必失败（a0d15f6 才修），且 commit 带类型错误合入致 CI 红
- `5214626` [中] REST 鉴权以 URL query 中的 clientId 为身份凭证，进日志/泄露面大；迁移脚本整房间 base64 消息全量载入内存
- `bf9ada3` [中] member_sockets 的 sRem→sCard→del 非原子，并发 join/leave 交错可把在线用户误移出 members
- `01337e4` [中] pointerdown 后 await getUserMedia 期间松手致录音卡死（a0d15f6 修）；Terminate 后不等终帧，转写尾部易丢
- `42e65e4` [中] Redis `readRoomsByUser` 改为全量扫描 `rooms` hash 按 creatorId 过滤，O(总房间数)
- `a940c25`/`d95195e` [中] 语音以无大小校验的 base64 走 `send_message` 进 DB 与广播，与图片资产化方向相悖（f905702 才收敛）

#### `5214626` Add private image asset storage
- 改动：图片从 base64 存消息体改为 S3 兼容对象存储：新增 `imageObjectStorage`（签名读 URL，15min）、`image_assets` 与 `room_members` 表、`hasRoomAccess` 成员鉴权（REST + socket 图片端点）、上传限额（10MB/256 chunks）、Postgres 迁移脚本（默认 dry-run，--execute 强制要求备份文件）、CI 校验 Fly secrets；客户端按 assetId 取签名 URL，失败重试一次，保留 legacy base64 回退。
- 评审：架构合理且测试覆盖全面（store 三实现 + contract test + 迁移测试）；上传完成时二次校验 clientId/房间访问，失败路径有对象删除回滚。粒度偏大：把 room_members 鉴权改造、CI 工作流、迁移脚本都揉进一个 commit，但整体 cohesive，message 基本名实相符。
- 问题：[中] REST 鉴权以 query string 里的 clientId 为身份凭证，clientId 即全部秘密且进 URL/日志，泄露面扩大；[中] 迁移脚本 `readMessagesByRoom` 把整房间含 base64 大图的消息全量载入内存，大房间内存峰值高（正是下一个 commit 试图解决的问题）；[低] `hasRoomAccess` 内含写副作用（为 creator 补写 membership），名不副实；[低] join_room 每次成功都向该用户推全量 `room_list`，多余的 `readRoomsByUser` 负载。

#### `f606cd6` Make image migration memory safe
- 改动：迁移脚本由"整房间全量读入"改为 keyset 分页（room_id, position 游标，默认 batch=1）只取未迁移的 image 消息，`sharp.cache(false)`/`concurrency(1)`，并合并 webp 转码与 metadata 为单次 `toBuffer({resolveWithObject})`。
- 评审：方向正确——确实消除了 base64 大图全量驻留内存的问题，测试同步更新；但 15 分钟后即被 bdc5d36 整体 revert（见下一条），实际未存活。
- 问题：[低] `LEFT JOIN image_assets a ON a.message_id = m.id OR a.id = m.content` 的 OR 条件无法走索引且要拿 asset id 与多 MB base64 内容比对，全表扫描很慢；[低] `--limit` 语义从"迁移成功数"悄然变为"扫描候选数"。

#### `bdc5d36` Revert "Make image migration memory safe"
- 改动：精确 revert f606cd6（revert 后 scripts 目录与 5214626 完全一致），回到整房间全量读取版本。
- 评审：这次往返的真实原因在下一个 commit 的 runbook 中才揭晓：作者改变策略，不在 serving Fly VM 上跑迁移（内存问题由"换执行环境"而非"改代码"解决），于是回退分页复杂度。对一次性迁移脚本这是合理的工程取舍——本地工作站跑全量读取毫无压力，分页版反而引入慢 JOIN 和 batch=1 的低效。
- 问题：[低] revert message 只有自动生成的一行，未说明回退动机，决策上下文要靠读后续 commit 才能拼出来；[低] 往返间隔仅 15 分钟，说明 f606cd6 合入前缺乏对"在哪跑"这一前提的确认。

#### `36e18b2` Document local image migration workflow
- 改动：新增迁移 runbook（决策：本地/专用主机跑，禁止 serving VM）+ README 段落；脚本加 `assertMigrationHost()`——检测到 `FLY_APP_NAME` 且未显式设置 `ALLOW_FLY_APP_VM_IMAGE_MIGRATION=true` 时拒绝运行，含测试。
- 评审：用环境硬闸门把运维决策固化进代码，配合 dry-run 默认、备份断言，形成完整的安全迁移流程；文档质量高（验证 SQL、回滚路径齐全）。与 bdc5d36 互为表里，补上了 revert 缺失的理由。
- 问题：无明显问题。

#### `0be5726` Update mobile message actions
- 改动：消息操作按钮从 hover 显示改为常驻（触屏无 hover），文本/图片复制统一进操作行，点赞/点踩挪入"更多"Dropdown；删除 MarkdownContent 里的 `ContentActionButtons`；顺手移除 MessagePage 的 `AppHeader`。
- 评审：方向正确——hover-only 操作在移动端不可用；把 AI 消息专属按钮统一到通用操作行减少了重复实现。移除 AppHeader 属于布局改造，超出"message actions"的 message 范围，应拆分。
- 问题：[低] like/dislike 仍是纯本地 state，刷新即丢且不同步给任何人，装饰性功能；[低] AppHeader 移除与 commit 主题无关，粒度混杂。

#### `284c38e` Compact mobile composer layout
- 改动：输入框移动端改为单行 flex-wrap 紧凑布局（缩小 min-h、回复引用占整行），AI 模型选择器移动端隐藏并复制一份进 AI 设置 Modal，消息气泡 `w-full`→`w-fit`。
- 评审：纯样式/响应式调整，`sm:` 断点恢复桌面行为，message 名实相符，风险低。
- 问题：[低] 移动端 Modal 里的模型 Select 与桌面版 ~50 行标记重复，后续两处要同步维护。

#### `bf9ada3` Fix room online member counts
- 改动：在线人数从"clientId 集合"改为按 socket 细化：`room:{id}:member_sockets:{clientId}` 集合记录每个客户端的活动 socket，最后一个 socket 离开才把 clientId 移出 members；新增启动时 `clearRealtimeRoomMembers()` 用 SCAN 批量清掉重启后过期的实时成员键。
- 评审：正确解决了多标签页/多设备下一个 socket 离开就把人数减没的 bug，重启清扫避免计数永久虚高；接口签名三处调用与测试同步更新。
- 问题：[中] `sRem→sCard→del+sRem` 非原子：并发下"最后一个 socket 离开"与"新 socket 加入"交错时，`del(clientSocketsKey)` 可能误删刚加入的 socket 并把在线用户移出 members（需 MULTI/Lua 才严密）；[低] 启动清扫假设单实例独占 Redis，多实例滚动部署会清掉其他实例的在线状态。

#### `aaa41ff` Tighten mobile header, bottom nav, and message bubble spacing
- 改动：BottomNav 按钮 10→8/11→9、图标缩号，ChatHeader 与气泡 padding 收紧，共 11 行 className 调整。
- 评审：纯样式微调，名实相符，无逻辑。
- 问题：无明显问题。

#### `a940c25` Add voice message recording and playback
- 改动：输入栏加语音/键盘切换，按住说话用 MediaRecorder 录 opus/webm（上限 60s），以 data-URL base64 经普通 `send_message` 通道发送 `messageType:'voice'`；MessageItem 用原生 `<audio controls>` 播放；前后端 TS 类型扩展 'voice'。
- 评审：客户端实现中规中矩（pointer capture 防误触、超时自停、过短丢弃），但服务端只改了 TS 类型签名，属于"半个特性"。与当天上午刚完成的"图片出库进对象存储"方向自相矛盾——又把大 base64 塞回消息体/数据库，直到 f905702 才统一为 media 资产。
- 问题：[高] Postgres `room_messages.message_type` 的 CHECK 仍只允许 ('text','image','ai')，voice 消息在 Postgres 持久化下 INSERT 必失败——两个 commit 后 a0d15f6 才补（说明合入前没在 Postgres 模式下跑通）；[中] `send_message` 对 content 无任何大小校验，60s 音频 base64 数百 KB 直接进 DB 与房间广播，且回退了刚建立的资产化架构；[低] blob.size<1000 时静默丢弃录音，无用户提示。

#### `01337e4` Add streaming voice-to-text with AssemblyAI + WeChat-style gestures
- 改动：按住说话加微信式手势（上滑左=取消、上滑右=转文字、松手=发送）+ 全屏手势遮罩；新增 `create_transcription_token` socket 端点用服务端 API key 换 5 分钟短时 token，浏览器经 ScriptProcessor 降采样为 16k PCM16 直连 AssemblyAI WS 实时出字；转文字落入编辑器可改。
- 评审：token 中转设计正确（API key 不出服务端，降级路径完整）；客户端对"录音先结束、WS 后建立"的竞态有处理（`audioStreamRef` 比对后丢弃晚到的 transcriber）。message 坦诚补了 a940c25 留下的 CI 类型错误——说明上一条是带着红 CI 合入的。
- 问题：[中] `pointerdown→await getUserMedia` 期间用户松手，pointerup 时 recorder 尚未创建无从停止，权限弹窗结束后录音"无人持有"地自启（即 a0d15f6 所修的 hold/permission bug）；[中] `transcriber.stop()` 发 Terminate 后不等终帧即取文本，尾部话语易丢；[低] token 端点只验注册不限频，任意注册 socket 可刷 AssemblyAI 配额；[低] ScriptProcessorNode 已废弃（主线程处理音频），AudioWorklet 是正解。

#### `a0d15f6` Fix voice messages: allow 'voice' in Postgres, fix hold/permission, add tests
- 改动：Postgres CHECK 约束加 'voice'（drop+re-add 保证存量表幂等迁移）；AI 上下文与回复预览把语音 base64 替换为 `[Voice message]`；进语音模式即预热麦克风权限 + `isPointerDownRef` 守卫"await getUserMedia 期间松手"不再卡录音；DSP 函数抽到 `audioEncoding.ts` 并补 token handler/DSP 测试。
- 评审：对 a940c25/01337e4 三个真实缺陷（DB 约束、LLM 上下文被 base64 撑爆、hold 竞态）的系统性收尾，message 逐条对应改动，是本批质量最高的修复 commit 之一。
- 问题：[低] 约束 drop+re-add 放在每次启动执行的 schema SQL 里，每次重启都对全表 revalidate CHECK 并持 ACCESS EXCLUSIVE 锁，长远应改为一次性迁移。

#### `02d17de` Remove redundant message input placeholder
- 改动：删掉输入框 "type your message here" placeholder 及全部语言的 i18n 词条（AI 处理中提示保留）。
- 评审：小清理，连带删干净所有 locale，无残留。
- 问题：无明显问题。

#### `fb2f231` fix: refine voice and media message styling
- 改动：录音手势遮罩从黑底微信绿改成品牌色（含 safe-area-inset 底栏）、HeroUI `<Image>` 换原生 `<img>` 并抽出 `imageMedia` 节点、`<audio>` 用 `.roomtalk-audio-player` CSS 主题化 webkit 控件，补一条渲染测试。
- 评审：纯视觉打磨与小重构，行为不变；用 `fix:` 前缀略名不副实（更像 style/refactor），无功能风险。
- 问题：无明显问题。

#### `2b34120` fix: preserve message order on edit
- 改动：编辑消息不再改写 `timestamp` 而是写入新字段 `updatedAt`（types/两套 store Lua+SQL/schema `ADD COLUMN IF NOT EXISTS`），Redis 端顺带不再因编辑 bump 房间 lastActivityAt；客户端 `sortMessages` 按原 timestamp 排序加测试。
- 评审：真 bug——客户端按 timestamp 排序，旧实现编辑会把消息挪到末尾；created/updated 语义分离是正解，三处（client 排序、Redis、Postgres）一致修掉且契约测试覆盖。
- 问题：[低] 编辑不再刷新房间 lastActivityAt 是个未在 message 中声明的行为变更（房间列表排序受影响），与"消息顺序"主题擦边。

#### `42e65e4` fix: separate saved rooms from membership
- 改动：新增 `room_saves` 表/Redis `saved_rooms` 键与 `save_room`/`unsave_room`/`get_saved_rooms` 端点，收藏与成员资格解耦；`leave_room` 现在真正删除非 owner 的 membership；"我的房间"语义改为"我创建的房间"。
- 评审：数据模型上的正确拆分（收藏≠成员≠创建者），双 store + 契约测试 + handler 测试覆盖充分；ack 回调与 `saved_room_list` 推送配套完整。名为 fix 实为不小的特性重构。
- 问题：[中] Redis 版 `readRoomsByUser` 改为 `hKeys('rooms')` 全量拉取所有房间 JSON 再按 creatorId 过滤，房间总数增长后每次 room_list 都是 O(N) 全表扫描；[低] `save_room` 只验房间存在不验访问权，任何注册客户端可凭 roomId 收藏并看到房名/描述（与现有凭证模型一致，但扩大了元数据暴露面）。

#### `d95195e` fix: update voice input and transcription flow
- 改动：废弃微信式按住+滑动手势，改为显式状态机 `choice → recording-voice/recording-transcript → voice-preview`：录完可试听再发/弃，转写模式把文本追加进编辑器（保留原草稿快照）；WS 未开则硬失败并按错误类型提示，`recordingSessionRef` 序号使过期异步失效，objectURL revoke、iOS `audioContext.resume()`、语音消息支持 replyTo；服务端 token handler 兼容双签名；补 MessageInput 测试。
- 评审：对前两版语音交互的全面重写，竞态处理明显成熟（会话序号模式），错误路径从静默降级改为显式提示，工程质量高。但 18 小时内交互方案推倒重来，且 `fix:` 前缀大幅低估了 580 行的重构体量。
- 问题：[低] 计时器在 `setRecordingSeconds` 的 updater 内调用 `stopVoiceRecording`（带副作用的 updater，StrictMode dev 下可能双触发，幸而幂等）；[低] 语音仍走 base64 `send_message` 通道，体积问题遗留至 f905702 才解决。

#### `ccb1614` fix: simplify mobile room header
- 改动：房间头部精简：改名入口从常驻铅笔按钮挪进 Dropdown 菜单，移除"xx 加入/离开"的瞬时 memberEvent 提示（连 `roomState.getRoomMemberUpdate` 的 event 字段一并删除），标题/人数/房间 ID 单行紧凑排布。
- 评审：删得干净（prop、工具函数、测试同步清理，无残留），改名功能仍可达；纯 UI 简化，名实相符。
- 问题：无明显问题。

#### `b0d7fab` fix: tune mobile chrome heights
- 改动：移动端 chrome 整体再压一档：BottomNav/Header/输入栏按钮 8→7、`safe-bottom` 类换成显式 `pb-[env(safe-area-inset-bottom)]`、编辑区 min-h 与行高收紧。
- 评审：纯样式收尾，与 aaa41ff/ccb1614 同属一条打磨线；名实相符。
- 问题：[低] 发送/AskAI 按钮用 `!h-7` 等 !important 覆盖 HeroUI 内部样式，升级组件库时易碎。

---

## 批次 6：历史分页缓存与媒体对象存储（17 commits，`251682b` → `2137a3d`）

**批次小结**：本批两条主线。其一是消息历史分页 + 版本化客户端缓存 + 首屏性能（251682b→75be170、3651846）：服务端 per-room message_version 与 before-cursor 分页设计扎实，客户端"内存镜像→IndexedDB→服务端 replace"三级渐进渲染演进清晰；但 251682b 把 `get_room_messages` 入参从 string 换成对象且无服务端兼容，残留 3 处旧调用分散在后续 2 个 commit 才修完，且 historyVersion 埋点最终未被一致性校验真正消费（75be170 改用内容指纹）。其二是媒体统一到对象存储（f905702→7c29658）：方向正确（base64 出库、presign 上传/下载、MIME/大小门禁、孤儿对象回收），但 7458 行巨型 commit 夹带无关昵称特性，并带着两个上线即坏的缺陷（PG FK 顺序致媒体发送必败、presign PUT 浏览器不兼容），靠当日 ecfe332/4a91cdb 快速跟进修复。整体测试纪律好（contract 测试、scripted pool、行为级前端测试），commit message 大多诚实，主要短板是巨型提交粒度与上线前缺生产配置（Postgres）下的端到端验证。

**重点问题**：
- `f905702` [高] complete 端点先存 media_assets（FK 引用未插入的消息行）后插消息，PG 模式下媒体上传必 500，功能上线即不可用（ecfe332 修复）。
- `251682b` [中] `get_room_messages` 协议从 string 改对象无服务端兼容，部署窗口内旧客户端取不到历史；自家客户端也残留 3 处旧调用（2341c00、3651846 才修完）。
- `251682b` [中] PG 分页读出错时返回空页而非报错，客户端 replace 会清屏并把空窗口写入 IndexedDB 污染本地缓存。
- `f905702` [中] `get_room_members` 不做 hasRoomAccess 即返回在线成员 clientId+昵称，而 clientId 即本应用的 bearer 凭证。
- `f905702` [中] AI 上下文不再内联图片 base64，AI 看图能力被静默移除且 message 未声明。
- `f905702` [中] presign PUT 无频控、未 complete 对象无 GC（4a91cdb 后签名更不锁大小/类型），存储滥用与泄漏敞口。
- `9d30c79` [中] message_type CHECK 收窄放在每次启动的 DDL，仍含遗留行的环境会启动即崩，且迁移脚本同 commit 被删，未复用 093656b 刚建的一次性迁移机制。

#### `251682b` feat: paginate room message history with version-aware client cache
- 改动：服务端 `get_room_messages` 改为分页负载（messages/historyVersion/hasMore/oldestMessageId/mode），rooms 表加 `message_version` 列、Redis room hash 加 `messageVersion`，全部 mutation 路径（含 Lua 脚本）原子自增；新增 `readMessagePageByRoom`（PG 按 position 游标，Redis 内存切片）。客户端消费 replace/prepend 两种模式，最新窗口写 IndexedDB 先渲染再被服务端覆盖。
- 评审：分页设计合理（limit+1 探测 hasMore、position 降序后 reverse、limit clamp 1~200），版本号在 PG/Redis 两侧均原子维护；客户端缓存"先显后校"思路正确。但本 commit 中 historyVersion 实际上没有被任何比较逻辑消费（仅存取），"version-aware"在此时只是埋点；客户端 `bumpLocalHistoryVersion` 按收到的 socket 事件本地 +1，与服务端按 mutation 计数在丢事件/重连时必然漂移，后续 75be170 才开始消费该版本。
- 问题：[中] 服务端 `get_room_messages` 入参从 string 改为对象且不兼容旧形状，部署期间已加载的旧客户端发 string 会取不到历史（仅客户端做了对旧服务端数组形状的兼容，方向反了）。[中] PG `readMessagePageByRoom` 出错时返回空页+`historyVersion:0` 而非报错，客户端 replace 分支会把空列表写进 IndexedDB，瞬时 DB 故障会清屏并污染本地缓存。[低] 缓存读取 resolve 前若有 `new_message` 先到，缓存回填会以数组形式整体覆盖、暂时丢掉该实时消息（直到服务端 history 到达）。[低] `normalizeMessagePageLimit` 在两个 store 重复实现。

#### `d977315` fix: instant room render via in-memory cache + Postgres clear version bump
- 改动：messageHistoryCache 增加同步内存 Map 镜像（IndexedDB 退为跨会话备份），重开房间命中内存即刻渲染、不闪 loading；PG `clearRoomMessages` 改为事务内 DELETE + `message_version+1` 并把 `last_activity_at` 重置为 `created_at`，对齐 RedisStore 行为。
- 评审：准确补上了 251682b 的两个缺口——IndexedDB 异步读必闪一帧 loading、PG 清空不 bump 版本导致两 store 版本语义不一致；contract 测试同步验证 clear 后版本 +1。内存命中后服务端 replace 仍会再次 setMessages + 滚动，"无变化也重滚"的问题留到 75be170 修。
- 问题：无明显问题（内存窗口与服务端窗口短暂不一致由后续 replace 收敛，属设计内）。

#### `2341c00` perf: eliminate first-paint delay when opening a room
- 改动：ChatRoomView 给 MessageList 加 `key={roomId}` 按房间重挂载，useState 惰性初始化器同步读内存缓存使首帧即含缓存窗口；MessageItem 套 React.memo 并用 messagesRef 让回调引用稳定；预热 MarkdownContent lazy chunk；顺手修掉 retry 失败路径残留的 `socket.emit('get_room_messages', roomId)` 字符串旧形状调用（被 251682b 引入）。
- 评审：方向正确的渲染性能 commit，惰性初始化 + remount 替代手动 reset effect 是干净解法；对残留 string emit 的修复恰好印证了 251682b 协议切换未做兼容的风险。memo 的有效性依赖所有 handler props 引用稳定，本 commit 只稳定了 MessageList 内部三个，外部传入的 onReply 等若不稳定则 memo 打折（非正确性问题）。
- 问题：[低] `readMemoryRoomMessageWindow(roomId)` 在 4 个初始化器里重复调用 4 次，可读性与一致性略差（实际风险极小）。

#### `6abdc0e` chore: ignore local artifacts and fix load-more button label
- 改动：.gitignore 增加 backups/、tmp/、Python 缓存；加载更多按钮 loading 态文案从 t('loading') 换为专用 t('loadingMore')（中英两份）。
- 评审：纯杂项，粒度合适、message 名实相符。
- 问题：无明显问题（按钮常态文案剩余不足 80 条时数字不准，系 251682b 遗留、非本 commit 范围）。

#### `ab865cb` Support Postgres SSL CA configuration
- 改动：`resolvePostgresSslConfig` 支持 `POSTGRES_SSL_CA_BASE64`（优先）与 `POSTGRES_SSL_CA` 注入自定义 CA，含单测与 .env.example 说明。
- 评审：小而完整，托管 PG（自签根证书）场景必需；用 base64 规避多行 secret 转义问题的取舍写进了注释。
- 问题：[低] `POSTGRES_SSL_CA` 走 .env 文件时字面 `\n` 不会被还原成换行（dotenv 不转义），PEM 会解析失败且无校验/提示，只能靠用户自觉改用 BASE64 变量。

#### `093656b` Run Postgres backfill as one-time migration
- 改动：把 room_members owner 回填从每次启动都跑的 DDL 列表挪到新增的 `schema_migrations` 一次性迁移机制（存在性检查 + 事务内执行并记录）。
- 评审：动机正确（全表扫描回填不该每次冷启动重跑），迁移与记录同事务保证崩溃一致性，注释明确"只追加、不改已应用迁移"的纪律，测试覆盖两条路径。
- 问题：[低] 存在性检查与执行之间无 advisory lock，多实例并发启动会双跑迁移；当前唯一迁移幂等（ON CONFLICT）所以无害，但该框架对未来非幂等迁移缺并发护栏。

#### `75be170` Avoid duplicate scroll on unchanged server history
- 改动：replace 模式下用 `isSameMessageWindow`（逐条比 id/updatedAt/status）对比当前窗口与服务端窗口，相同则跳过 setMessages 与重复滚动；`scrollToBottom` 改用容器 `scrollTo` 替代 `scrollIntoView`；补 hi/ja/ko 的 loadMore 文案。
- 评审：解决 d977315 引入的"缓存命中后服务端 replace 必再滚一次"的体验问题。值得注意它没用 historyVersion 而用内容指纹做等价判断——这是对的，因为客户端本地版本会漂移（见 251682b）；不比 content 还顺带避免了流式中途 replace 清掉本地已积累的 chunk。
- 问题：[低] 等价判断不含 content，若服务端内容变化但 updatedAt/status 未变会保留旧内容（当前所有编辑路径都更新 updatedAt，属防御性盲区）。[低] 一个 commit 混了滚动去重、scrollTo 行为修正、三语翻译补齐三件事，message 只交代第一件。

#### `6ecd9ec` chore: gitignore Supabase CLI local state (.temp/.branches/.env)
- 改动：.gitignore 增加 supabase/.temp、.branches、.env 三项。
- 评审：纯 chore，注释说明 config.toml/migrations 仍跟踪，合理。
- 问题：无明显问题

#### `3651846` Fix mobile room restore loading states
- 改动：恢复存储房间时立刻 joinRoom + 显示 isRestoringRoom spinner，不再等 getRoomById；memberCount/sessionCostUsd 改为 nullable 显示 "..."；房间/收藏列表与侧栏加 loading 骨架；getRoomById 不再吞错误并把超时提到 30s；顺带修复 MessagePage visibilitychange 与删除失败重取两处残留的 string 形态 `get_room_messages`（被 251682b 引入，另一处已在 2341c00 修）。
- 评审：体验导向的合理重构，"先进房后校验"显著缩短移动端恢复时延；getRoomById 错误语义修正（网络错误不再伪装成 room=null 把用户踢出）是实质改进。至此 251682b 的协议切换共暴露 3 处客户端残留调用，印证当时缺一次全局 grep。
- 问题：[低] commit 同时塞进恢复流程重构、骨架屏、超时调整与协议残留修复，message 只概括了 loading states；协议修复值得单列。[低] getRoomById 异常时保留旧 currentRoom shell 不再回退清空，房间确已被删时用户停留在僵尸房间直至下次成功校验（取舍可接受）。

#### `e1a82ee` Ignore JSX expression fragments in i18n check
- 改动：check-i18n-keys 脚本的 `isExpressionFragment` 启发式新增 `)` 开头、`(` 结尾、含 `&&` 三种模式，消除误报。
- 评审：lint 脚本微调，启发式打补丁的常规演进；理论上会把含 "&&" 的真实硬编码文案漏掉，但该脚本本就是 best-effort。
- 问题：无明显问题

#### `f905702` feat: unify image/voice into object-storage-backed media
- 改动：image/voice 两种消息统一为 `media` 类型 + `media_assets` 表 + S3/Tigris 对象存储；REST 三件套（presign 上传 / complete 落库发消息 / presign 下载），带 hasRoomAccess、per-kind 大小上限、MIME 白名单（禁 svg）、objectKey 服务端推导校验、HEAD 复核；删除 socket mediaHandlers/上传会话/imageObjectStorage；PG 删除消息/清空/截断/删房时回收孤儿对象（事务后 best-effort）；附遗留数据迁移脚本。
- 评审：架构方向正确（base64 出库、签名 URL、私有 bucket），安全细节大多到位。但 complete 端点先 `saveMediaAsset`（FK 引用 room_messages）再 `appendMessage`，PG 下 FK 立即违反 → 媒体发送必然 500，功能在 Postgres 生产模式下根本跑不通（合入前显然没在 PG 上端到端验证，contract 测试的 fake pool 不模拟 FK）；后续 ecfe332 改为单事务修复。另外 commit 还夹带了完全无关的昵称/在线成员特性（client_profiles 表、set_username、get_room_members、register 改对象负载），message 只字未提。
- 问题：[高] PG 模式下媒体上传 complete 因 FK 先后顺序必败（ecfe332 修复）。[中] `get_room_members` 不做 hasRoomAccess 校验即返回在线成员 clientId+昵称，而 clientId 在本应用中即 bearer 凭证，与 get_room_messages 的鉴权标准不一致。[中] `buildAnthropicMessages` 不再内联图片 base64，AI 看图能力被静默移除，message 未声明该回退。[中] 预签名 PUT 无频控、未 complete 的对象无 GC（旧 upload-session 清理被删），且预签名不锁 ContentLength，存储滥用/泄漏敞口。[低] complete 的存在性检查与写入存在竞态，可产生指向同一 asset 的重复消息。

#### `9d30c79` chore: remove legacy image/voice compat after media migration
- 改动：确认生产 0 条遗留行后，删除 LegacyMessageType 与 image/voice 分支，message_type CHECK 收窄为 text|ai|media，并删除一次性迁移脚本及其测试（-803 行）。
- 评审：迁移完成后立刻清理兼容层，纪律好，message 明确交代了验证依据；与 f905702 同一 CommitDate，应是同批整理提交。
- 问题：[中] 收窄 CHECK 走每次启动的 DDL（drop-then-add 会全表校验），任何仍含 image/voice 行的环境（其他部署/开发库）会在启动时直接崩，而能补救的迁移脚本在同一 commit 被删，回滚只能翻 git 历史；更稳妥的做法是把收窄放进带前置校验的一次性迁移（093656b 刚建好该机制却没用上）。

#### `1a4f9bc` fix(logger): restore Console transport so prod logs reach stdout/fly logs
- 改动：恢复被 f905702 注释掉的 winston Console transport，生产用纯文本格式、开发用彩色。
- 评审：自我修复（被 f905702 引入），message 诚实交代来龙去脉；与 f905702/9d30c79 同一 CommitDate 同批推送，生产实际未经历日志丢失窗口。生产/开发分格式的选择合理。
- 问题：无明显问题

#### `ecfe332` fix: append media messages atomically
- 改动：新增 `appendMediaMessageWithAsset`：PG 端单事务（房间行 FOR UPDATE → 插消息 → 存 asset → bump message_version），Redis 端新 Lua 脚本一次写入 room hash/消息 list/asset hash/房间 asset set；complete 端点改用该原子接口，失败补偿仅删对象。
- 评审：修复 f905702 的 FK 顺序致命缺陷，同时消除"消息成功、asset 失败"的半提交态，两端实现与测试都扎实。message 写成普通的原子性加固，未点明它实际修复的是媒体上传完全不可用，名实略有出入。
- 问题：[低] PG 实现复制了 appendMessage 的锁房间+position 计算逻辑，未抽公共路径。[低] assetId 去重检查仍在事务外，并发双击 complete 仍可能产生两条消息：第二次 ON CONFLICT(id) DO UPDATE 会把 asset 的 message_id 改指向新消息，先前那条变成无 asset 的空媒体消息。

#### `4a91cdb` fix: make media upload URLs browser compatible
- 改动：presign PUT 不再签 ContentLength/CacheControl，S3Client 设 `requestChecksumCalculation: 'WHEN_REQUIRED'` 去掉 SDK 新默认注入的 CRC32 校验参数；测试断言 SignedHeaders 仅 host 且无 checksum 参数。
- 评审：修复 f905702 上线即坏的第二个问题——浏览器 fetch 无法满足被签名的 CacheControl/checksum 头导致 PUT 403；用测试钉住 URL 形状防 SDK 升级回归，做法对。
- 问题：[低] SignedHeaders 退化为仅 host 后，PUT 阶段大小与 Content-Type 完全不受签名约束，只剩 complete 时 HEAD 复核兜底；不匹配的对象会留在 bucket（叠加 f905702 的无 GC 问题）。

#### `7c29658` fix: keep image drafts on upload failure
- 改动：发送循环里图片上传失败不再就地吞错（误报"压缩失败"且继续清空草稿），改为 rethrow 让外层保留草稿并显示发送失败；另修正插图仅当 selection 真在编辑器内才按光标位置插入。
- 评审：配套测试验证失败后 img 仍在编辑器、previewUrl 未被 revoke，行为契约清晰；是 f905702 媒体链路上线后的合理收尾。
- 问题：[低] selection 越界插入的修复与标题主题无关且 message 未提；多图批量发送时失败中断循环，已发成功与未发的边界对用户不可见（可接受）。

#### `2137a3d` fix: handle ios safari keyboard viewport
- 改动：appViewport 在 visualViewport 缩小超 120px 且焦点在可编辑元素时给根元素挂 `roomtalk-keyboard-open` 类，CSS 借此隐藏移动端底部导航；cleanup 时移除类。
- 评审：用"焦点 + 高度差阈值"双条件区分键盘弹出与浏览器 chrome 变化，避免误判；复用既有 rAF 节流更新路径，三条单测覆盖正常/阈值内/可编辑焦点场景，小而完整。
- 问题：无明显问题（纯启发式，外接键盘等场景自然退化为不隐藏，行为安全）。

---

## 批次 7：房间管理/可靠性系列（14 commits，`968b6df` → `7238ebe`）

**批次小结**：本批 14 个 commit 收束两条线：968b6df 一次性落地房间管理/密码/发帖时段与服务端授权层（设计扎实但体量过大），随后 7dbd20d~afed4a3 做 AI 上限、移动端 tooltip/键盘与文案打磨；fdfaa12→0a79128 是一条罕见的高质量可靠性迭代——注册/加入竞态、恢复触发器合并、spread 合并删不掉字段、wall-clock LWW 到行级 `room_version` 的方案演进，每步有对抗性评审文档、red-test 与契约测试背书，b249860 的 "total order" 言过其实被 0a79128 坦诚纠正；两个 docs commit 内容与代码核对一致。总体质量高于平均，主要扣分在大 commit 粒度与 Redis 路径的非原子残留。

**重点问题**：
- `968b6df` [中] Redis 版 `transferRoomOwnership`/`updateRoomSettings` 多步 read-modify-write 无原子保护，并发可丢更新/短暂双 owner（PG 路径正常；0a79128 仅原子化了版本号，字段合并竞态至今残留）。
- `7dbd20d` [中] AI 上下文 40→1000 条仅按条数截断、无 token 预算，输入成本激增且极端下可能超模型上下文报错。
- `fdfaa12` [中] 四个恢复触发器各自发起 join_room，重复网络往返（c0d5944 已修）。
- `6782f7c` [中] LWW 用 wall-clock `updatedAt` 且仅 settings/rename 打点，时钟偏差/未打点房间下排序不可靠（b249860 扩面、0a79128 根治）。
- `b249860` [中] `NOW()` 为事务开始时间，锁竞争下广播序与 stamp 序可倒挂，"exact total order" 名过其实（0a79128 已取代）。

#### `968b6df` feat: room administration, security, and posting schedules
- 改动：引入 owner/admin/member 三级角色与服务端授权层（`roomAuthorization.ts`），房间密码（scrypt+salt+`timingSafeEqual`）、发帖时段（含跨午夜窗口与时区校验）、管理员管理/所有权转移、清空历史需输入房间名确认；PG 加 `password_hash`/`posting_schedule` 列并改 role CHECK；socket/REST/AI 三条发消息路径统一走 `message.post` 授权；客户端新增 825 行 RoomSettingsModal 等 UI。
- 评审：服务端鉴权设计扎实——所有敏感操作集中在 `authorizeRoomAction`，edit/delete 校验消息归属与房主特权，REST 媒体上传也补了发帖时段检查，没有明显绕过；密码哈希用法正确；`normalizePostingSchedule` 对 days/HH:MM/时区做了完整边界校验，跨午夜窗口逻辑（start>end 查前一天）正确；PG `transferRoomOwnership` 用事务+`FOR UPDATE`。`leave_room` 不再删除持久成员资格（密码房的访问凭证），有意为之且有注释。
- 问题：[中] Redis 版 `transferRoomOwnership`/`updateRoomSettings` 是多步 read-modify-write，无 MULTI/WATCH/Lua，并发下可能丢更新或短暂出现双 owner（PG 路径无此问题，但 Redis-only 部署受影响）。[低] `getRoomMessage` 每次 edit/delete 鉴权全量 `readMessagesByRoom`，长房间 O(n)。[低] apiRoutes 中 `postAuth.code === 'posting_closed' ? 403 : 403` 两分支相同属死代码。[低] `lookup_room_client` 允许 owner 探测任意 clientId 的全局昵称（不限本房成员），轻微信息泄露（clientId 为 UUID，难枚举）。提交体量过大（3.2k 行），服务端授权层与大块 UI 重设计可拆分，但 message 如实覆盖了内容。

#### `7dbd20d` feat(ai): widen context window and raise output cap to reduce truncation
- 改动：`MAX_CONTEXT_MESSAGES` 40→1000、Anthropic `max_tokens` 8096→32000，均可由环境变量覆盖（`AI_MAX_CONTEXT_MESSAGES`/`ANTHROPIC_MAX_TOKENS`）。
- 评审：实现干净（`parsePositiveInt` 容错回退）；当前配置的模型支持 32k 输出，无 API 拒绝风险。
- 问题：[中] 上下文从 40 条放宽到 1000 条仅按条数截断、无 token 预算：长房间每次 AI 调用输入成本激增，极端下可能逼近/超出模型上下文导致 API 报错；message 只提"输出按实际生成计费"，回避了输入侧成本，名实略有出入。

#### `95eebfb` fix(mobile): stop hover tooltips from sticking open after tap
- 改动：新增 `useIsTouchDevice`（`(hover: none), (pointer: coarse)` 媒体查询 + change 监听）与 `HoverTooltip` 包装组件，在触屏设备禁用 hover tooltip，覆盖消息操作、侧栏、房卡等处。
- 评审：诊断准确（触屏 tap 打开 tooltip 后无 mouseleave/blur 导致卡住），hook 实现含 SSR 守卫与监听清理，正确。
- 问题：[低] MessageItem 内未用新建的 `HoverTooltip` 而是手动 `isDisabled={isTouchDevice}`，与其余组件不一致；`pointer: coarse` 用 OR 连接会把"触屏+外接鼠标"设备也禁掉 tooltip，属可接受取舍。

#### `7108f30` fix(mobile): keep modals above the keyboard and use on-brand time pickers
- 改动：给各 Modal wrapper 加 `roomtalk-modal-viewport` CSS 类，用既有 `--app-height`/`--app-viewport-top` 变量把弹层钉在可见视口内；发帖时段编辑器用时/分两个 Select 替换 `TimeInput`，避免唤起数字键盘。
- 评审：方案承接此前 iOS 键盘视口工作，复用 CSS 变量合理；TimeField 对非 5 分钟整的已有值会动态并入选项，边界处理周到。
- 问题：[低] 分钟仅 5 分钟步进，新输入无法选任意分钟（已有值除外），轻微功能收窄；CSS 用多个 `!important` 覆盖 HeroUI 定位，升级组件库时易脆。

#### `afed4a3` chore(i18n): shorten "Leave Room" action to "Leave" across all locales
- 改动：五个语言（en/zh/hi/ja/ko）的 `leave` 文案统一缩短。
- 评审：纯文案 chore，五处一致修改，名实相符。
- 问题：无明显问题

#### `fdfaa12` fix: harden room session restore
- 改动：客户端 `register` 改为带 ack 的 `ensureRegisteredSocket`（按 socketId 去重、超时/断连拒绝），`emitWithAck` 一律先等注册完成；房间恢复统一为 `ensureActiveRoomSession`（generation 计数防陈旧结果），并挂上 visibility/pageshow(BFCache)/online/socket-connect 四个触发器；服务端 `register` 加 try/catch+ack，`join_room` 重连不再先 leave 同一房间并在 ack 里回传 `memberCount`；附 422 行中文策略文档与 366 行 MessagePage 测试。
- 评审：解决了真实竞态——此前 connect 后 `register` 与 `join_room` 同时裸发，服务端可能先收 join 报"未注册"；generation guard 与 `currentRoomRef` 避免 setState 竞态，`room not found` 才清存储的区分恰当；server 端防止 rejoin 时成员数闪降。测试覆盖诚意足。
- 问题：[中] 四个恢复触发器常成对触发（如切回前台同时 visible+connect），各自独立发起 join_room+get_room_messages，generation 只保证"最后一个生效"不阻止重复网络往返——后续 c0d5944 专门修此问题。[低] 混入 PostingScheduleDetails 抽取、i18n 校验脚本与 226 行文案，与"restore"主题无关，粒度偏散。

#### `6d71e0b` test(e2e): cover room session restore flows
- 改动：新增 `room-restore.spec.ts` 六个 Playwright 用例（硬刷新、新标签页、offline→online、BFCache 回退、多标签成员去重、前后台消息追平），并把 `clearChat` helper 改走新的设置弹窗+房名确认流程。
- 评审：用例直击 fdfaa12 的恢复路径，offline 用 `context.setOffline`+手动派发 `online` 事件、visibility 用 defineProperty mock，手法务实；helper 同步适配 968b6df 的 UI 变更，补上了之前欠的 e2e 债。
- 问题：无明显问题

#### `c0d5944` fix: coalesce room session restores
- 改动：后台恢复（visibility/pageshow/online/connect）合并为 `scheduleRoomRestore`：同房间 in-flight 复用同一 promise + 每房间 250ms 抑制窗；前台来源（storage/manual/url）才显示恢复指示与错误；后台恢复经 `ensureRoomJoined` 复用缓存的房间密码；把此前从未渲染的 `_error/_success` 接回 `StatusMessage`。
- 评审：正面解决 fdfaa12 留下的重复 join_room 风暴；in-flight 去重 + 失败时清除抑制窗的组合正确；`visibleRestoreGenerationRef` 把 spinner 归属到可见恢复，避免后台恢复闪 UI。`ensureRoomJoined` 还修了后台 rejoin 把 `activeRoomPassword` 覆写为 null 的隐患，并有单测锁定。
- 问题：[低] 顺手把未使用的 `_error/_success` 接上 StatusMessage 属于额外修复，commit message 未提；250ms 抑制窗是经验值，极端慢网下连发触发器仍可能产生两次 join（可接受）。

#### `6782f7c` fix: keep room settings updates from going stale on clients
- 改动：定位"关闭排期/清密码后客户端字段删不掉"的根因（spread 合并无法删除键），引入 `applyServerRoom` 整体替换 + `isNewerRoom`（updatedAt LWW）守卫；服务端 rooms 加 `updated_at` 列并在 settings/rename 写入时打点；新增客户端 `postingSchedule.ts` 镜像服务端窗口数学，在下一边界定时重拉权限（真值仍在服务端）；设置表单只在打开时播种。
- 评审：根因分析准确，"客户端只算边界时刻、不本地翻转 canPost"的职责划分干净；跨午夜边界、12h 上限重臂、+1s buffer 等细节都对；message 写得详尽且名实相符。
- 问题：[中] LWW 用 wall-clock `updatedAt`：仅 settings/rename 打点（无 updatedAt 的房间直接放行替换），且 Redis 路径用应用服务器时钟、PG 用 NOW()，多实例/双存储下时钟偏差可造成乱序——这正是后续 b249860 试图补、0a79128 最终用 room_version 取代的缺口，本 commit 算阶段性方案。[低] 两端各维护一份窗口解析逻辑，仅靠注释约定同步，存在漂移风险。

#### `b249860` fix: make room updatedAt a total order and harden posting-window plumbing
- 改动：对 6782f7c 的对抗性评审跟进（F1-F7）：PG 全部 9 处 rooms UPDATE + saveRoom upsert 盖 `updated_at = NOW()`，Redis 经 `stampRoomRecord` 收口 6 处哈希写（Lua 追加路径有意继承旧 stamp）；`isNewerRoom` 移入 roomState 加 NaN 守卫；空 settings 更新不写库不广播；新增两端 posting 窗口的交叉契约测试。
- 评审：把 LWW 的覆盖面从"仅 settings/rename"补到全部写路径，NaN 守卫防止脏 localStorage 卡死更新，空更新短路避免无意义广播，契约测试钉住双实现——都是对的方向。
- 问题：[中] 标题宣称 "total order" 但本质仍是 wall-clock：PG `NOW()` 取事务开始时间，两个并发 settings 事务可能"先开始后提交"，广播顺序与 stamp 顺序倒挂，客户端会留住已被覆盖的旧值；Redis 与 PG 双时钟源也无法严格可比。此缺陷三天后由 0a79128 用单调 `room_version` 根治，方案演进路线（spread→LWW 时间戳→版本号）合理，但中间这步的标题略名过其实。

#### `45065db` feat: show a delayed reconnecting spinner for slow background rejoins
- 改动：后台 rejoin 超过 400ms 宽限期仍未完成才点亮 header 转圈（复用 `isRestoringRoom` 渲染路径），完成即清除；卸载时清理定时器。
- 评审：解决"静默后台恢复在弱网下无任何反馈"与"健康切换闪烁"的两难，延迟指示器是标准手法；timer 在 finally 统一清理，与 in-flight 去重配合无泄漏；附带测试。
- 问题：无明显问题

#### `0a79128` fix: order room updates by a per-row version instead of timestamps
- 改动：承认 b249860 的 "exact total order" 言过其实（NOW() 是事务开始时间，锁竞争下后提交者可带更早 stamp），改用行级单调 `room_version`：PG 9 处 UPDATE+upsert 在行锁下自增；Redis 新增 `WRITE_ROOM_RECORD_SCRIPT` Lua 原子推导下一版本，8 个消息路径脚本同步 +1；客户端优先比较 `roomVersion`（等值放行保证 ack/广播双投递幂等），updatedAt 降级为展示/兼容回落。
- 评审：这是正确的终局方案（沿用 message_version 先例），commit message 坦诚记录外部评审指正，态度与工程实践俱佳；Lua 脚本顺带修掉了 968b6df 起 Redis TS 层 read-modify-write 产生重复版本号的竞态；契约测试断言混合写路径下版本严格递增。
- 问题：[低] Lua 只原子化了版本号，Redis 路径的字段合并仍是 TS 层先读后写，并发 rename 与 settings 更新互相覆盖字段的窗口仍在（prod 走 PG 不受影响，Redis-only 部署残留）；[低] cjson 把空数组 round-trip 成 `{}`（如 `windows: []`），当前两端对该字段的真值判断恰好同义，属踩线未爆的隐患。

#### `1e4671b` docs: note room_version supersedes updatedAt ordering and record the delayed reconnect indicator
- 改动：在两份既有分析文档中各加一条"2026-06-10 更新"注记：updatedAt LWW 已被 room_version 取代、延迟重连指示器（400ms）已落地。
- 评审：注记内容与 0a79128/45065db 的实际实现一致，保持文档与代码同步的习惯好。
- 问题：无明显问题

#### `7238ebe` docs: gather the room reliability series under docs/room-reliability with an entry README
- 改动：把四份房间可靠性文档归拢到 `docs/room-reliability/`（纯 rename），新增 34 行入口 README：症状→根因→修复表、现行不变量清单、文档指路与 commit 线。
- 评审：内容与代码实况核对一致（250ms 抑制窗、400ms 指示器、room_version 语义、密码复用边界），"不变量"小结对后来者很有价值。
- 问题：[低] commit 线漏列 6d71e0b（e2e 测试）；"面试 30 秒版"一节风格游离于工程文档之外，无伤大雅。

---

## 总体发现

**163/163 commit 评审完毕（2026-06-10）。** 以下为跨批次汇总；逐条依据见上文各批记录。

### 质量轨迹

历史可以清晰分成三个阶段。**奠基期**（批次 1，2025-03~04）是典型的独立项目起步：方向感好（消息分 key、会话态 Redis 化、websocket-only 适配多实例都踩对了），但纪律松散——大杂烩 commit、死依赖成批、两次漏 lockfile 断构建、两次用户可见的图片回归。**v1.0 与重构期**（批次 2，2025-09 + 2026-05 初）以两个 2.5k+ 行 mega commit 上线 AI 助手，埋下历史覆盖丢数据与零鉴权两个最严重的结构性隐患；但 2026-05 的模块化拆分 + 测试工具链标志着工程方式的转折。**成熟期**（批次 3-7，2026-05 中之后）质量显著且持续地高：Postgres 持久化系列的事务/行锁/契约测试、可靠性系列的对抗性评审循环（spread→LWW→room_version 的教科书式收敛、坦诚承认 "total order" 言过其实并根治）是整个仓库最好的工程样本。

### 历史上的高危问题（7 个，均已在后续 commit 修复）

| 引入 | 问题 | 修复 |
|---|---|---|
| `2a14e96` | base64 图片走 socket.io 超默认 1MB 缓冲即断连，照片发送即失败 | `130c338`/`91197fa` |
| `d0c6113` | 双重 `data:` 前缀致全部图片渲染失败约两周 | `e811f66` |
| `d0c6113` | 分块上传无大小/数量/超时限制可内存 DoS，稀疏分块可崩进程 | `5214626`（10MB/256 块上限） |
| `32bd7e7` | AI 流结束用截断的 40 条上下文 DEL+RPUSH 覆盖整个房间历史，旧消息永久丢失 | `e10f4a0` 静默缓解 → `48dafbf` 定点 upsert 根治 |
| `32bd7e7` | `edit_message`/`delete_message` 零鉴权，任何注册客户端可改删任意房间任意消息 | `968b6df`（authorizeRoomAction，约 8 个月后） |
| `a940c25` | Postgres CHECK 缺 'voice'，语音消息在 PG 模式下发送必失败（带 CI 红灯合入） | `a0d15f6` |
| `f905702` | media_assets FK 先于消息插入，PG 模式媒体上传必 500，上线即不可用 | `ecfe332`（当日） |

注意一个模式：7 个高危里有 3 个（a940c25、f905702 ×2 上线即坏类）是**没在 Postgres 生产配置下端到端验证就合入**造成的——contract 测试的 fake 不模拟 FK/CHECK 约束，真实引擎验证缺位。

### 疑似仍在现行代码中的问题（按优先级，需以当前 HEAD 核查为准）

1. **KaTeX `trust: true` XSS**（`09be082` 引入、`e811f66` 延续）——恶意消息可构造 `\href{javascript:...}` 点击型 XSS；七批评审均未见修复记录，建议立即核查 MarkdownContent 现状。
2. **`/api/ai-role-draft` 无鉴权无限流**（`dd294b8`）——每次调用烧真实 OpenRouter 费用，可被脚本刷爆账单。
3. **`get_room_members` 不做 hasRoomAccess**（`f905702`）——泄露在线成员 clientId+昵称，而 clientId 即本应用的 bearer 凭证。
4. **未知定价模型绕过 premium 二次确认**（`e8c008f`）——pricing 缺失默认按"非 premium"，成本控制方向选反。
5. **AI 上下文 1000 条无 token 预算**（`7dbd20d`）——长房间输入成本激增，极端下可能超模型上下文报错。
6. **媒体 presign PUT 无频控、未 complete 对象无 GC**（`f905702`，`4a91cdb` 后签名更不锁大小/类型）——存储滥用与泄漏敞口。
7. **Redis 路径房间字段合并非原子**（`968b6df` 引入，`0a79128` 仅原子化版本号）——并发 rename/settings 可互相覆盖字段；prod 走 PG 不受影响，Redis-only 部署受影响。
8. 其余中等遗留：`bf9ada3` member_sockets 非原子可误踢在线成员；`42e65e4` Redis readRoomsByUser O(总房间数)；`a0b8679` 缓存 30s 陈旧窗口（86377a2 仅串行化主链路）；`48dafbf` 启动恢复多实例下误杀其他实例在途流；`02cd7cf` ack 把"消息已存"与"AI 启动失败"混为一位致已存消息被标失败；`9d30c79` CHECK 收窄在启动 DDL，含遗留行的环境启动即崩。

### 流程模式（跨阶段反复出现）

1. **巨型多主题 commit 与名实不符的 message**：`76c669b`/`32bd7e7`/`d0c6113`/`968b6df`/`f905702`（夹带未声明的昵称特性）；test 标题夹带生产变更（`1919bc3`/`4861002`/`b2d1210`）；refactor 静默改行为（`e10f4a0`）；声称不存在的改动（`026bbea` 的 CORS）；未声明的回滚（`4b8059b` 回滚 PR #10）。这直接削弱历史可审计性——本次评审中多次需要靠 diff 反推真实意图。
2. **"先上线后修复"的试错循环**：manualChunks TDZ 四连修（净产出为零）、Fly CI 三连修、键盘 viewport 四次方向翻转（其中 cd96e8c 方案只活了 2 小时）、语音消息五连击、媒体存储当日双热修。共同根因：合入前缺本地生产构建、真机、Postgres 生产配置三类验证。正面例子是 41a6d3e 与 room-reliability 系列把试错沉淀成了复盘文档。
3. **dev/master 双分支工作流**留下 4 对内容相同的重复 commit 与成对 merge（批次 4），直到 `9a8a4c6` 收拢，永久污染了 master 历史。
4. **依赖卫生**：图标包×3、react-markdown/remark/rehype 全家桶装而不用；`@types/socket.io-client` 等过期类型包；两次漏 lockfile/依赖直接断构建。
5. **改进趋势真实存在**：批次 3 起契约/E2E/smoke 测试成为常态并延续到 HEAD；`0a79128` 引用外部评审、承认前一方案错误并根治，配合 1e4671b/7238ebe 的文档同步，是全仓库最佳实践样本。

### 架构演进评价

- **存储**：单 list → 按房间分 key → Redis/Postgres 双 store + Composite 缓存 → message_version/room_version 版本化。终态合理，版本计数模式已在两个子系统复用成型。
- **媒体**：base64 进消息体 → 分块上传 → 私有对象存储+签名 URL → 统一 media 资产。方向正确，但走了"图片刚出库、语音 base64 又入库"（`a940c25`）的弯路，约一个月后才由 `f905702` 收敛。
- **排序一致性**：wall-clock timestamp → LWW updatedAt（`6782f7c`）→ 全路径打点（`b249860`）→ 行级单调版本（`0a79128`）。教科书式收敛，每步都有测试与文档背书。
- **鉴权**：零鉴权 → creator 检查 → owner/admin/member 角色 + `authorizeRoomAction` 集中授权（`968b6df`）。结构已对，但身份模型自始至终是"clientId 即凭证"且明文进 URL/query/日志——这是当前安全水位的根本上限，上述遗留问题 2/3 都与之相关。

---

## 现行代码核验与修复跟进（起始 HEAD `7214df1`，2026-06-11）

> 本节为对上文"疑似仍在现行代码中的问题"清单的逐条复核，起始核验对象是本仓库当时 HEAD（`7214df1`）。评审基数为 163 个 commit（`5a991ae → 7238ebe`）。

### 清单逐条核验

| # | 遗留问题 | 状态 | 现场证据（HEAD `7214df1`） |
|---|---|---|---|
| 1 | KaTeX `trust: true` XSS | ✅ 已修复 | `client-heroui/src/components/MarkdownContent.tsx` 改为 `trust: false`，并新增 `MarkdownContent.test.tsx` 防回归 |
| 2 | `/api/ai-role-draft` 无鉴权无限流 | ✅ 已修复 | 端点现要求 `clientId`、校验该 client 可访问至少一个房间，并按 clientId/IP 做滑窗限流 |
| 3 | `get_room_members` 不做 hasRoomAccess | ✅ 已修复 | `get_room_members` 现要求 socket 已注册，并通过 `hasRoomAccess` 后才返回在线成员 |
| 4 | 未知定价模型绕过 premium 二次确认 | ✅ 已修复 | 服务端和客户端现将缺失/非有限输出价格视为 premium，只有明确已知且不超过阈值的模型免二次确认 |
| 5 | AI 上下文 1000 条无 token 预算 | ✅ 已修复 | `selectAIHistory` 现先按消息数再按 `AI_MAX_CONTEXT_TOKENS` 估算预算裁剪，默认 32000 token，并保留最新消息 |
| 6 | 媒体 presign PUT 无频控、未 complete 对象无 GC | ✅ 已修复 | 创建上传 URL 现按 clientId/IP 限流，并把 pending upload 写入 durable store；complete 必须匹配 pending 元数据，过期 pending 会被后台 claim 后 best-effort 删除对象 |
| 7 | Redis 路径房间字段合并非原子 | ✅ 已修复 | `updateRoomName`/`updateRoomSettings` 现分别走 Lua 原子读-校验-字段合并-写回脚本，不再用 TS 层 `getRoomById` → 整房间覆盖 |
| 8 | 其余中等遗留（`bf9ada3`/`42e65e4`/`a0b8679`/`48dafbf`/`02cd7cf`/`9d30c79`） | ✅ 已修复 | `bf9ada3`、`42e65e4`、`a0b8679`、`48dafbf`、`02cd7cf`、`9d30c79` 均已修复并补回归测试 |

第 1–8 条已在本轮跟进中修复并补充回归测试。

### 核验中发现的、本仓库特有的新增隐患（不属于原清单）

复核中发现本仓库存在一个无鉴权的本地媒体端点，需单列记录；后续复查修正了原判断中的一处过度推断：

- **`/api/media/local-objects/:encodedObjectKey` PUT/GET 的注册条件过宽。** 原核验称配置 S3/Tigris 时也会注册该端点；重新对照当前代码后，这一点不准确：当前 `S3MediaObjectStorage` 未实现 `getMediaObject`，因此常规生产 S3 配置不会注册该路由。真正成立的问题是路由仅以 `if (mediaObjectStorage.getMediaObject)` 判断能力，无 `NODE_ENV` 或具体存储类型限制；一旦后续非本地存储实现 `getMediaObject`，或生产误注入 `LocalMediaObjectStorage`，该无鉴权 PUT/GET 就会暴露对象写入与同源返回风险。

### 修复记录

- 2026-06-11：已将 `/api/media/local-objects/:encodedObjectKey` 限制为仅在非 production 且存储实例为 `LocalMediaObjectStorage` 时注册，并新增回归测试覆盖“有 `getMediaObject` 的非本地存储实现不得暴露该路由”。该修复保留本地开发上传/下载能力，同时移除宽泛能力判断带来的未来生产暴露面。
- 2026-06-11：已将 KaTeX 渲染配置从 `trust: true` 改为 `trust: false`，阻断用户公式里的受信命令生成 `javascript:` 等危险链接；新增 `MarkdownContent.test.tsx` 锁定该配置，避免后续回归。
- 2026-06-11：已为 `/api/ai-role-draft` 增加 `clientId` 必填、房间访问关系校验和每 clientId/IP 10 分钟 5 次的服务端限流；客户端生成 AI 角色草稿时会带上本地持久化 clientId，服务端测试覆盖缺失 client、无房间访问权和触发限流三种拒绝路径。
- 2026-06-11：已为 socket `get_room_members` 补上注册校验和 `hasRoomAccess` 房间访问校验，避免任意已连接客户端枚举其它房间在线成员；新增 `roomHandlers.test.ts` 用例覆盖未注册和非成员访问拒绝路径。
- 2026-06-11：已调整服务端与客户端 premium 模型判定：缺失 pricing 或输出单价不是有限数值时默认需要 premium 二次确认，防止自定义/未知价格模型绕过确认；两端测试均覆盖缺价模型仍被标记为 premium，且 `$10/M out` 明确边界仍不触发。
- 2026-06-11：已为 AI 历史上下文增加近似 token 预算 `AI_MAX_CONTEXT_TOKENS`（默认 32000）：`selectAIHistory` 在保留 retry/edit 语义和消息数上限后，从最新消息向前收敛到预算内，并保证至少保留最新消息；handler 日志会记录上下文估算 token 和预算，单元测试覆盖预算截断与单条超预算场景。
- 2026-06-11：已为媒体上传初始化增加每 clientId/IP 10 分钟 20 次限流，并把每个 presign upload 记录为 durable `pending_media_uploads`；complete 阶段必须命中并匹配 pending 元数据，成功或持久化失败都会删除 pending，过期 pending 会由后台 sweeper claim 后 best-effort 删除对象，避免未 complete 对象长期泄漏。
- 2026-06-11：已将 Redis `updateRoomName` 和 `updateRoomSettings` 改为专用 Lua 脚本，在 Redis 内部完成当前房间读取、权限/字段校验、局部字段合并、`roomVersion` 自增和写回；新增 race stub 测试覆盖 rename 与 settings 并发时不再互相覆盖字段。
- 2026-06-11：已将 Redis `updateRoomMemberCount` 改为单个 Lua 脚本，join/leave、`member_sockets` 计数、空 socket set 删除和在线成员集合更新在 Redis 内部原子完成；新增测试确保离开路径不再对 `member_sockets` 做 TS 层非原子 `sCard`。
- 2026-06-11：已将 Redis `readRoomsByUser` 从 `hKeys('rooms')` 全量扫描改为读取 `user:{clientId}:rooms` owner 索引，再按 id 批量读取房间；读到不存在、JSON 损坏或 creator 不匹配的 stale 索引会自动 `SREM` 清理，并新增测试禁止回退到全量 `rooms` hash 扫描。
- 2026-06-11：已将房间消息 Redis 缓存改为随 `messageVersion` 写入和读取校验：版本不匹配或旧版数组 payload 会被丢弃，`CompositeRoomStore` 仅在 durable 读取前后的房间消息版本一致时回填缓存，避免并发写入后旧快照晚到覆盖缓存达 TTL 窗口；新增 Redis payload 校验与读中版本变化不回填的回归测试。
- 2026-06-11：已为 AI streaming placeholder 增加服务端内部 `aiStreamOwnerId` 恢复标记；启动恢复现在只处理当前实例 owner 遗留的 streaming 消息，不再全局把其它实例正在生成的 AI 流标为 error。Postgres 使用专用 `ai_stream_owner_id` 列且不映射到公开 Message，Redis 读取历史/缓存时会剥离内部字段；新增测试覆盖 owner 过滤恢复与 socket 广播不泄露内部 owner。
- 2026-06-11：已拆分 `send_message_and_ask_ai` ack 语义：用户消息 append 成功后，即使 AI placeholder 启动失败也返回 `success: true`、`userMessage`、`aiStarted: false` 和 `aiError`，前端 socket wrapper 不再因缺少 `aiMessageId` reject，MessageInput 会确认已保存的乐观消息而不是标记 failed；新增服务端、socket wrapper 和组件回归测试覆盖该部分成功场景。
- 2026-06-11：已在 PostgreSQL 启动 DDL 收窄 `room_messages.message_type` CHECK 前，先将旧版 `image`/`voice`/`audio`/`video` 行归一为 `media`；新增 DDL 顺序测试确保先 drop 旧约束、再归一化遗留行、最后 add 新约束，避免含遗留媒体行的环境启动失败。

---

*核验与文档清理：Claude Code + Claude Fable 5*
