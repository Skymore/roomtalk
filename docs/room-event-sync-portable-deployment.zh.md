# RoomTalk 房间事件同步与可迁移部署架构

[English](room-event-sync-portable-deployment.md)

状态：实施中的目标架构

更新：2026-07-20

## 决策摘要

RoomTalk 直接用新的房间事件协议替换 `messageVersion` 快照比较协议，不提供旧同步协议兼容层。最终模型是：

```text
rooms / room_messages     当前物化状态与历史分页事实源
room_event_streams        每个房间的 headSeq / minAvailableSeq
room_events               可重放的应用级增量日志
outbox_events             AI、推送等只执行一次的后台任务
```

本地和云端运行同一镜像：

- 本地：Docker Compose 启动 RoomTalk、PostgreSQL 17 和 Redis 7；
- 当前云端：现有根 `Dockerfile` 和 `fly.toml` 继续部署 Fly，连接 Supabase PostgreSQL 和云端 Redis；
- 后续 AWS：同一应用镜像进入 ECS/EKS，状态服务替换为 RDS、ElastiCache 和 S3；
- Kubernetes 不是本地生产前置条件；数据迁移依赖 PostgreSQL dump/WAL，而不是复制容器卷。

## 目标与非目标

### 目标

1. 断线、恢复前台和冷启动时只读取缺失事件，不重复下载完整最近历史。
2. 首次进入、事件游标过期和修复路径使用有界一致快照。
3. 所有可见消息变化与事件日志在同一持久化事务中提交。
4. 用一个房间序列 `roomSeq` 取代 `messageVersion` 和 `roomVersion` 的同步排序职责。
5. 本地 Compose 与 Fly 使用相同应用构建和环境变量合约。
6. 保持 PostgreSQL、Redis 和 S3 接口标准化，避免绑定 Fly/Supabase。

### 非目标

- 不做完整 Event Sourcing；事件不是数据库唯一事实源。
- 不把 AI token/chunk 逐条写入事件日志。
- 不把 PostgreSQL WAL、MySQL binlog 或内部表变更直接暴露给浏览器。
- 不保留旧 `baseMessageVersion` / `requestedMessageVersion` 协议。
- 不把单机 Kubernetes 当作高可用方案。

## 运行拓扑

### 本地生产式运行

```text
Cloudflare named tunnel（切换生产域名时启用）
  -> RoomTalk app :3012
       -> PostgreSQL 17（唯一持久化业务数据）
       -> Redis 7（presence、Socket.IO adapter、短 TTL cache）
       -> Tigris/S3（媒体与异地备份）
       -> E2B / AI providers（外部服务）
```

根目录 `compose.yaml` 是本地事实源。PostgreSQL 使用 named volume；Redis 在 `PERSISTENCE_STORE=postgres` 下不承载不可恢复业务数据，因此可无持久卷重建。`.env.compose` 保存本地密钥且不进入 Git。

### Fly 云端运行

根 `Dockerfile` 仍构建同一前后端镜像；`fly.toml` 不引用 Compose。云端通过环境变量提供 `DATABASE_URL`、`REDIS_URL`、媒体和 Code Agent 密钥。事件同步属于应用/数据库 schema，不依赖部署平台。

### AWS 目标映射

```text
RoomTalk image       -> ECS Fargate（默认）或 EKS Deployment
PostgreSQL           -> RDS PostgreSQL
Redis                -> ElastiCache
Tigris-compatible S3 -> Amazon S3
Cloudflare/Fly edge  -> ALB + Route 53/CloudFront（按需要）
```

如果未来采用 EKS，数据库仍优先放 RDS；不把单机 PostgreSQL PVC 作为迁移接口。

## 持久化数据模型

```sql
CREATE TABLE room_event_streams (
  room_id TEXT PRIMARY KEY,
  head_seq BIGINT NOT NULL DEFAULT 0,
  min_available_seq BIGINT NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE room_events (
  room_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  entity_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, seq)
);
```

`room_event_streams` 独立于 `rooms`，这样 `room.deleted` tombstone 可以在房间行删除后继续存在到 retention 到期。

每个房间写事务必须：

1. 锁定/递增对应 `head_seq`；
2. 写入规范化 `rooms` / `room_messages` 状态；
3. 用返回序号插入一个语义事件；
4. 如需后台任务，在同一事务插入 `outbox_events`；
5. 提交成功后才广播 Socket.IO 通知。

同一业务操作可用一个事件携带多个精简实体，避免一个 Code Agent turn 产生数百个日志行。事件不得携带不受控的大型 tool output；大型内容通过实体 ID/对象引用按需读取。

## 事件类型

首版固定以下可见事件：

| 事件 | 规范 payload | 客户端动作 |
| --- | --- | --- |
| `messages.upserted` | 精简 canonical messages | 按 ID upsert 并按 position 排序 |
| `messages.deleted` | `messageIds` | 删除已加载实体 |
| `history.truncated` | 边界 ID/position 与可选 replacement | 删除边界外窗口 |
| `history.cleared` | 空对象 | 清空消息窗口和历史 cursor |
| `room.updated` | 完整 canonical Room | 替换房间对象 |
| `room.deleted` | room ID/tombstone | 清理房间、权限和本地缓存 |

流式 `ai_chunk` 继续作为低延迟临时事件。最终 AI 消息、错误状态和用量写入后，通过 `messages.upserted` 成为可重放事实。

## 快照与增量协议

### 首次/重置快照

客户端请求 `get_room_snapshot`。服务端在一致数据库快照内读取房间、最新有界消息页和事件 head：

```json
{
  "roomId": "r1",
  "snapshotSeq": 800,
  "room": {},
  "messages": [],
  "hasMore": true,
  "oldestMessageId": "m1"
}
```

旧历史继续按 `beforeMessageId` 分页；历史分页 cursor 与事件序列相互独立。

### 增量读取

客户端请求：

```json
{
  "roomId": "r1",
  "afterSeq": 800,
  "limit": 500,
  "maxBytes": 262144
}
```

服务端返回事件、有界 head 和 retention 下界：

```json
{
  "events": [],
  "headSeq": 825,
  "minAvailableSeq": 500,
  "hasMore": false
}
```

如果 `afterSeq < minAvailableSeq - 1`，返回 `CURSOR_EXPIRED`，客户端丢弃该房间消息缓存并重新请求快照。

### 客户端应用规则

- `seq <= lastAppliedSeq`：重复投递，忽略；
- `seq === lastAppliedSeq + 1`：按 reducer 应用并持久化新 cursor；
- `seq > lastAppliedSeq + 1`：暂停实时应用，请求缺失事件；
- 快照请求期间先缓存实时事件，接受快照后只重放 `seq > snapshotSeq` 的事件；
- Socket.IO 是唤醒提示，`room_events` 才是恢复事实源。

## 日志清理而非“合并”

状态表在每次写事务中已经更新，因此事件不需要定期合并回 `messages`。后台只删除连续旧前缀：

1. 按时间、条数和字节配置 retention；
2. 只删除 `seq < cutoff` 的完整前缀；
3. 不重排、不重编号、不删除中间事件；
4. 更新 `min_available_seq`；
5. 老客户端通过 `CURSOR_EXPIRED -> snapshot` 恢复。

首版先保留 7 天或每房间最多 10,000 个事件，任一上限触发时裁掉更旧前缀；上线后以事件字节、reset 比率和离线时长调整。

## `room_events` 与 AI Outbox

二者不能合并：

| 属性 | `room_events` | `outbox_events` |
| --- | --- | --- |
| 消费者 | 所有有权客户端 | 一个 Worker |
| 读取 | 可重复、按 cursor | claim/retry |
| 生命周期 | retention 后删前缀 | processed/failed |
| 目的 | 状态收敛 | 可靠执行副作用 |

一次“发送并询问 AI”事务可以同时写消息、`messages.upserted`、`assistant_run` 和 `ai.run_requested` outbox。Worker 完成后再写最终消息事件。

## 直接替换与迁移边界

本工程不实现旧同步协议兼容层：

1. schema migration 创建 stream/event tables，并以当时状态作为 baseline；
2. 客户端和服务端在同一发布中切换 `snapshotSeq/afterSeq`；
3. 旧缓存数据库名称升级，旧 `messageVersion` cache 不再读取；
4. 旧 PWA bundle 如果连接新服务，协议握手返回 `UPGRADE_REQUIRED` 并强制刷新；
5. 实现完成后删除运行时代码中的 `messageVersion`、`roomVersion` 比较；
6. 数据库旧列在最终 schema migration 中删除，而不是继续双写。

本地和 Fly 必须同时运行同一协议版本。生产切换可一次完成，但必须先在本地恢复生产副本并跑完整验收。

## 备份和直接基础设施切换

Fly/Supabase 到本地采用维护窗口：停止写入和 AI worker，生成最终 custom-format dump，恢复到 Compose PostgreSQL，执行 schema migration，使用临时 tunnel 验证，再切 Cloudflare route。开放本地写入后若需回滚，必须先把本地新增数据恢复回云端，不能只改 DNS。

Compose 提供按需备份：

```bash
docker compose --profile ops run --rm postgres-backup
```

本地卷不是备份。生产前必须配置异地复制和经过验证的 restore 流程。

## 验收门槛

### 数据一致性

- 每个成功的可见持久化写入恰好推进一个房间事件序列；
- 事务失败不能留下事件或广播；
- 重复 idempotency key 不产生第二个业务事件；
- insert/update/delete/truncate/clear/retry/edit-and-ask/media completion/AI finalization 全覆盖；
- PostgreSQL 和 Redis contract 行为一致。

### 客户端恢复

- 重复、乱序、缺口、分页、多 tab、BFCache、冷启动可收敛；
- snapshot 与 live event 竞态不丢消息；
- cursor 过期只触发一次有界重置；
- 不再发送 `baseMessageVersion`，不再比较 `messageVersion`。

### 运行环境

- `docker compose config` 成功；
- Compose PostgreSQL/Redis/app health checks 全绿；
- `/api/status` 报告 `persistenceStore=postgres`；
- server tests、client tests 和两端 production build 通过；
- Fly 配置仍可使用根 Dockerfile 构建，且未依赖 Compose 专有路径。

实施状态和实际证据记录在 [进度文档](room-event-sync-portable-deployment-progress.zh.md)。
