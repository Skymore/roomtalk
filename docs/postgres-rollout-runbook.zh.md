# PostgreSQL 上线 Runbook

[English](postgres-rollout-runbook.md)

状态：旧 Redis 到 PostgreSQL 导入 runbook
Runtime 合约更新：2026-07-20

当前服务端只接受 `PERSISTENCE_STORE=postgres`。Redis 仍连接 Socket.IO、实时 membership/session、pub/sub、model-gateway counter 和有界最近消息 cache，但不再是 durable serving authority。当前本地/AWS 部署与 PostgreSQL 到 PostgreSQL 切换以[可迁移部署设计](room-event-sync-portable-deployment.zh.md)为准。

## 支持的存储模型

| `PERSISTENCE_STORE` | Durable 事实源 | Realtime coordination/cache | 简写 |
| --- | --- | --- | --- |
| `postgres` | PostgreSQL | Redis | `R+P` |

Redis 仍用于 Socket.IO scaling、presence、socket session、pub/sub、counter 和有界最近消息 cache。旧 Redis durable 实现只保留给该 importer 读取遗留数据，以及 contract test 验证迁移语义。

## 目标

`migrate:redis-to-postgres` 把旧 Redis durable snapshot 导入强制 PostgreSQL 模型，迁移：

- room、完整 message history、member、save、password hash、AI cost total；
- Code Agent turn 和 media metadata；
- pending media upload、audio transcription、assistant run、outbox event；
- push subscription、client account/link、password、auth token、nickname；
- Codex/GitHub connection record。

刻意不复制 realtime/cache state：presence、socket session、Socket.IO pub/sub、recent-message cache、idempotency/expiry index、live Code Agent room lease/fence counter。这些状态在 cutover 后重建或重新获取。Codex auth-refresh lease 字段会被清空，但 durable connection record 会复制。

该命令是 cutover tool，不是通用 Redis backup/restore，也不是 `R+P` 到 `R` 的 reverse synchronizer。

## 必需输入

- `REDIS_URL`：已存 Redis。
- `DATABASE_URL`：目标 PostgreSQL。
- 托管 PostgreSQL 通常设 `POSTGRES_SSL=true`。
- `POSTGRES_SSL_REJECT_UNAUTHORIZED=true` 保持默认证书校验；只对有意使用自签名证书的环境改为 `false`。
- 可选 provider CA：优先 `POSTGRES_SSL_CA_BASE64`，或 `POSTGRES_SSL_CA`。
- 专用非 superuser application role。Admin 可使用 `npm run provision:postgres-app-user` 创建/更新并授权当前 table/sequence。

## Preflight

1. 检查当前部署健康：

   ```bash
   curl https://your-app.example.com/api/status
   ```

2. 确认 migration host 可访问 Redis：

   ```bash
   redis-cli -u "$REDIS_URL" ping
   ```

3. 确认新代码已部署或可本地运行：

   ```bash
   cd server
   npm run build
   npm test
   ```

4. 对 Redis 和 PostgreSQL 做可恢复 backup/snapshot，记录时间和保留策略。

## Dry Run

Dry-run 会读取并解析所有支持的 Redis durable record，但不初始化或写 PostgreSQL：

```bash
cd server
REDIS_URL="redis://..." npm run migrate:redis-to-postgres -- --dry-run
```

检查：

- `roomsRead` 与 Redis room 数量一致；
- `messagesRead` 与交叉 inventory 数量合理；
- room-related count 和每个 `globalRecordsRead` 分类与独立 Redis inventory 一致；
- `failures` 为空。

Invalid JSON 或 room save 缺失 `savedAt` counterpart 会 fail closed，不伪造数据。

## 正式迁移

最终迁移必须在 write freeze/maintenance window 中运行。Script 按 room 用 Redis source of truth 覆盖 PostgreSQL message history；迁移中仍接收的 Redis 写入可能不进 PostgreSQL。真正零停机需要先实现 dual-write/outbox 和对账。

推荐 Fly final-sync：

1. 公告 maintenance window。
2. Cordon/stop serving machine，使用户不能创建新 Redis durable write。
3. 从受信 migration host 执行：

   ```bash
   cd server
   REDIS_URL="redis://..." DATABASE_URL="postgres://..." npm run migrate:redis-to-postgres
   ```

4. 部署 PostgreSQL-only durable runtime 与相关 secret。
5. Restart/uncordon machine 并验证。

迁移是幂等的：

- room 和 related durable record 按 stable key upsert；
- message history 按 room replace，重跑不重复 message；
- AI cost 使用 Redis 精确 total，不做 increment；
- auth token `lastUsedAt` 被保留，live lease ownership 不保留。

预期：

- 无 failure 时 `roomsWritten == roomsRead`；
- `messagesWritten == messagesRead`；
- 每个 room-related/global written count 与 read count 相等；
- 重跑不产生 duplicate 或累加 cost。

## Cutover

Fly 示例：

```bash
fly secrets set PERSISTENCE_STORE="postgres"
fly secrets set DATABASE_URL="postgres://..."
fly secrets set POSTGRES_SSL="true"
fly secrets set POSTGRES_SSL_CA_BASE64="..."
fly secrets set ROOM_MESSAGES_CACHE_TTL_SECONDS="30"
```

其他平台在对应 secret manager 设置相同变量。替换 App 前用 `MIGRATION_DATABASE_URL` 执行 `npm run migrate:schema`；Compose 通过一次性 `migrate` service 完成，Kubernetes/AWS 应使用 pre-deploy Job。App 的 `DATABASE_URL` 使用专用 DML role，启动时只做 checksum 校验。

## 验证

1. `/api/status` 报告 `persistenceStore: "postgres"` 和预期 room count。
2. 打开应用验证：
   - 已存 room card 和 history；
   - text send/edit/delete；
   - AI streaming placeholder 只有一个 final durable message；
   - refresh 后 final response 仍存在；
   - member/auth/media/Code Agent connection 的受影响流程。
3. 观察 PostgreSQL connection error、Redis cache error 和 `ai_persistence_error`。

## 回滚

Redis 不再是受支持 runtime 回滚目标。回滚窗口内保留切换前 PostgreSQL 数据库或已验证 dump 为只读。恢复写入前若验证失败，restore/failover 到该 PostgreSQL 点并部署上一版兼容应用镜像。一旦新目标接受了写入，任何数据库级回滚前都必须先协调这些新增写入；只改 DNS 会丢数据。

## 清理窗口

只有在 PostgreSQL 经历正常生产流量窗口、migration/status count 已对账、configuration rollback window 已明确关闭，且 PostgreSQL backup/restore 成为 durable recovery path 后，才能考虑清理遗留 Redis durable data。

即使清理旧 durable key，Redis 仍是 Socket.IO adapter 和 realtime room membership 的必需组件。
