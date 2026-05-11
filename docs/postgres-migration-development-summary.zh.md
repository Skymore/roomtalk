# PostgreSQL 迁移开发复盘

## 背景

本轮目标是把原来只依赖 Redis 的房间、消息历史和 AI 成本数据，迁移到 PostgreSQL 作为持久事实来源，同时继续保留 Redis 负责 realtime/session/cache 类职责。

最终线上切换采用的是停服最终迁移：

1. 先在代码里支持 Redis 模式和 PostgreSQL 模式并存。
2. 新建 PostgreSQL。
3. 从 Redis 迁移历史数据到 PostgreSQL。
4. 停止生产服务，做最后一次 Redis 到 PostgreSQL 的全量同步。
5. 切换 `PERSISTENCE_STORE=postgres`。
6. 启动服务并验证。

这份文档记录我们是怎么开发、怎么验收、怎么迁移的，也说明如果这是严格生产服务，应该如何设计不停服迁移。

## 开发协作方式

### 1. 先讨论方案，再分阶段执行

开发不是直接开写，而是先和 Codex 讨论 Redis/PostgreSQL 如何分工：

- PostgreSQL 保存 durable data：rooms、message history、AI cost total、AI message status。
- Redis 保留 realtime data：Socket.IO adapter、online members、socket/client mapping、短 TTL message cache。
- “正在进行”的对话不靠用户是否在线判断，而靠消息状态判断，例如 `streaming`、`pending`。
- 缓存一致性采用 cache-aside + 写后失效；PostgreSQL 是事实来源，Redis cache 失效失败时依赖 TTL 收敛。

随后写入计划文档：[docs/postgres-persistence-plan.md](./postgres-persistence-plan.md)，把工作拆成阶段，并为每一阶段设定验收标准。

### 2. 每一步代码改动后做 Claude Code review

每个实现切片后，都通过本机 zsh 登录态调用 Claude Code Opus 4.7 做只读 review。review 重点不是风格，而是正确性：

- 是否会丢消息。
- 是否会重复写入。
- Redis/PostgreSQL 是否存在一致性窗口。
- AI streaming 生命周期是否可靠。
- retry/edit/clear/delete 是否破坏历史语义。
- 失败路径是否会广播未落库的消息。

Claude review 发现过几类关键问题，并在后续切片中修正：

- AI streaming 用旧 snapshot 保存 placeholder/final，会覆盖并发写入。
- Redis `LRANGE`/`DEL`/`RPUSH` 组合不是原子操作。
- retry 第一条历史消息时不应该先清空整个房间。
- 普通消息、图片消息如果 append 持久化失败，不应该继续广播 socket 事件。

这种流程的价值是：Codex 负责实现和本地验证，Claude Code 站在 review 视角寻找数据一致性和并发边界问题。

## 阶段、验收标准和 Commit

### 阶段 1：计划和存储抽象

范围：

- 编写 PostgreSQL 持久化重构计划。
- 抽象 `RoomStore`，让 API/socket 不直接依赖 Redis 具体实现。
- 保持 Redis 默认路径不变，避免新架构影响现有部署。

验收标准：

- Redis 模式无需新环境变量即可启动。
- 原有用户行为不变。
- `npm test` 和 `npm run build` 通过。

相关 commit：

- `48dafbf feat: add postgres durable persistence`

### 阶段 2：PostgreSQL durable store

范围：

- 新增 PostgreSQL connection pool。
- 新增 schema 初始化。
- 新增 `PostgresStore`，支持房间、消息、AI cost。
- 新增 composite store：durable 方法走 PostgreSQL，realtime 方法走 Redis。
- 通过 `PERSISTENCE_STORE=postgres` 和 `DATABASE_URL` 启用。

验收标准：

- Redis 默认模式继续通过测试。
- PostgreSQL schema 初始化幂等。
- PostgreSQL store 覆盖 room/message/cost 的读写测试。
- 选择 PostgreSQL 但未配置 `DATABASE_URL` 时启动失败并给出明确错误。

相关 commit：

- `48dafbf feat: add postgres durable persistence`

### 阶段 3：AI streaming 持久化边界

范围：

- AI 开始时先写 `streaming` placeholder，再广播 `new_message`。
- AI 正常结束时更新为 `complete`，写入 content、usage、cost、cache hit metadata。
- AI 失败时更新为 `error`。
- 引入 `upsertMessage`，避免用请求开始时的历史 snapshot 覆盖整个房间。
- retry/edit 保留显式截断历史的语义。
- 启动时把遗留 `streaming` 消息标记为 `error`，避免服务崩溃后永远 loading。

验收标准：

- streaming 过程中刷新，至少能看到 placeholder。
- completion 后历史只有一条最终 AI 消息，不重复。
- retry/edit-and-ask 按预期截断后续历史。
- AI 持久化失败不会继续假装成功。

相关 commit：

- `48dafbf feat: add postgres durable persistence`

### 阶段 4：Redis message cache

范围：

- PostgreSQL 模式下使用 Redis 作为短 TTL room message cache。
- 读路径：cache hit 直接返回，cache miss 读 PostgreSQL 并回填。
- 写路径：PostgreSQL 成功后删除对应 cache。
- cache 失败不阻塞 durable 写入。

验收标准：

- cache hit/miss 返回相同消息顺序和 metadata。
- append/upsert/saveHistory/clear/delete 后不会读到旧消息。
- Redis cache 故障不影响 PostgreSQL durable 写入。

相关 commit：

- `a0b8679 feat: add redis message cache`

### 阶段 5：Redis 到 PostgreSQL 迁移脚本

范围：

- 新增 `npm run migrate:redis-to-postgres`。
- 支持 `--dry-run`。
- 迁移 rooms、message history、AI cost totals。
- 迁移脚本幂等：重复执行不会重复消息，也不会重复累计 cost。

验收标准：

- dry-run 不写 PostgreSQL。
- 正式迁移后 rooms/messages/costs 统计一致。
- 单房间失败会进入 failures，不影响后续房间继续迁移。
- 重跑不会产生重复数据。

相关 commit：

- `f179373 feat: add redis to postgres migration`

### 阶段 6：上线文档和 runbook

范围：

- 更新 README、部署指南、`.env.example`。
- 新增 PostgreSQL rollout runbook。
- 明确 dry-run、正式迁移、切换、验证、回滚、清理窗口。

验收标准：

- 文档包含生产切换命令和回滚命令。
- 明确 PostgreSQL 验证前不能删除 Redis 原始 durable 数据。
- Redis-only 默认路径仍可用。

相关 commit：

- `8e3d78f docs: add postgres rollout runbook`

### 阶段 7：线上迁移和运行时修正

范围：

- Fly 上新建 PostgreSQL app：`message-system-db`。
- attach 到生产 app：`message-system`。
- dry-run 验证 Redis 数据可读。
- 正式迁移一次。
- 停服务机器，做最终迁移。
- 设置 `PERSISTENCE_STORE=postgres` 和 `ROOM_MESSAGES_CACHE_TTL_SECONDS=30`。
- 启动服务并验证。
- 发现大房间消息读取在 256MB 机器上触发 OOM 后，把服务机器提高到 512MB，并持久化到 `fly.toml`。

验收结果：

- 迁移统计：`66` 个 room，`732` 条 message，`66` 条 cost total，失败列表为空。
- `/api/status` 返回 `persistenceStore: "postgres"`。
- 已知用户房间列表返回正常。
- 小房间消息历史返回正常。
- 大房间 `QLqLVGMgII` 返回 `200`，约 `12.5MB`，`117` 条消息。
- Fly app 只保留一台主服务机器，迁移临时机器已清理。

相关 commit：

- `c480560 chore: raise fly memory for postgres`

## 我们实际是如何迁移的

### 准备

1. 新建 PostgreSQL：
   - Fly app：`message-system-db`
   - region：`dfw`
   - PostgreSQL 17 flex image
2. attach 到服务：
   - app：`message-system`
   - database：`message_system`
   - user：`message_system`
   - Fly 自动设置 `DATABASE_URL` secret
3. 保持服务仍然使用 Redis：
   - `PERSISTENCE_STORE=redis`

### Dry-run

先只读 Redis，不写 PostgreSQL，确认迁移统计：

- rooms 可读取。
- messages 可读取。
- costs 可读取。
- failures 为空。

迁移过程中遇到一个真实问题：部分大房间的 Redis message list 超过 Upstash 单响应限制。为完成线上迁移，临时使用逐条 `LINDEX` 读取消息的 wrapper，避免一次 `LRANGE 0 -1` 返回超过 10MB。

### 正式迁移

第一次正式迁移在线执行，用来确认 PostgreSQL 写入路径可用：

- room 使用 upsert。
- message history 按 room 覆盖写入，保证重复执行不重复。
- AI cost total 使用精确赋值，避免重复执行导致成本累加。

### 停服最终同步

为了避免迁移窗口内 Redis 继续产生新写入，本次最终切换采用停服：

1. cordon 服务机器。
2. stop 服务机器。
3. 再跑一次 Redis 到 PostgreSQL 迁移。
4. 设置 `PERSISTENCE_STORE=postgres`。
5. 设置 message cache TTL。
6. uncordon 并 start 服务机器。

### 切换后验证

验证项：

- `/api/status`。
- 用户房间列表。
- 小房间消息历史。
- 大房间消息历史。
- Fly machine 状态。
- Fly logs。

切换后发现 256MB 服务机器在读取大房间历史时 OOM，因此把服务机器和 `fly.toml` 持久配置提升到 512MB。

## 如果这是生产服务，能不能不停服迁移？

可以，但不能用本次这种“停服后再全量覆盖”的方式直接照搬。

本次脚本的关键风险是：按房间覆盖 message history。如果服务不停，迁移过程中用户还在写消息、编辑、删除或 AI streaming，迁移脚本可能用旧快照覆盖新写入。所以真正生产不停服迁移需要改成 expand-migrate-contract 流程。

### 不停服迁移推荐方案

#### 第 0 步：定义可观测指标和回滚目标

迁移前先定义：

- Redis room count。
- Redis message count。
- PostgreSQL room count。
- PostgreSQL message count。
- 每房间 message count。
- 每房间 latest message id / latest createdAt。
- AI cost total 对账。
- PostgreSQL write error rate。
- shadow read mismatch rate。
- cache hit/miss 和 stale read 指标。

回滚目标：

- 切读之前，Redis 仍是事实来源。
- 切读之后一段时间内，Redis durable 数据不删除。
- 出问题时只改配置回 Redis。

#### 第 1 步：先上线 schema 和双写代码

上线兼容版本：

- 读仍然从 Redis 读。
- 写同时写 Redis 和 PostgreSQL。
- message id 必须稳定，PostgreSQL 用 `ON CONFLICT` 做幂等 upsert。
- edit/delete/clear/retry 必须有对应 PostgreSQL 语义，不能只 append。
- AI streaming 开始、完成、失败都双写状态。

更严格的生产方案应使用 outbox 或 retry queue：

- 业务请求先写当前主库 Redis。
- 同步或异步可靠写 PostgreSQL。
- PostgreSQL 写失败进入 retry queue。
- 未清空 retry backlog 前不允许切读。

如果没有 outbox，也至少要保留 Redis 为主，并定期 sweep Redis 到 PostgreSQL 补偿失败写入。

#### 第 2 步：在线回填历史数据

回填历史 Redis 数据到 PostgreSQL，但不能覆盖在线新写入。

推荐做法：

- 以 room 为单位分批迁移。
- message 按 id upsert，不做整房间 delete + replace。
- edit/delete 使用 tombstone 或状态字段表达，而不是物理删除导致难以对账。
- 对每个 room 记录迁移 high-water mark，例如 latest message id / latest createdAt / message version。
- 回填结束后重新读取 room 的 high-water mark，如果迁移期间变了，则对该 room 做增量补偿或重跑。

对 AI streaming 的处理：

- 如果一个 room 有正在 streaming 的 AI 消息，跳过该 room，等待完成后再迁移。
- 或者双写上线后，新的 streaming 已经在 PostgreSQL 有 placeholder；旧的 Redis-only streaming 需要等完成或标记为可恢复失败后再切读。

#### 第 3 步：影子读校验

在读 Redis 的同时，后台抽样读 PostgreSQL 做比对：

- room metadata 是否一致。
- message count 是否一致。
- message order 是否一致。
- message status 是否一致。
- AI metadata、cost、cache hit rate 是否一致。

发现 mismatch：

- 记录 roomId、messageId、字段差异。
- 不影响用户请求。
- 通过补偿任务修复 PostgreSQL。
- mismatch rate 低于阈值并稳定一段时间后，才进入切读。

#### 第 4 步：灰度切读

读路径按配置或百分比切到 PostgreSQL：

1. 内部 clientId 或测试房间先读 PostgreSQL。
2. 小比例用户读 PostgreSQL。
3. 全量读 PostgreSQL。

写路径仍保持双写一段时间。这样 PostgreSQL 读出问题时，可以立即切回 Redis。

#### 第 5 步：稳定窗口后收缩

当 PostgreSQL 读写稳定，Redis 仍保留 durable 数据一段时间：

- 至少经过一个完整业务流量周期。
- 对账指标稳定。
- 没有 PostgreSQL 写入积压。
- 没有 shadow/read mismatch。
- 回滚窗口关闭后，才考虑清理 Redis durable data。

即使清理 durable data，Redis 仍然保留 socket/session/cache 职责。

### 不停服迁移的核心差异

| 项目 | 本次停服迁移 | 生产不停服迁移 |
| --- | --- | --- |
| 写入窗口 | 停服务后最终同步，避免并发写 | 服务不停，必须双写或可靠补偿 |
| 回填方式 | 按 room 覆盖 message history | 按 message id 幂等 upsert，避免覆盖新写 |
| 切读 | 一次性配置切到 PostgreSQL | shadow read 后灰度切读 |
| streaming | 停服避开并发 streaming | 按 message status 识别进行中，跳过或双写 |
| 回滚 | Redis 数据保留，配置切回 | Redis 持续保留为回滚源，直到稳定窗口结束 |
| 风险控制 | 停机窗口换一致性 | 双写、对账、补偿、灰度换零停机 |

## 技术亮点

### 1. Redis 和 PostgreSQL 职责拆分清晰

不是简单把 Redis 替换成 PostgreSQL，而是拆分：

- PostgreSQL：事实来源。
- Redis：realtime + cache。

这让系统后续可以继续利用 Redis 的低延迟和 pub/sub 能力，同时把历史数据可靠性放到关系数据库里。

### 2. AI streaming 生命周期持久化

AI 回复不是一次性 message append，而是状态机：

- `streaming`
- `complete`
- `error`

这解决了刷新、重连、服务重启后的恢复问题。用户不再只能依赖 socket 内存态看到 AI 回复状态。

### 3. `upsertMessage` 修复并发覆盖风险

一开始如果用“读取历史 snapshot，再保存完整 history”，并发 AI 请求会互相覆盖。改为按 message id upsert 后，placeholder、final、error 都只影响自己的消息。

这是本轮最重要的数据正确性修正之一。

### 4. Redis Lua 保证关键列表操作原子性

Redis 的 `LRANGE` + `DEL` + `RPUSH` 不是原子的，中间失败会丢历史。改成 Lua 脚本后，保存历史和 upsert message 在 Redis 侧成为单命令执行，显著降低中间状态风险。

### 5. cache-aside 一致性边界明确

Redis message cache 是优化，不是事实来源：

- 写 PostgreSQL 成功后失效 cache。
- cache 失败不回滚 PostgreSQL。
- TTL 限制最长脏读窗口。

这比“Redis 和 PostgreSQL 都像主库一样同时相信”更容易推理。

### 6. 迁移脚本幂等

迁移脚本可以 dry-run，也可以重复执行：

- rooms upsert。
- messages per room replacement。
- costs exact set。

停服迁移时，这让最终同步更安全；失败后也可以修复再重跑。

## 技术难点

### 1. “正在进行”的定义

不能用用户是否在线判断对话是否正在进行。真正需要关注的是：

- AI message 是否处于 `streaming`。
- 是否存在未完成持久化事务。
- retry/edit 是否正在改写历史。

在线成员只是 realtime 状态，不是 durable consistency 状态。

### 2. 双存储一致性

Redis 和 PostgreSQL 分工后，最大难点不是写 SQL，而是保证：

- 什么时候读谁。
- 写失败时是否广播。
- cache 失效失败怎么办。
- retry/edit/delete/clear 是否同时影响两个存储。
- 切换期间如何回滚。

### 3. AI streaming 和历史裁剪

retry/edit-and-ask 会裁剪旧历史，然后生成新 AI 回复。这里既要保留用户语义，又不能让 AI placeholder/final 用旧 snapshot 覆盖并发消息。

### 4. 线上真实数据规模

本地测试不容易暴露 Upstash 10MB 响应限制和 256MB Fly machine OOM。线上迁移时，大房间消息历史成为真实压力点。

这说明迁移前应该增加数据体积预估：

- 最大房间消息数。
- 最大 room payload。
- 最大单 message payload。
- API response size。
- Node.js heap 和机器内存余量。

### 5. 不停服迁移比停服迁移复杂很多

停服迁移靠停止写入换一致性。不停服迁移必须解决：

- 双写可靠性。
- 回填和在线写入冲突。
- shadow read 对账。
- 灰度切读。
- 回滚窗口。
- 迁移期间 streaming 的处理。

## 作为学习者可以学到什么

### 1. 架构迁移先画边界，而不是先写代码

本轮最关键的不是 PostgreSQL 表怎么建，而是先明确：

- 哪些数据是事实来源。
- 哪些数据只是缓存。
- 哪些状态可以丢。
- 哪些状态必须恢复。

边界清晰后，代码拆分才不会变成“把 Redis API 翻译成 SQL API”。

### 2. 验收标准比任务列表更重要

每个阶段都写验收标准，可以让开发过程不只停留在“功能做了”，而是能回答：

- 怎么证明没有破坏旧路径？
- 怎么证明迁移可重跑？
- 怎么证明失败时不会广播未落库消息？
- 怎么证明 cache 不影响 durable correctness？

### 3. Code review 应该重点看失败路径

Claude review 发现的问题大多不是 happy path，而是：

- 并发覆盖。
- 非原子窗口。
- 持久化失败后继续广播。
- retry 边界。

这些问题单元测试不一定自然覆盖，需要刻意从故障模式推理。

### 4. 数据迁移要优先设计回滚

这次保留 Redis 原始 durable 数据，所以 PostgreSQL 切换失败时可以配置切回 Redis。生产迁移里，能回滚通常比一次切换成功更重要。

### 5. 本地测试和线上验证关注点不同

本地测试验证行为正确；线上验证还要验证资源和数据规模：

- 大 payload。
- 内存。
- 平台响应限制。
- 日志里的 OOM/502。
- 真实网络和数据库延迟。

### 6. 零停机迁移本质是产品级工程

不停服迁移不是“脚本跑快一点”，而是完整工程：

- 兼容版本。
- 双写。
- 回填。
- 对账。
- 灰度。
- 回滚。
- 监控。

这是一类非常值得学习的后端系统演进能力。

## 测试覆盖补充结果

迁移完成后又按独立计划补齐了 PostgreSQL 迁移测试覆盖：[docs/postgres-test-coverage-plan.zh.md](./postgres-test-coverage-plan.zh.md)。

已完成的新增覆盖包括：

- RedisStore/PostgresStore 共享 durable contract，防止两种模式语义漂移。
- Upstash 大 Redis list 读取限制、迁移分批顺序、幂等迁移和失败后重跑。
- 大 message history API、持久化失败不广播幽灵消息。
- PostgreSQL 模式专用 E2E 入口，带测试库安全校验和启动前重置。
- 多客户端 realtime E2E，覆盖 send/edit/delete/clear、成员数、AI streaming 和 late joiner。
- persistence smoke，覆盖 Redis mode 正向、PostgreSQL 不可达 fail-closed、以及切回 Redis 后基础 API。

本地最终矩阵已通过：server 单测 103/103、server build、client 单测 53/53、client lint、client build、Redis E2E 16/16、persistence smoke。唯一尚未在本机完成的是需要 disposable PostgreSQL 测试库的正向 smoke 和 PostgreSQL E2E；这两个命令已经写入测试计划文档，等有安全测试库后即可执行。

## 后续建议

1. 配置一次性 PostgreSQL 测试库后，补跑 `TEST_DATABASE_URL=... npm run smoke:persistence` 和 `E2E_DATABASE_URL=... npm run test:e2e:postgres`。
2. 为 message history API 增加分页或 lazy loading，避免单个房间返回十几 MB 甚至更大的 payload。
3. 为 PostgreSQL 增加备份和恢复演练；当前 Fly Postgres 是 unmanaged，备份责任在我们。
4. 如果未来要真正零停机迁移，先实现双写 outbox 和 shadow read mismatch 指标。
5. 为迁移脚本加入更强的数据校验，例如每房间 message count、latest message id、cost total checksum。
6. 在 CI 中加入可选 PostgreSQL 测试库服务后，把 PostgreSQL E2E 和正向 smoke 纳入自动门禁。
