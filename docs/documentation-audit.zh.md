# 文档审计

[English](documentation-audit.md)

状态：当前文档合约
审计日期：2026-07-21

这份文档说明每一类事实应该写在哪里，并记录本轮核对过的结论。它不是另一份架构说明，也不是部署 runbook。

## 事实归属

| 来源 | 职责 |
| --- | --- |
| 源码与测试 | runtime 行为和协议细节的最终事实源。 |
| `README.md` / `README.zh.md` | 产品概览、当前拓扑、主要技术决策与导航。 |
| `docs/room-reliability-architecture*.md` | 房间同步协议：不可变事件、fast path、replay、snapshot、AI 临时事件、顺序与恢复。 |
| `docs/room-event-sync-portable-deployment*.md` | 部署拓扑、存储边界、生产切换、回滚与 AWS 映射。 |
| `docs/room-event-sync-portable-deployment-progress*.md` | 已完成阶段、commit、测试、migration 与生产验证的精简证据账本。 |
| `DeploymentGuide.md` / `部署指南.md` | 备份、维护窗口发布、验证与回滚的操作手册。 |
| `docs/configuration*.md` | 环境变量分组与配置归属。 |
| `docs/interview-preparation.html` | 用于讲解项目和回答追问的详细双语叙事。 |
| `docs/README*.md` | 完整的分类文档索引。 |

子系统参考、工程复盘、已完成方案和 review 报告继续保留在索引中，因为它们保存了有用的推理或证据，但不能把旧配置写成当前 runtime。

## 写作合约

- 当前文档标注 `Updated`、`Verified` 或审计日期。
- 中英文当前文档的日期、命令、限制、名称与架构事实一致。面试资料保持为一份双语 HTML。
- README 让读者先看懂整个系统。深入文档补充机制、证据或操作流程，不重复同一段介绍。
- 架构文档解释系统为什么成立，进度账本记录已经交付什么，runbook 告诉 operator 应该怎么做。
- 历史数字、branch、machine size 与 commit ID 明确标注为当时快照。
- `CLAUDE.md` 与 `AGENTS.md` 保存 Agent 指令；人类贡献规则位于 `CONTRIBUTING`。

## 本轮核对的事实

### 房间同步与 AI 投递

- PostgreSQL canonical tables 与每房间有界的 `room_events` 是唯一 durable 同步边界。每个事件在业务事务内写入严格、不可变的 V1 after-image；回放旧 seq 时不会再读取当前行补全。
- PostgreSQL `NOTIFY` 是提交后的唤醒 hint。每个监听中的 App 读取精确事件行，只用 `io.local` 通知自己的客户端。Redis adapter 只负责真正由单一来源产生的临时或全局事件。
- 连续的 Socket payload 是低延迟 fast path。缺失或超大 payload 从 PostgreSQL replay；差距超过 500 events 或 cursor 过期时读取 repeatable-read snapshot。已删除房间的 tombstone 是例外，因为房间删除后没有 snapshot。
- 处理 `CURSOR_AHEAD` 时，客户端先清除数据库恢复前的旧目标水位，再请求 snapshot。snapshot 进行中收到的通知会形成新的目标，因此既不会丢掉新提交，也不会对恢复后的旧 head 无限空拉。
- 公共成员事件只暴露 `members.changed`。成员 ID 与角色继续由 `get_room_role_members` 保护。严格 payload 校验会在存储事件损坏时停止推进 cursor。
- `ai_chunk` 与 A2UI update 是有界的临时 fast path。抢在 placeholder 前到达的事件按 `messageId` 等待；reducer 分别更新 canonical state 与当前 React state，因此不会覆盖 optimistic message。
- 用户可见的 AI 失败先作为完整 Message 持久化。`ai_stream_error` 可以携带同一条 Message 作为 fast path，但不再创造只存在于 Socket 的 canonical 文案，因此到达顺序不会改变最终 UI。

### 部署与可迁移性

- MacBook Compose、PostgreSQL、Redis、SeaweedFS 与 Cloudflare Tunnel 的基础设施和数据切换在 2026-07-20 完成。
- 不可变事件协议在 2026-07-21 通过维护窗口进入生产。执行 migration `0003` 与 `0004` 前先停止旧 App，并先完成 PostgreSQL 与对象存储的成对备份。
- 生产验证覆盖 container health、migration 记录、公开 status、强制 WebSocket transport、已提交 fast-path payload、snapshot、replay、已删除房间 tombstone 与测试数据清理。
- AWS 迁移是受控映射，不是“一键迁移”：镜像映射到 ECS/Fargate 或 EKS，PostgreSQL 映射到 RDS/Aurora，Redis 映射到 ElastiCache，对象 key 原样复制到 S3。允许短暂停写时可用 dump/restore 加最终对象增量；零停机还需要 logical replication、CDC 或 DMS。

### 面试资料修正

- durable room event 的多实例 fan-out 使用 PostgreSQL 加 `io.local`，并非所有 Socket.IO 事件都经过 Redis adapter。
- presigned 对象传输把大文件字节流移出 App，但签名和 metadata 仍会经过 App。SeaweedFS 按当前私有 S3-compatible 边界描述，不套用 AWS 专属 bucket 控制。
- 浏览器媒体缓存容量是浏览器报告 quota 的 20%，最大 1 GiB；无法读取 quota 时才回退到 300 MB。
- `setTimeout(..., 0)` 安排的是后续 task，不是 microtask。历史加载示例使用当前的 `beforeMessageId` 请求路径。
- CJK 估算约为每个字符一个 token，非 CJK 文本约每四个字符一个 token。
- 公网 HTTPS/WSS 在 edge 终止 TLS；PostgreSQL 与 Redis 当前在私有 Compose 网络内使用非 TLS 连接。
- 对象存储仍受吞吐、请求速率、延迟、生命周期与成本限制。测试数据库名称 guard 可以降低误连生产的风险，但不能把风险说成不可能。
- 当前贴纸目录有 2,149 个条目。Picker 只渲染当前页与前后各一页，每批相邻图片预加载最多 48 张。
- 媒体查看器在 1x 和放大状态都支持下拉返回。放大图片先消耗横向移动完成 pan，到达图片边界后，继续向外拖动会交给轮播翻页。
- RAF batching 是已经实现的 60fps 优化。优化前 30fps 以下、优化后 60fps 的数字作为目标设备人工 profile 观察保留，不写成仓库自动 benchmark 的结论。
- AI 角色草稿当前由每个 App 实例按来源 IP 限制为 10 分钟 5 次。多实例下若需要全局上限，必须共享限流状态。
- SSE 仍是有效的单向 AI streaming 传输。RoomTalk 复用 Socket.IO，是因为房间 ack、身份上下文与重连恢复已经在这条连接上，而不是因为 AI 数据必须共用一个通道。
- 项目指标卡写作 `180+` 个 test/spec 文件；2026-07-21 仓库快照中，文件名为 `*.test.*` 或 `*.spec.*` 的文件共有 184 个。

## 剩余产品 Follow-up

- 用稳定错误码替换 room Socket 的字符串和 regex 错误判断，尤其是 `ROOM_NOT_FOUND`。
- 补齐 media viewer 的 pinch、edge resistance、velocity-only commit、keyboard control 与 single-tap delay 自动化覆盖。
- 如果水平扩展后仍要求全局 AI 角色草稿上限，把当前内存 limiter 迁移到共享状态。

这些是实现层 follow-up，不是尚未厘清的文档问题。

## 验证标准

文档改动满足以下条件才算完成：

- 索引链接可以解析；
- 每份面向用户的 Markdown 都有对应语言版本，或明确说明本身是双语文件；
- 命令、环境变量名、协议限制、migration 状态与部署结论符合仓库和当前 runtime；
- Markdown 与 HTML 可以解析；
- `git diff --check` 通过。
