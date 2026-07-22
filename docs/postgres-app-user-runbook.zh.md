# PostgreSQL 应用用户 Runbook

[English](postgres-app-user-runbook.md)

状态：当前 PostgreSQL role 加固 runbook
更新：2026-07-22

RoomTalk 已把 schema mutation 与 serving 分开：一次性 migration job 使用 `MIGRATION_DATABASE_URL`（本地可回退 `DATABASE_URL`），App 只调用只读 `PostgresStore.verifySchema()` 后进入 ready。

本 runbook 用只具备 DML 权限的 `roomtalk_app` 替换过度宽泛的 runtime owner。Bundled Compose 单机环境仍可复用一个 owner credential；managed PostgreSQL/RDS 应使用独立 migrator credential。

## 创建或更新 Role

使用 administrative `DATABASE_URL` 运行：

```bash
cd server
APP_DATABASE_USER=roomtalk_app \
APP_DATABASE_PASSWORD='...' \
DATABASE_URL='postgres://admin:...@host/db' \
npm run provision:postgres-app-user
```

可选 `APP_DATABASE_SCHEMA`，默认 `public`。Script 会：

- 创建或更新 login role；
- 授予 database connect 和 schema usage，不授予 schema create；
- 对当前 RoomTalk table/sequence 授予运行所需 DML 权限；
- 更新 default privilege，使 startup 后新建 object 可用；
- 拒绝不安全 role/schema identifier。

Password 只存在 secret manager/当前 process environment，不写入仓库。

## 切换前验证

1. 用 application URL 连接：

   ```bash
   psql "$APP_DATABASE_URL" -c 'select current_user, current_database();'
   ```

2. 在非生产数据库运行 server build/test/smoke。
3. 用 application role 启动 server，确认只读 `verifySchema()` 成功且 `/api/status` 在线。
4. 验证 room/message/member/auth/media/turn 基础读写和 schema migration table。
5. 确认 role 不是 superuser，不能访问其他 database/schema。

不要在服务着流量时第一次测试 role privilege。

## 切换生产

1. 保留当前 owner/admin URL 作为 `MIGRATION_DATABASE_URL`，不供 runtime 使用。
2. 在不打印 JSON 的前提下，把 `DATABASE_URL` 切为 application role。
3. 执行 `node scripts/local-production.mjs --profile edge up -d --build`，让 migration 先完成再替换 App。
4. 验证 migration checksum、只读 schema verify、room-event listener、loopback/公网 status、新旧 room/message 与受影响 worker。
5. 查看 permission denied、schema ownership 和 sequence error。

如果启动因 privilege 失败，恢复上一个已知正常 URL，收集缺失 privilege 证据，修正 provisioning 后再切换。不要通过永久 superuser runtime 解决。

## Role 边界

Managed database 的受支持边界是两个 role：`roomtalk_migrator` 由 deployment job 使用并拥有 DDL；`roomtalk_app` 只具备 DML/sequence usage。Migration job 在 `schema_migrations` 写 checksum，App 只需要读取它。若漏跑 migration，不要通过恢复 App 的 schema ownership/CREATE 来绕过，应修正 deployment ordering。
