# RoomTalk 面试准备资料

本文档帮助你在技术面试中讲解 RoomTalk 项目。内容覆盖系统设计、技术决策、踩过的坑、扩展方案和常见面试追问。

---

## 一、30 秒项目介绍

> RoomTalk 是一个实时聊天系统，支持多人房间聊天、AI 流式助手、私有媒体上传、贴纸、语音转写和移动端优化。前端是 React + TypeScript + Vite，后端是 Node.js + Express + Socket.IO，持久化支持 Redis 和 PostgreSQL 双模式，媒体存储用 S3 兼容对象存储。部署在 Fly.io，CI/CD 通过 GitHub Actions 自动化。

面试官听完会根据兴趣追问，你控制节奏，引导到你最熟的方向。

---

## 二、系统架构

### 画架构图时这样画

```text
                    ┌──────────────┐
                    │   Client     │
                    │  React/Vite  │
                    └──────┬───────┘
                           │ HTTPS / WSS
                    ┌──────▼───────┐
                    │  Load Balancer│ ← TLS termination, sticky session
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │    Node.js Server       │
              │  Express + Socket.IO    │
              │                         │
              │  ┌─────────────────┐    │
              │  │ CompositeRoom   │    │
              │  │ Store           │    │
              │  └──┬──────────┬───┘    │
              └─────┤          ├────────┘
                    │          │
         ┌──────────▼──┐  ┌───▼──────────┐
         │ PostgreSQL   │  │    Redis      │
         │ (durable)    │  │ (realtime +   │
         │ rooms,       │  │  sessions,    │
         │ messages,    │  │  presence,    │
         │ members,     │  │  Socket.IO    │
         │ media assets │  │  adapter,     │
         │ auth, ...    │  │  msg cache)   │
         └──────────────┘  └──────────────┘

              ┌──────────┐    ┌───────────┐
              │ S3/Tigris│    │ AI APIs   │
              │ (media)  │    │ DeepSeek  │
              └──────────┘    │ Anthropic │
                              │ OpenAI    │
                              │ OpenRouter│
                              └───────────┘
```

### 关键设计点（面试必讲）

**1. CompositeRoomStore — 双存储分层**

这是整个后端最核心的抽象。一个 `CompositeRoomStore` 组合了三个子存储：

- `DurableRoomStore`：持久数据（房间、消息、成员、媒体资产、认证）。可以是 Redis 或 PostgreSQL，运行时通过环境变量切换。
- `RealtimeRoomStore`：始终是 Redis。管理 socket session、在线成员、临时状态。服务重启后自动重建。
- `RoomMessageCacheStore`：可选的 Redis TTL 缓存，在 PostgreSQL 模式下减少数据库读压力。

面试时这样讲：
> 我们把存储拆成"持久"和"实时"两层。持久层可以在 Redis 和 PostgreSQL 之间切换——开发用 Redis 快速迭代，生产切到 PostgreSQL 保证数据安全。实时层始终用 Redis 因为它本来就是内存存储，做 session 和 presence 正好。中间加了一层消息缓存，cache miss 才查 PostgreSQL，命中率在 90%+ 因为聊天场景下用户大概率读最近的消息。

**2. Socket.IO 多实例扩展**

```text
Client A ──WSS──▶ Instance 1 ──Redis pub/sub──▶ Instance 2 ──push──▶ Client B
```

用 `@socket.io/redis-adapter`，所有 Socket.IO 事件通过 Redis pub/sub 同步到所有实例。客户端不感知自己连的是哪个实例。

面试追问：**sticky session 为什么必须？**
> Socket.IO 握手分两步：先发几个 HTTP long-polling 请求，再升级到 WebSocket。如果这几个 HTTP 请求被负载均衡分到不同实例，握手就断了。所以 ALB 必须开 stickiness，保证同一个客户端的请求始终到同一台机器。握手完成后 WebSocket 是长连接，自然不会飘。

**3. AI 流式响应**

```text
Client → ask_ai event → Server → AI Provider (streaming) → ai_chunk events → Client
```

- 服务端用 OpenAI SDK 的 stream API，逐 chunk 读取，通过 Socket.IO 实时推给客户端。
- 消息创建时 `status: 'streaming'`，完成后改为 `'complete'`，出错改为 `'error'`。
- 服务器重启时，`aiStreamRecovery` 扫描所有 `status = 'streaming'` 的消息，标记为 `'error'`，避免僵尸流。

面试追问：**为什么不用 SSE？**
> 已经有 Socket.IO 长连接了，再开 SSE 是多余的连接。Socket.IO 事件模型可以区分不同房间、不同用户的 AI 流，比 SSE 灵活。而且 AI 流需要和消息历史、状态同步走同一个通道，不适合单独开一个 HTTP 流。

**4. 媒体上传流程 — Presigned URL**

```text
Client                    Server                     S3
  │                         │                         │
  │── request upload URL ──▶│                         │
  │                         │── generate presigned ──▶│
  │◀── presigned PUT URL ──│                         │
  │                         │                         │
  │──── PUT file directly ─────────────────────────▶ │
  │                         │                         │
  │── confirm upload ──────▶│                         │
  │                         │── create MediaAsset ──▶ │
  │◀── message with asset ─│                         │
```

面试时这样讲：
> 文件不经过我们的服务器。客户端先向服务器请求一个临时上传 URL（presigned URL，有效期 15 分钟），然后直接上传到 S3。上传完成后通知服务器，服务器创建 metadata 记录。下载也是类似的，服务器生成临时读取 URL 返回给客户端。这样服务器不处理大文件流量，带宽和 CPU 都省了。

面试追问：**presigned URL 安全吗？**
> URL 本身包含签名，只对特定 bucket/key 有效，有过期时间。泄露了也只能上传到这一个位置，不能读其他文件。而且我们的 bucket 设置了 block all public access，没有 presigned URL 什么都看不到。

---

## 三、技术难点与解决方案

### 难点 1：移动浏览器 WebSocket 断连恢复

**问题**：手机切后台、锁屏、切网络后，WebSocket 连接可能被浏览器挂起甚至断开。用户切回来后：
- 消息停止接收（连接已死但没有触发 disconnect 事件）
- 在线成员数不准确
- 房间状态过时

**解决方案** — 多层恢复机制：

1. **Page Visibility API**：监听 `visibilitychange`，页面恢复前台时检查连接健康度。
2. **主动重连判断**：不是无脑重连。用 `ensureRoomJoined` 先检查当前房间是否仍然 joined，避免重复 join 导致成员数翻倍。
3. **in-flight 请求复用**：短时间内多次恢复（快速切换前后台）复用同一个恢复请求，不重复发。
4. **恢复状态延迟显示**：健康连接下的 rejoin 是毫秒级的，只有超过 400ms 未完成才显示"重连中"，避免每次切前台闪一下转圈。
5. **密码房复用**：会话内记住已验证的密码，恢复时自动带上，不让用户重新输入。

面试时这样讲：
> 移动端 WebSocket 恢复是我们踩坑最多的地方。核心思路是"不信任连接状态"——页面回到前台就检查，但不无脑重连。我们有一个 `ensureRoomJoined` 做幂等 rejoin，加上 in-flight 去重和延迟转圈，用户基本感知不到断连过程。

### 难点 2：Redis → PostgreSQL 持久化迁移

**问题**：系统最初用 Redis 做全量持久化。Redis 虽然快，但：
- 数据全在内存，成本随数据量线性增长
- 没有关系约束，数据一致性靠应用层保证
- 备份和恢复不如关系型数据库成熟

**解决方案** — 渐进式迁移，不停服：

1. 抽象出 `DurableRoomStore` 接口，`RedisStore` 和 `PostgresStore` 各自实现。
2. `CompositeRoomStore` 组合 durable + realtime，切换 durable 实现只需要改环境变量。
3. 写了幂等迁移脚本 `migrate:redis-to-postgres`，支持 dry-run。
4. 加了 `smoke:persistence` 安全测试，保护不会误连生产 Redis。
5. 回滚是纯配置切换：`PERSISTENCE_STORE=redis`，因为迁移期间不删 Redis 数据。

面试时这样讲：
> 我们做了一个 Store 接口抽象层，Redis 和 PostgreSQL 各自实现相同接口。上层代码完全不知道底下是哪个数据库。切换只需要改一个环境变量，回滚也是。迁移脚本是幂等的，可以反复跑。这样我们在生产环境做了零停机迁移。

### 难点 3：房间状态同步与一致性

**问题**：多个客户端同时操作房间设置（改名、设密码、改发言时间段），客户端的房间对象可能过时。

**解决方案**：

1. **整体替换而非合并**：服务端返回完整的 room 对象，客户端收到后整体替换本地状态，不做字段级 merge。
2. **`room_version` 单调版本号**：PostgreSQL 行级自增，客户端按 version 比较新旧，不依赖时间戳（时钟漂移不可靠）。
3. **ack read-your-write**：客户端修改设置后，ack 返回最新的 room 对象，立即更新本地，不等广播。

面试追问：**为什么不用 CRDT？**
> 房间设置是低频操作，last-write-wins 够用。CRDT 适合高频并发编辑（协同文档），引入复杂度不值得。我们的 version 号保证了排序，整体替换保证了最终一致。

### 难点 4：AI 多 Provider 抽象

**问题**：接入了 DeepSeek、Anthropic、OpenAI、OpenRouter 四个 AI 提供方，每个的 SDK、定价、限流策略不同。

**解决方案**：

```text
aiModels.ts   — model registry: model ID → { provider, apiModel, pricing, ... }
aiClients.ts  — client factory: provider → SDK client instance
aiHandlers.ts — streaming logic: provider-agnostic chunk forwarding
```

- `aiModels.ts` 维护一个 model registry，把用户可见的 model ID 映射到具体的 provider 和 API model name。
- `aiClients.ts` 按 provider 类型创建对应的 SDK 客户端（OpenAI SDK 兼容 DeepSeek 和 OpenRouter，Anthropic 用官方 SDK）。
- 流式处理层统一把不同 SDK 的 chunk 格式转成统一的 `ai_chunk` 事件推给客户端。

面试时这样讲：
> 我们用了一个 model registry + client factory 模式。添加新的 AI 提供方只需要在 registry 注册模型、在 factory 加一个 case。流式处理是 provider-agnostic 的，不同 SDK 的 chunk 格式在服务端统一转换。客户端完全不知道后端用的是哪个 provider。

---

## 四、扩展性讨论

面试官喜欢追问"如果用户量增长 100 倍怎么办"，按这个思路答：

### 当前瓶颈在哪

| 组件 | 瓶颈 | 扩展方案 |
|---|---|---|
| 单实例 Node.js | CPU 和并发连接数 | ECS auto scaling，水平扩多个 task |
| PostgreSQL 读 | 消息历史查询 | 读副本 + Redis 缓存（已有 `RoomMessageCacheStore`） |
| PostgreSQL 写 | 高频消息写入 | 写入批量化 / 异步队列 / 分表 |
| Redis | 内存上限 | ElastiCache 升级 / cluster mode |
| S3 | 基本无瓶颈 | S3 自动扩展，无需操心 |

### 水平扩展方案

```text
现在:  1 个 ECS task
10x:   2-4 个 task, Redis adapter 广播, ALB sticky
100x:  按房间做一致性哈希路由, 每个 task 负责一组房间
       PostgreSQL 读副本 + 消息分表
       独立的 AI 请求队列 (SQS + worker)
```

### 如果要支持 10 万并发连接

1. 每个 Node.js 进程约能处理 5-10K WebSocket 连接
2. 10 万需要 10-20 个 ECS task
3. Redis adapter pub/sub 在这个规模开始有压力，可以切到 Redis Streams 或 Kafka
4. 消息持久化改成异步写入（先 ack 客户端，后台批量写 PostgreSQL）

面试时**不要主动讲到 Kafka 级别**，除非面试官追问。先讲简单方案，被追才讲复杂方案，展示你知道什么时候该用什么。

---

## 五、安全设计

| 安全点 | 实现 |
|---|---|
| 传输加密 | HTTPS/WSS，PostgreSQL TLS，Redis TLS |
| 认证 | UUID clientId + token hash，可选 Google OAuth |
| 授权 | 房间成员角色（owner/admin/member），`hasRoomAccess` 检查 |
| 密码房 | bcrypt 哈希存储，验证后 ack 返回 token |
| 媒体隔离 | S3 bucket block all public access，presigned URL 有过期时间 |
| API 限流 | AI 角色草稿按 IP 限速 10 分钟窗口 |
| Socket 注册 | 客户端必须先 `register` 发送 clientId + auth token 才能操作 |
| 环境变量 | secrets 在 SSM Parameter Store / Fly secrets，不进代码 |

面试追问：**clientId 是 UUID，不是登录系统，怎么防冒充？**
> clientId 绑定了 auth token（SHA-256 hash 存储）。注册 socket 时必须同时提供 clientId 和 token，token 不匹配就拒绝。可选地可以绑定 Google 账号做强身份认证。纯 UUID 模式下安全等级类似于 session token——只要不泄露就安全。

---

## 六、测试策略

```text
层级                  工具               覆盖内容
──────────────────────────────────────────────────
单元测试 (server)     Node test runner   store contract, message domain,
                                         AI models, auth, media storage
单元测试 (client)     Vitest + RTL       component rendering, hooks,
                                         state management, i18n
E2E (Redis mode)      Playwright         room flows, message flows,
                                         AI/media/sharing, mobile core,
                                         multi-client realtime
E2E (Postgres mode)   Playwright         persistence-mode regression
i18n 完整性           check:i18n         build 时校验所有翻译 key
```

面试时这样讲：
> 我们用了四层测试。单元测试覆盖核心业务逻辑，E2E 用 Playwright 跑真实浏览器测试用户可见行为。因为有 Redis 和 PostgreSQL 两种持久化模式，E2E 分别跑两套。CI 里还有一个 i18n key 完整性检查，防止加了新 UI 文案忘记翻译。

---

## 七、你做了什么（STAR 法）

面试官会问"你在这个项目里具体做了什么"。准备 2-3 个 STAR 故事：

### 故事 1：PostgreSQL 持久化迁移

- **Situation**：项目最初用 Redis 做全量持久化，数据增长后内存成本上升，且缺少关系约束。
- **Task**：在不停服的情况下迁移到 PostgreSQL。
- **Action**：设计了 Store 接口抽象层，实现 Redis 和 PostgreSQL 双实现，写了幂等迁移脚本和安全 smoke 测试，通过环境变量切换实现零停机迁移。
- **Result**：成功迁移，回滚方案验证通过，数据一致性 100%，PostgreSQL 模式上线后内存成本降低（Redis 只存实时状态）。

### 故事 2：移动端 WebSocket 可靠性

- **Situation**：用户反馈手机切后台回来后消息丢失、需要刷新。
- **Task**：在不改变 Socket.IO 架构的前提下，解决移动浏览器的连接恢复问题。
- **Action**：基于 Page Visibility API 实现多层恢复机制：幂等 rejoin、in-flight 去重、延迟指示器、密码房自动复用。每个机制都有对应的 E2E 测试覆盖。
- **Result**：移动端用户不再需要手动刷新，恢复过程对用户透明，相关 bug 报告归零。

### 故事 3：AI 多 Provider 集成

- **Situation**：最初只接了 OpenRouter 做中转，但部分模型需要直连官方 API 才能使用 prompt caching 等特性。
- **Task**：支持 DeepSeek、Anthropic、OpenAI 直连 + OpenRouter 路由，同时保持用户侧的简单体验。
- **Action**：设计 model registry + client factory 模式，流式处理层 provider-agnostic，支持运行时动态切换模型和 provider。前端展示 usage/cost 元数据，高价模型需要二次确认。
- **Result**：支持 10+ 模型，添加新 provider 只需改配置文件。DeepSeek 直连后 prompt caching 命中率 60%+，AI 调用成本降低约 40%。

---

## 八、常见追问与参考回答

**Q: 为什么用 Socket.IO 而不是原生 WebSocket？**
> Socket.IO 提供了开箱即用的自动重连、房间/命名空间、ack 回调、Redis adapter 多实例广播。原生 WebSocket 这些都要自己实现。对于聊天场景，Socket.IO 省了大量样板代码。

**Q: 为什么不用微服务架构？**
> 当前规模不需要。单体的开发、部署、调试效率远高于微服务。如果将来 AI 处理成为瓶颈，可以把 AI worker 拆出来用队列解耦，但现在拆了是过度设计。

**Q: Redis 挂了怎么办？**
> 实时状态（在线成员、session）丢失，用户需要重连，服务端重建。持久数据在 PostgreSQL，不受影响。消息缓存丢失只是多查一次 PostgreSQL，有性能影响但不丢数据。

**Q: 数据库死锁怎么处理？**
> 当前消息写入是 append-only（INSERT），不存在行锁竞争。房间设置更新用 `room_version` 行级版本号 + `UPDATE ... RETURNING` 原子操作，失败重试。PostgreSQL 的 MVCC 天然避免了读写阻塞。

**Q: 如何保证消息顺序？**
> 每条消息有 server-side timestamp 和 position（单调递增）。客户端按 position 排序显示。不依赖客户端时间戳，因为多设备间的时钟可能不同步。

**Q: 如果让你重新设计，会改什么？**
> 三件事：
> 1. 一开始就用 PostgreSQL 而不是 Redis 做持久化，省去后来的迁移工作。
> 2. Socket 事件的错误返回用结构化错误码，而不是字符串匹配（目前还有少量 regex 匹配遗留）。
> 3. 前端状态管理用 Zustand 或类似库，MessagePage 承担了太多状态编排，组件间共享状态靠 props 传递层级太深。

**Q: 怎么处理大量消息的性能？**
> 两个层面：
> 1. 存储层：消息分页加载（`readMessagePageByRoom`，默认 80 条一页），不一次性加载全部历史。
> 2. 渲染层：React 列表虚拟化可以进一步优化（当前未做，是已知改进点）。
> 3. 缓存层：Redis `RoomMessageCacheStore` 缓存最近消息，cache hit 避免查 PostgreSQL。

**Q: 项目里遇到最难的 bug 是什么？**
> 移动端切后台回来后成员数翻倍。原因是 visibility change 触发重连，重连后 re-join 房间，但旧的 socket 还没断开，服务端认为是两个不同的连接。修复方法是在 `updateRoomMemberCount` 里按 clientId 去重，同一个 clientId 的多个 socket 只算一个成员。

---

## 九、技术选型对比（面试白板题素材）

### 实时通信方案对比

| 方案 | 延迟 | 双向 | 断线重连 | 多实例 | 适合场景 |
|---|---|---|---|---|---|
| HTTP Polling | 高 (秒级) | 否 | N/A | 天然 | 仪表盘刷新 |
| SSE | 低 | 单向 | 自动 | 需要消息总线 | 通知推送 |
| WebSocket | 极低 | 双向 | 需实现 | 需要 adapter | 聊天、游戏 |
| Socket.IO | 极低 | 双向 | 内置 | Redis adapter | 聊天（我们的选择） |

### 数据库选型

| | Redis | PostgreSQL | MongoDB |
|---|---|---|---|
| 数据模型 | KV / Hash / List | 关系型 | 文档型 |
| 一致性 | 最终一致 | 强一致 (ACID) | 可调一致性 |
| 查询能力 | 基础 | SQL 完整 | 灵活查询 |
| 适合 | 缓存、session、实时状态 | 持久化、关系数据 | 非结构化数据 |
| 我们的用法 | 实时层 | 持久层 | 未使用 |

### 部署方案对比

| | Fly.io | AWS ECS Fargate | AWS EKS | Vercel |
|---|---|---|---|---|
| 运维复杂度 | 低 | 中 | 高 | 极低 |
| WebSocket 支持 | 原生 | ALB sticky | Ingress 配置 | 不支持长连接 |
| 成本 (低流量) | ~$5-30/月 | ~$50-60/月 | ~$80+/月 | 不适用 |
| 扩展上限 | 中 | 高 | 极高 | N/A |
| 适合阶段 | MVP / 小团队 | 生产化 | 大规模微服务 | 纯前端/Serverless |

---

## 十、项目数据与指标（准备一些数字）

面试里有具体数字会更有说服力：

- 代码规模：服务端 ~60 个 TypeScript 源文件，客户端 ~50 个组件/hook/工具
- 测试覆盖：276 个服务端测试 + 客户端 Vitest 测试 + 8 个 Playwright E2E spec
- 支持语言：5 种（en/zh/hi/ja/ko）
- AI 模型：10+ 可选，4 个 provider 直连
- 持久化模式：2 种（Redis / PostgreSQL），运行时可切换
- 消息类型：4 种（text / ai / media / sticker）
- 媒体类型：4 种（image / video / audio / file）
- 部署：push to master 自动 CI/CD，~3 分钟完成

---

## 十一、加分项 — 展示工程素养

面试不只看技术实现，也看工程习惯。可以主动提这些：

1. **渐进式迁移**：Redis → PostgreSQL 不是一刀切，而是接口抽象 + 环境变量切换 + 回滚方案。
2. **防误操作**：persistence smoke test 只允许连名字含 `test` 或 `e2e` 的数据库，不可能误连生产。
3. **文档即代码**：`.env.example` 是配置的 single source of truth，README 引用它而不是重复列表。
4. **CI 守门**：部署前校验必需的 Fly secrets，缺了就阻断，不是靠运行时 crash 发现。
5. **幂等设计**：迁移脚本可以反复跑，room upsert + message 按 ID 去重。
