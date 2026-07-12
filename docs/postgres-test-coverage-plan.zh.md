# PostgreSQL 迁移后的测试覆盖计划

[English](postgres-test-coverage-plan.md)

Reviewed: 2026-07-12

> 状态：已完成的历史计划。本文前半部分的“当前覆盖现状/主要缺口”描述的是
> 2026-05-11 实施前状态；实际完成情况见下方“执行状态”和“最终验收矩阵”。

## 目标

本计划用于补齐 PostgreSQL 迁移后的高风险测试缺口。新增测试必须覆盖真实用户链路、存储行为一致性、迁移幂等性、大数据量风险，以及 Redis/PostgreSQL 模式切换后的回归风险。

测试扩展遵循三个原则：

1. 单元测试验证纯逻辑、失败路径和存储契约。
2. API/socket 测试验证协议行为和广播边界。
3. E2E 测试验证用户真实操作链路，不替代底层契约测试。

每个阶段完成后都必须：

- 本地运行该阶段相关测试。
- 运行不低于该阶段风险范围的回归测试。
- 调用 Claude Code Opus 4.7 做只读 code review。
- 汇总 review findings，再决定是否进入下一阶段。

## 当前覆盖现状

### 已有单元/API/socket 覆盖

- Redis store：房间、消息、AI cost、cache、socket membership、startup streaming recovery。
- PostgreSQL store：schema 初始化、room CRUD、message append/save/upsert、AI cost、rollback。
- Composite store：durable/realtime 分工、cache hit/miss、cache 失效失败。
- Migration：dry-run、幂等迁移、逐房间失败继续。
- API routes：status、client rooms、create room、create message、持久化失败不广播幽灵消息。
- Socket handlers：room、message、media、AI streaming、retry/edit。
- Client utils/hooks：message state、room state、model pricing/cache hit、scroll debounce、clientId auto-scroll。

### 已有 E2E 覆盖

- 打开房间卡片。
- 创建房间。
- 通过 ID 加入房间。
- 发送消息。
- 编辑、删除、清空消息。
- visibility refresh。
- premium model 双重确认。
- fake AI streaming、metadata、cache hit rate。
- retry。
- edit-and-ask。
- 图片上传。
- 分享链接加入。
- 移动端创建房间和发送消息。

### 主要缺口

1. E2E 当前主要跑 Redis 测试库，没有同一套用户链路的 PostgreSQL 模式验证。
2. RedisStore 和 PostgresStore 没有完整共享 contract suite，容易出现模式行为漂移。
3. 大房间/大消息 payload 没有沉淀成自动化回归。
4. 线上暴露的 Upstash 10MB 迁移读取限制没有纳入正式迁移测试。
5. 多客户端 realtime 同步链路还不够强。
6. Redis/PostgreSQL 切换和回滚只有 runbook，没有自动化 smoke test。

## 分阶段执行

### 阶段 0：测试计划文档和 Claude review

范围：

- 新增本测试覆盖计划文档。
- 更新迁移开发复盘文档，引用本计划。
- 调用 Claude Code Opus 4.7 审查测试路线是否覆盖核心迁移风险。

验收标准：

- 文档独立于迁移复盘文档。
- 明确每个阶段的范围、验收标准和建议 commit。
- Claude review 没有指出必须先调整的高优先级测试缺口。

建议 commit：

- `docs: add postgres test coverage plan`

### 阶段 1：Store contract parity 和迁移单元测试增强

范围：

- 提取共享 store contract 测试，覆盖 RedisStore 与 PostgresStore 共同语义。
- 验证同一输入下两种 store 的行为一致：
  - room create/read/list/delete。
  - message append/read/save/upsert/clear。
  - message ordering。
  - metadata、AI usage、cost、cache hit rate。
  - missing room 写入失败语义。
  - startup stale streaming recovery。
  - retry 语义：目标 AI 消息之后的历史被截断，目标之前的历史保留。
  - edit-and-ask 语义：编辑后的用户消息保留，之后的历史被截断，再插入新的 AI placeholder。
  - retry/edit 边界：目标 message 不存在时不误删历史；目标之后没有消息时不产生多余变更。
- 增强 migration 测试：
  - 大 room message source 分批读取。
  - Upstash 10MB 限制回归：source 在 full-range read 超过阈值时抛错，迁移逻辑必须 fallback 到逐 index 或分批读取，并保持顺序。
  - batch 边界顺序：room message 数量超过单批大小时，迁移后 PostgreSQL 顺序必须和 Redis list 顺序完全一致。
  - 重复迁移不会重复 message。
  - cost total 使用精确赋值，不重复累加。
  - room 级失败后可重跑成功。

验收标准：

- `server/src/repositories` 下新增或重构 contract suite。
- RedisStore 和 PostgresStore 通过同一套共享断言。
- RedisStore 和 PostgresStore 必须都通过 retry/edit truncation 的共享断言，不能只在 AI handler 层 mock 验证。
- migration 测试必须复现 full-range read 超限失败，并验证 fallback 完成迁移；不能只 mock 一个已经抽象好的 happy path source。
- migration 测试必须断言批量迁移后的 message count、message id 顺序、message content 顺序完全一致。
- `cd server && npm test` 通过。
- `cd server && npm run build` 通过。
- Claude Code review 完成，本阶段无必须修复项。

建议 commit：

- `test(server): add store contract parity coverage`
- `test(server): strengthen redis postgres migration coverage`

### 阶段 2：API/socket 大 payload 和失败路径回归

范围：

- API 层增加大房间 message history 回归测试。
- socket 层增强多消息、大 payload 或 streaming metadata 的边界测试。
- 覆盖 cache 故障、PostgreSQL durable 成功但 Redis cache 失败的 API/socket 结果。
- 覆盖 append/upsert/saveHistory 失败时不广播的更多入口。

验收标准：

- 至少一个测试生成不少于 100 条 message，每条包含非空正文和 metadata，验证接口返回合法 JSON、数量正确、顺序正确，且不会错误截断。
- API/socket 对持久化失败的行为一致：不广播幽灵消息，客户端收到明确错误。
- 大 payload 测试不要求真实 12MB 固定文件，但要覆盖大内容路径和序列化边界。
- 大 payload 测试记录响应大小或序列化大小，并写入测试 artifact 或稳定输出文件，作为后续分页改造前的观测基线。
- `cd server && npm test` 通过。
- Claude Code review 完成，本阶段无必须修复项。

建议 commit：

- `test(server): cover large message history and persistence failures`

### 阶段 3：PostgreSQL 模式 E2E

范围：

- 新增 PostgreSQL E2E 运行入口，不影响现有 Redis E2E。
- 复用核心用户链路：
  - 创建房间。
  - 打开房间。
  - 发送消息。
  - 刷新后读取历史。
  - fresh context/page load 读取历史，验证 cache miss 时从 PostgreSQL 返回正确数据。
  - edit/delete/clear。
  - fake AI streaming 完成后刷新仍保留 final response。
  - 图片上传并刷新后仍能看到 image message。
  - 分享链接加入房间。
- 使用独立测试数据库，避免污染生产和本地开发数据。

实现约束：

- Redis E2E 继续使用 `redis://127.0.0.1:6379/15`。
- PostgreSQL E2E 通过 `E2E_DATABASE_URL` 显式启用。
- 未配置 `E2E_DATABASE_URL` 时，PostgreSQL E2E 应该明确跳过或给出清晰错误，不影响默认 E2E。
- PostgreSQL 模式仍需要 Redis 参与 socket/session/cache，因此测试环境同时需要 Redis。
- PostgreSQL E2E 启动前必须强制隔离测试数据：要么 drop/recreate test schema，要么 truncate 所有相关表并重置测试 Redis DB。隔离机制由测试 runner 执行，不能只写在人工步骤里。
- `E2E_DATABASE_URL` 必须显式拒绝明显生产地址；测试 runner 需要检查 database name 或 host allowlist，避免误连生产。
  - 例如：database name 必须包含 `test` 或 `e2e`。
  - 已知生产 host/app name 必须拒绝，除非显式设置专用的测试覆盖开关。

验收标准：

- 新增脚本，例如 `npm run test:e2e:postgres`。
- Redis E2E 原脚本保持不变：`npm run test:e2e`。
- PostgreSQL E2E 覆盖核心房间、消息、AI 刷新恢复、fresh load cache miss、图片上传和分享加入链路。
- PostgreSQL E2E 每次运行前自动清理测试 schema/table 和测试 Redis DB，失败中断时下一次运行仍能自恢复。
- `cd client-heroui && npm run test:e2e` 通过。
- 配置测试数据库后，`cd client-heroui && npm run test:e2e:postgres` 通过。
- Claude Code review 完成，本阶段无必须修复项。

建议 commit：

- `test(e2e): add postgres mode user flow coverage`

### 阶段 4：多客户端 realtime E2E

范围：

- 两个 browser context 同时加入同一房间。
- 验证以下操作在两个客户端都同步：
  - send message。
  - edit message。
  - delete message。
  - clear chat。
  - room member count/change。
  - AI streaming visible to both clients。
  - client B 在 AI streaming 已开始后加入房间，能看到 PostgreSQL 中的 streaming placeholder，并最终看到 complete response。
- Redis 模式和 PostgreSQL 模式都至少覆盖一个双客户端场景：
  - Redis 模式覆盖完整 realtime 操作集合。
  - PostgreSQL 模式至少覆盖 client A 写入、cache invalidation、client B 无刷新看到消息或 fresh load 读到 PostgreSQL history。

验收标准：

- 测试能证明一个客户端发起操作，另一个客户端无需刷新即可看到结果。
- 不依赖固定时间 sleep，使用 Playwright expect 等待可观察 UI 状态。
- 关键 multi-client E2E 在合并前连续运行 3 次通过，或记录明确的 flake 原因并修复。
- `cd client-heroui && npm run test:e2e` 通过。
- 配置 PostgreSQL 测试数据库后，`cd client-heroui && npm run test:e2e:postgres` 覆盖至少一个双客户端场景并通过。
- Claude Code review 完成，本阶段无必须修复项。

建议 commit：

- `test(e2e): cover multi-client realtime flows`

### 阶段 5：切换、回滚和 smoke automation

范围：

- 增加轻量 smoke 脚本或测试，验证 Redis/PostgreSQL 模式基础健康。
- 覆盖：
  - Redis mode `/api/status`。
  - PostgreSQL mode `/api/status`。
  - Redis cache 故障不影响 PostgreSQL durable 写入。
  - 切回 Redis 模式后基础 API 可用。
  - `DATABASE_URL` 不可达时，PostgreSQL 模式写操作返回明确结构化错误或 503，不静默丢写；日志包含清晰连接错误。
  - 可选提前在服务端单测补充 Postgres client connect 抛错路径；最终 DB-unreachable 行为仍以本阶段 smoke 为准。
- 文档化本地运行命令和环境变量。

验收标准：

- smoke test 不连接生产服务。
- PostgreSQL smoke 使用 `E2E_DATABASE_URL` 或专用 `TEST_DATABASE_URL`。
- README 或测试文档说明如何运行。
- `cd server && npm test` 通过。
- `cd client-heroui && npm run test:e2e` 通过。
- Claude Code review 完成，本阶段无必须修复项。

建议 commit：

- `test: add persistence mode smoke coverage`

本地运行命令：

```bash
cd server
npm run smoke:persistence
```

默认只使用本地 Redis 测试库 `redis://127.0.0.1:6379/15`，不会继承可能指向生产的 `REDIS_URL`。如果要覆盖 PostgreSQL 正向 smoke，需要显式设置一次性测试库：

```bash
cd server
TEST_DATABASE_URL="postgres://localhost/message_system_test" npm run smoke:persistence
```

脚本会拒绝数据库名不包含独立 `test` 或 `e2e` token 的 URL。未配置测试库时，PostgreSQL 正向 smoke 会清晰跳过；不可达 PostgreSQL URL 的 smoke 仍会验证服务在启动期 fail-closed，不接受写入。

说明：Redis 在 PostgreSQL 模式下同时承担 Socket.IO adapter、realtime session 和 message cache。进程级 smoke 无法只打坏 cache 而保持 Redis adapter 可用，所以“Redis cache 故障不影响 PostgreSQL durable 写入”由 `CompositeRoomStore` 单元测试覆盖，验证 cache read/write/invalidate 抛错时 durable read、append、upsert、save history、clear 仍然可用。

## 执行状态

截至 2026-05-11，本计划的阶段 0 到阶段 5 已完成并提交：

- `aced733 docs: add postgres test coverage plan`
- `d969a31 test(server): add durable store parity coverage`
- `1919bc3 test(server): strengthen redis postgres migration coverage`
- `4861002 test(server): cover large histories and persistence failures`
- `7c18406 test(e2e): add postgres mode user flow coverage`
- `b2d1210 test(e2e): cover multi-client realtime flows`
- `4dfa749 test: add persistence mode smoke coverage`

本地最终验收结果：

- `cd server && npm test`：通过，103/103。
- `cd server && npm run build`：通过。
- `cd server && npm run smoke:persistence`：通过 Redis 正向 smoke；未配置测试库时 PostgreSQL 正向 smoke 按设计跳过；PostgreSQL 不可达 fail-closed smoke 通过。
- `cd server && TEST_DATABASE_URL="postgres://sky@127.0.0.1:55432/message_system_test" npm run smoke:persistence`：通过，补齐 PostgreSQL 正向 smoke。
- `cd client-heroui && npm test`：通过，53/53。
- `cd client-heroui && npm run lint`：通过。
- `cd client-heroui && npm run build`：通过。
- `cd client-heroui && npm run test:e2e`：通过，16/16。
- `cd client-heroui && E2E_DATABASE_URL="postgres://sky@127.0.0.1:55432/message_system_e2e" npm run test:e2e:postgres`：通过，3/3。

本次补齐 PostgreSQL 正向验收使用的是本机一次性测试库：

```bash
brew install postgresql@17
PG_BIN=/opt/homebrew/opt/postgresql@17/bin
PGDATA=/private/tmp/message-system-pg-e2e
PORT=55432
"$PG_BIN/initdb" -D "$PGDATA" --locale=en_US.UTF-8 -E UTF8 --auth=trust
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-h 127.0.0.1 -p $PORT" -l "$PGDATA/postgres.log" start
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U sky message_system_test
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U sky message_system_e2e
```

测试库是临时本地集群，不是系统服务。需要停止时执行：

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /private/tmp/message-system-pg-e2e stop
```

PostgreSQL E2E 首次运行暴露并修复了两个问题：

- E2E `seedClient()` 之前每次 `page.reload()` 都会重置 `roomtalk_current_view` 和当前房间，测试辅助函数本身破坏了刷新恢复链路；现在只在新 clientId seed 时清理状态，同一 context reload 会保留当前房间。
- `Ask AI` 之前只是 fire-and-forget 发送用户消息；PostgreSQL 落库慢于 Redis 时，`ask_ai` 可能先读取历史并看到空 prompt。现在服务端 `send_message` 返回持久化 ACK，前端等 ACK 后再发起 `ask_ai`，并带超时保护避免断线时 UI 卡住。

## 最终验收矩阵

全部阶段完成后，需要通过：

```bash
cd server
npm test
npm run build
npm run smoke:persistence
```

```bash
cd client-heroui
npm test
npm run lint
npm run build
npm run test:e2e
```

如果配置了 PostgreSQL E2E 数据库，还需要通过：

```bash
cd client-heroui
E2E_DATABASE_URL="postgres://..." npm run test:e2e:postgres
```

2026-06-26 merge 后复验记录：

- `server/src/scripts/persistenceSmoke.ts` 已按当前授权模型补齐 `clientId`，避免 smoke 读取 `/api/rooms/:roomId/messages` 时被 403 拒绝。
- `client-heroui/playwright.postgres.config.ts` 在 PostgreSQL E2E 后端显式使用 `NODE_ENV=test` 和本地媒体存储目录，使图片上传/持久化链路可在一次性测试库中覆盖。
- PostgreSQL E2E 的媒体发送步骤现在等待 composer scoped `Send` 按钮完成，避免被 A2UI 内部同名按钮误匹配。
- 当前复验结果：
  - `cd server && npm run build`
  - `cd server && npm test`：382/382 passed
  - `cd server && TEST_DATABASE_URL="postgres://roomtalk@127.0.0.1:55432/message_system_e2e" npm run smoke:persistence`
  - `cd client-heroui && npm run lint`
  - `cd client-heroui && npm test -- --run`：253/253 passed
  - `cd client-heroui && npm run build`
  - `cd client-heroui && E2E_DATABASE_URL="postgres://roomtalk@127.0.0.1:55432/message_system_e2e" ./node_modules/.bin/playwright test --config=playwright.postgres.config.ts`：3/3 passed

## Claude Code review 规则

每阶段实现后调用 Claude Code Opus 4.7，只读 review：

- 不允许 Claude 直接编辑文件。
- review prompt 必须包含本阶段范围和验收标准。
- findings 按严重程度排序。
- 高优先级 correctness issue 必须先修复，再进入下一阶段。
- 可后置项必须记录在阶段讨论里。

重点要求 Claude 检查：

- 是否仍有 Redis/PostgreSQL 行为漂移。
- 是否有测试只覆盖 mock happy path，无法防止真实回归。
- 是否有 E2E 选择器脆弱或异步等待不可靠。
- 是否有大 payload 测试过慢或污染环境。
- 是否有 PostgreSQL E2E 配置误连生产风险。

## 预期学习点

这批测试的目标不是追求数字覆盖率，而是让测试体系反映系统风险：

- 存储迁移看 contract parity。
- 实时系统看多客户端同步。
- AI streaming 看状态机和恢复。
- 缓存系统看事实来源和失效失败。
- 数据迁移看幂等、对账和回滚。
- 生产稳定性看大 payload、资源限制和 smoke 验证。
