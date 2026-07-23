# 房间事件与自托管切换记录

[English](room-event-sync-portable-deployment-progress.md)

状态：源码、基础设施、数据、不可变事件与所有权模型生产切换全部完成

验证日期：2026-07-22

本文是 RoomTalk 从 Fly/Supabase/Tigris 迁到 MacBook Compose，以及随后替换 room-event 协议的证据账本。它只记录改了什么、生产何时跨过边界、哪些检查通过。运行协议见[房间可靠性架构](room-reliability-architecture.zh.md)，拓扑和未来迁移方式见[房间事件同步与可迁移部署](room-event-sync-portable-deployment.zh.md)。

## 两次切换，不是一次

这条工程主线分两个维护窗口进入生产：

1. 2026-07-20，App、PostgreSQL 数据、Redis 实时状态和 S3-compatible 对象从 Fly/Supabase/Upstash/Tigris 迁到 MacBook 的 Docker Compose。Cloudflare Tunnel 开始承载 `room.ruit.me`、`roomtalk.ruit.me` 和 `roomtalk-objects.ruit.me`。
2. 2026-07-21，生产把保留的 ID-only room-event 历史替换为严格的不可变 after-image；migration `0004` 同时从公共事件流移除成员 ID 和角色。第二条边界再次要求先备份，再停止所有旧 app。

把两个日期分开，可以避免一个常见误读：数据库宿主先迁走，最终事件 payload 协议在第二天才进入生产。

## 变更账本

实施从本地 `master` 的 `d94d2cd0` 开始。

| 阶段 | 结果 | 证据 commit |
| --- | --- | --- |
| 1 | 架构决策、证据账本、初版 Compose runtime | `ec0ac9af` |
| 2 | PostgreSQL event stream、snapshot/replay 客户端、退役 version 字段、integration/E2E | `d2c051ab` |
| 3 | 运维演练与第一轮文档合并 | `63ef29bc` |
| 4 | 本地持久媒体、签名 URL、Compose env 检查、成对恢复演练 | `77a5826c` |
| 5 | Mac 生产 runtime、SeaweedFS 目标、源数据演练、tunnel、备份恢复 | `bdad6d2f`、`94d7feed`、`f878752d` |
| 6 | 最终停写、日志归档、数据恢复、DNS route、公网 smoke、显式凭据 | `a554554c`、`56871060` |
| 7 | 已提交事件 Socket fast path、字节上限 fallback、大差距 snapshot | `1201ba88` |
| 8 | 不可变 after-image、`io.local` fan-out、listener 反熵、一次性旧协议边界 | `c3650de8` |
| 9 | 公共成员隐私、严格 payload validator、提前到达 AI 临时事件 buffer | `609c5e3c` |
| 10 | 保留 optimistic send、不依赖数据库的 payload 单测 | `a8afcf49` |
| 11 | `CURSOR_AHEAD` 旧水位清理、持久 AI 错误的确定性 fast path | `fbfd908b` |
| 12 | Per-room 同步状态机、权限屏障、广播合并、message room 不可变、强制 PostgreSQL CI | `b607ad7a` |
| 13 | AI 与 outbox fencing、Socket 身份收口、Redis lease 原子化、严格 readiness | `a3b90e0c` |
| 14 | PostgreSQL schema 初始化全事务串行化，消除多实例 DDL 竞态 | `81b2b74e` |
| 15 | 可恢复 AI 启动、run 原子创建、单任务 claim、异常 socket 隔离、migrate/verify schema 生命周期 | `f389bdce` |

定时 Fly workflow 继续禁用，Fly machine 保持为零。Supabase、Tigris 和 Upstash 是回滚源，不是 live writer。`ai-chat.wenlin.dev` 仍在允许 origin 中，其 DNS 单独管理。

## 生产证据

### 基础设施与数据，2026-07-20

最终 Supabase dump 向 PostgreSQL 17 恢复了 98 个 room、7,939 条 message、179 条 member、404 个 media asset、6,361 条 observability event、28 条 outbox event 和 60 条 room-agent turn。Tigris 复制覆盖私有媒体、发布站点和贴纸，共校验 2,857 个对象、1,302,853,579 bytes。成对 PostgreSQL archive 与 SeaweedFS snapshot 已恢复到隔离目标，抽查对象的 SHA-256 一致。

公网验证覆盖 TLS、HTTP、Socket.IO polling 与 WebSocket upgrade、snapshot/delta、presigned PUT/GET 字节一致和删除清理。真实 PostgreSQL 重启后 marker 与 event head 保留；pool 处理断连，重新建立 `LISTEN room_event_committed`，没有未捕获异常。

### 不可变事件协议，2026-07-21

本次发布先生成：

- `backups/roomtalk-20260721T110310Z.dump`
- `backups/roomtalk-object-storage-20260721T110310Z.tar.gz`

随后停止 `cloudflared` 和旧 app，构建 commit `fbfd908b`，只启动新镜像。启动日志先记录 `0003_room_events_immutable_after_images` 与 `0004_public_member_change_events`，然后 PostgreSQL listener、Redis adapter、outbox worker 与 HTTP server 才进入 ready。

生产只读查询确认 migration `0001` 到 `0004` 全部存在，没有非 V1 保留事件；旧 stream 只留下经过授权的 `room.deleted` cutover tombstone。公网状态端点报告 PostgreSQL、Redis、media storage 与 Socket adapter ready，room 数为 98。

公网 WSS smoke 使用临时房间验证了下面的链路：

```text
register -> create -> join -> send
  -> Socket 收到已提交 messages.upserted payload
  -> repeatable-read snapshot 含同一消息
  -> 从 seq 0 replay 得到同一 after-image
  -> delete -> 获授权读取 room.deleted tombstone
  -> 清理完成
```

Smoke 强制使用 WebSocket transport，达到 `snapshotSeq=3`，重放三条 event，并删除临时房间。

### 并发状态收敛，2026-07-21

Commit `b607ad7a` 没有继续增加彼此独立的恢复 flag，而是直接缩小并发状态空间。浏览器现在由一个 per-room `idle/replay/replace/prepend` controller 统一协调 event replay、replacement recovery 与历史 prepend。未持久化的 AI 终止错误不会再让 placeholder 永远停在 streaming；当前窗口被删除清空时，也不会再被误判为没有更早历史；`CURSOR_AHEAD` 会同时清除过期高水位与旧的大差距 snapshot target。

服务端会把同一房间的 PostgreSQL 通知合并为 seq range。完整 after-image payload 发出前，每个实例都会重新检查 PostgreSQL membership，并先让已失去权限的本机 socket 离开房间。Listener 使用 generation 关闭并忽略旧 client。Migration `0005_message_room_immutability_and_event_clock` 禁止把已有 message ID 移进另一个房间，并把保留事件时间改为真实墙上时间 `clock_timestamp()`。

生产从 `b607ad7a` 重新构建并启动。启动日志确认 `0005`、`LISTEN room_event_committed`、Redis adapter、outbox worker 全部就绪，broadcaster 初始无积压。PostgreSQL、Redis、SeaweedFS 与 app 均健康，Cloudflare Tunnel 正常运行。本机回环、`room.ruit.me` 和 `roomtalk.ruit.me` 都返回 `online`，并报告 PostgreSQL persistence、Redis connected、media configured、Socket adapter ready 与 98 个 room。

## 并发状态收敛版本的验证

| 检查 | 结果 |
| --- | --- |
| 完整 Client suite | 96 个文件、1,012 项通过 |
| 完整 Server suite | 101 个 suite、766 项通过 |
| 真实 PostgreSQL 17 room-event integration | 17 项通过 |
| 状态机与 room-event 竞态回归 | 通过 |
| Server TypeScript build | 通过 |
| Client production build 与 i18n check | 通过 |
| Production Docker image build | 通过 |
| Compose health | 五个服务 healthy/running |
| 本机回环 `/api/status` | Online |
| `room.ruit.me` 与 `roomtalk.ruit.me` `/api/status` | Online |
| 强制 PostgreSQL 17 service 的 GitHub CI | 已加入；room-event integration 不能再静默 skip |

回归测试覆盖 recovery 与 prepend pagination 竞争、当前窗口被删除清空但仍有旧历史、只有 deletion event 才关闭消息弹窗、未持久化 AI 错误早于或晚于 placeholder、1,000 条通知突发合并、旧 PostgreSQL listener generation、跨房间 message 拒绝，以及真实墙上 event 时间。真实 PostgreSQL suite 使用 PostgreSQL 17 而不是 mock；新的 GitHub workflow 会在每次 `master` push 和 pull request 中提供同样的数据库 service。

更早的完整 Server、Client、PostgreSQL integration、PostgreSQL Playwright、persistence、Compose restart 与成对恢复结果仍保留在产生它们的 Git commit 中。这里不复制每个测试用例，因为当前架构文档已经说明协议层覆盖。

### 所有权模型收口，2026-07-22

Commit `a3b90e0c` 把剩余竞态统一到可证明的所有权规则。AI stream 使用 `(ownerId, fence)`，outbox 使用 `(workerId, attempt)`；续租、终态写入和 ack 都必须携带原 claim token，旧 worker 不能完成或覆盖新 owner 的工作。AI 所有权更新不再进入公开 room-event 流，migration `0007_ai_stream_fencing` 与 `0008_ai_stream_internal_event_filter` 已在生产应用。

Socket 连接以内存中的已认证 `socket.data.roomtalkClientId` 为本连接的权威身份，Redis 只保存可重建索引。Redis 记录缺失时，服务端必须先用 PostgreSQL room membership 重新授权，再修复索引；非空身份冲突则 fail closed。Heartbeat、instance lease 与过期清理改为原子 Lua，清理前再次检查 lease 和 socket owner。Socket.IO adapter 只有在 Redis pub/sub 两端都 ready 时才报告 ready，客户端对瞬时授权不可用使用单一指数退避定时器恢复。

这次发布遵守 stop-the-world 边界：旧 app 已停止后才启动包含新 lease/fence 协议的镜像，没有让旧实例与新实例滚动混跑。Compose 从 `a3b90e0c` 构建，启动日志确认两条新 migration、PostgreSQL listener 和 Redis Socket.IO adapter 就绪。

第一轮 GitHub CI 进一步复现了基础 DDL 的并发窗口：两个 initializer 都可能先删除同一个 check constraint，再同时添加，第二个会收到 PostgreSQL `42710 duplicate constraint`。Commit `81b2b74e` 没有只修这一条约束，而是把完整的 always-rerun DDL、migration effect 和 migration ledger 统一放进一个 transaction-scoped advisory lock；其他 DROP/ADD constraint 与 trigger replace 序列也同时获得相同保证。真实 PostgreSQL 并发初始化用例连续 10 轮通过，完整 Server suite 在只注入测试数据库 URL 的干净环境中 820 项通过。生产随后从 `81b2b74e` 重建并启动，schema 初始化、listener 与 Redis adapter 正常就绪。

| 检查 | 结果 |
| --- | --- |
| 完整 Client suite | 96 个文件、1,020 项通过 |
| 完整 Server suite（含 PostgreSQL integration） | 105 个 suite、820 项通过 |
| PostgreSQL 17 upgrade-path integration | 25 项通过 |
| PostgreSQL 17 fresh-schema integration | 25 项通过 |
| Server 与 Client production build | 通过 |
| Compose health | 五个服务 healthy/running |
| migration ledger | `0006`、`0007`、`0008` 已记录 |
| 本机回环、`room.ruit.me`、`roomtalk.ruit.me` | `online`、`ready=true`、98 个 room |
| 依赖状态 | PostgreSQL、Redis、media storage、Socket adapter 全部 ready |

发布后日志没有 fatal、panic、uncaught、unhandled 或 error 记录。工作树清理后不保留生产 env/runtime 符号链接；生产数据仍由原 Compose volume 与 `runtime/` 目录承载。

### Durable AI 与 schema 生命周期加固，2026-07-22

Commit `f389bdce` 关闭了所有权版本上线后发现的两个真实 worker-mode 重启窗口。Startup recovery 现在会同时检查 `assistant_run` 与 `ai.run_requested` outbox：只要它们仍描述可恢复的 queued/running 工作，就不会把 streaming placeholder 判死。Worker 模式在一个 PostgreSQL 事务中同时创建 placeholder、run 与 outbox row。串行 Worker 默认改为 `claim one, execute one`，长 Provider 调用不再让尚未开始执行的 claim 在队列里过期。Lease 时间统一来自 PostgreSQL wall clock。本机已认证 Socket identity 是唯一权威；身份缺失或冲突时只让异常 socket 重新注册并离开，其他 verified peer 继续走完整 fast path。

Schema 也不再由每个 App 冷启动修改。Compose 的一次性 `migrate` service 在 advisory transaction lock 下只执行 ledger 中缺失的 immutable migration，并记录 SHA-256 checksum；App 启动只做只读 `verifySchema()`，遇到未知 schema 就拒绝服务。这个边界可直接映射成 Kubernetes/AWS pre-deploy Job 与 DML-only runtime role。生产在 listener 和 worker 启动前，为包含冻结 `0000_roomtalk_schema` bootstrap 在内的 9 条 migration ledger 全部采用了 checksum。

本次发布生成成对备份 `roomtalk-20260722T101006Z.dump` 与 `roomtalk-object-storage-20260722T101006Z.tar.gz`。备份过程还暴露了一个运维边缘：旧恢复逻辑使用 `compose up`，可能在真正构建前让新 Compose command 配上旧 App image。脚本现改为 `compose start`，只恢复备份前停下的原容器；备份不再隐式承担部署职责。

| 检查 | 结果 |
| --- | --- |
| 完整 Server suite | 105 个 suite、799 项通过 |
| 真实 PostgreSQL 17 room-event integration | 26 项通过，无 skip |
| Authorization/broadcaster/identity 定向测试 | 22 项通过 |
| Server 与 Client production build | 通过 |
| Migration ledger | 9/9 行有 checksum；`0000` 到 `0008` 全部验证 |
| Durable AI 不变量 | 部署后 0 条 streaming message、0 个 active run/outbox、0 个 orphan run |
| Compose health | App、PostgreSQL、Redis、SeaweedFS、Cloudflare Tunnel 全部运行，stateful service healthy |
| 本机回环与 `room.ruit.me` | `online`、`ready=true`、99 个 room |

这仍是更安全的过渡 worker 模型，不是最终 AI aggregate。Durable 终态仍分布在 `assistant_runs`、message、AI 专用 outbox、usage projection、owner lease 和进程内 terminal reconciler。下一阶段仍应把 `assistant_runs` 升为唯一 durable execution aggregate，为临时事件增加 run generation/chunk sequence，在一个事务内幂等保存 terminal payload 与 usage，随后退役 AI 专用 outbox 与内存 terminal retry。已经稳定的 `room_events` 客户端 changefeed 不需要为此改变。

### BullMQ Assistant Worker 切换，2026-07-22

本阶段把上一节仍标为“下一阶段”的 AI aggregate 正式完成。普通聊天 AI 不再由 App 内 PostgreSQL polling worker 执行：App 只接受 Socket 请求并 relay 最小 dispatch intent，独立 Node/TypeScript `ai-worker` 通过 BullMQ 调度，从 PostgreSQL `assistant_runs` 读取完整 request，使用 generation lease 执行 Provider，并把 immutable terminal payload、Message、run 状态与房间费用在受控事务边界内收敛。BullMQ 只拥有 waiting、concurrency、backoff、stalled recovery 与运维 retention；PostgreSQL 仍是唯一业务事实源，也没有引入重复的 `assistant_run_usage` ledger。

首次切换遵守 stop-the-world 协议边界。维护窗口先生成配对备份 `roomtalk-20260722T124306Z.dump` 与 `roomtalk-object-storage-20260722T124306Z.tar.gz`，再停止旧 App 和 edge。确认数据库仍停在 `0009` 后，Compose 才应用 `0010_assistant_run_bullmq_dispatch`、以 named volume + AOF `everysec` + `noeviction` 重建 Redis，并同时启动新 App 与独立 Worker。旧 polling executor 与 BullMQ executor 没有重叠运行。

| 检查 | 结果 |
| --- | --- |
| 完整 Server suite | 111 个 suite、851 项通过；真实 PostgreSQL 17 migration/transaction 无 skip |
| 完整 Client suite | 97 个文件、1,025 项通过 |
| BullMQ + Redis 集成 | duplicate relay 去重、模拟 processor failure retry、单次完成通过 |
| Server / Client production build | 通过 |
| Production image | `roomtalk-local:dev`，镜像 SHA `128708f3280f` |
| Migration ledger | 11/11；`0010_assistant_run_bullmq_dispatch` 已记录 |
| Durable run 不变量 | 10 个历史 run 全部 terminal；0 个 active run 缺 dispatch |
| Dispatch backlog | pending=0、processing=0 |
| Redis queue durability | AOF enabled、`everysec`、`noeviction`、最近写入成功 |
| Worker health | Worker running；queue Redis 与 transient Redis ready |
| Compose health | App、AI Worker、PostgreSQL、Redis、SeaweedFS、Cloudflare Tunnel 全部运行 |
| 本机回环、`room.ruit.me`、`roomtalk.ruit.me` | `online`、`ready=true`、`assistantQueue=ready`、100 个 room |
| 公网 Socket.IO handshake | 成功；可升级 WebSocket |

发布验证没有调用付费 Provider。近十分钟 App、Worker 与 migration 日志中没有 fatal、panic、uncaught、unhandled 或 error 记录。CI 现在同时提供真实 PostgreSQL 17 与 Redis 7；首轮关键测试覆盖队列不可用后的 deferred dispatch、确定性 job 去重、processor failure retry、terminal staging 之后 finalizing run 不重复调用 Provider、精确 generation release，以及 placeholder/run/room event/dispatch 的数据库原子性。

### Assistant queue 可靠性收口，2026-07-22

Commit `46b4d48a` 补上首次 BullMQ 切换后仍有实际价值的恢复缺口。App 侧 singleton reconciler 会核对 PostgreSQL active run 与已经确认的 BullMQ job：确定性 job 消失时补建；job failed 或过早 completed、而业务 run 仍 active 时才重新调度。Worker 持续续期共享 TTL heartbeat，`/api/status` 同时报告 Worker 是否在线、dispatch backlog 与 BullMQ backlog。这里不宣称跨 Provider 的通用 exactly-once：远端接受请求后、terminal staging 前崩溃，外部调用仍可能重复；generation fencing 只允许一个 RoomTalk 终态与一次内部费用结算生效。

维护窗口生成并校验了 `roomtalk-20260723T004010Z.dump` 与 `roomtalk-object-storage-20260723T004010Z.tar.gz`，随后部署生产镜像 `79b1e87ada299f8d1125bb6d756d5b38a9a2f91b6fda515dc2a53ac5ad1797b6`。完整 Server suite 为 114 个 suite、862 项通过；真实 PostgreSQL 17 测试 34 项通过且无 skip；真实 Redis/BullMQ 恢复测试 3 项通过；GitHub Server、Client CI 均通过。部署后六个服务全部运行，十个历史 run 全部 terminal，没有 active run 缺 dispatch，dispatch 与 queue 的各项 backlog 都是 0。本机回环、`room.ruit.me` 与 `roomtalk.ruit.me` 都返回 `online`、`ready=true`、`assistantQueue=ready`、`assistantWorker=ready`，Worker heartbeat 正常续期。本次没有调用付费 Provider。

## 回滚与持续运维

跨过任一生产边界后，回滚都是数据操作。Mac 已接受写入时，不能只重新启用 Fly 或切 DNS。应先停止或 gate 当前 writer，协调 PostgreSQL 与对象增量，恢复匹配的数据库和对象备份，验证目标，然后才切流量。

定期生成成对维护备份，把加密副本复制到 Mac 外，并实际演练恢复。Mac 需要持续供电，Docker Desktop 需要运行。未来 AWS 可复用现有镜像、PostgreSQL schema、Redis 可重建边界、S3 object key 和 E2B execution plane；但若 event payload 不兼容，滚动迁移仍需两阶段协议。
