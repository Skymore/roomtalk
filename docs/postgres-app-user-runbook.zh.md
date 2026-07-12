# PostgreSQL 应用用户 Runbook

[English](postgres-app-user-runbook.md)

状态：当前 runbook
更新：2026-07-12

RoomTalk 在 PostgreSQL 模式启动时调用 `PostgresStore.initializeSchema()`。Runtime database role 因此需要足以运行 `server/src/repositories/postgresSchema.ts` 幂等 startup DDL 的 ownership/schema privilege。

本 runbook 用专用 application role 替换过度宽泛的 `postgres` runtime role。

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
- 授予 database connect 和 schema usage/create；
- 对当前 RoomTalk table/sequence 授予运行和 migration 需要的权限；
- 更新 default privilege，使 startup 后新建 object 可用；
- 拒绝不安全 role/schema identifier。

Password 只存在 secret manager/当前 process environment，不写入仓库。

## 切换前验证

1. 用 application URL 连接：

   ```bash
   psql "$APP_DATABASE_URL" -c 'select current_user, current_database();'
   ```

2. 在非生产数据库运行 server build/test/smoke。
3. 用 application role 启动 server，确认 `initializeSchema()` 成功且 `/api/status` 在线。
4. 验证 room/message/member/auth/media/turn 基础读写和 schema migration table。
5. 确认 role 不是 superuser，不能访问其他 database/schema。

不要在服务着流量时第一次测试 role privilege。

## 切换生产

1. 保留当前 owner/admin URL 作为紧急操作凭据，不供 runtime 使用。
2. 将生产 `DATABASE_URL` 换为 application role URL。
3. 等待 rolling restart。
4. 验证 startup schema、status、新旧 room/message 和受影响 worker。
5. 查看 permission denied、schema ownership 和 sequence error。

如果启动因 privilege 失败，恢复上一个已知正常 URL，收集缺失 privilege 证据，修正 provisioning 后再切换。不要通过永久 superuser runtime 解决。

## 后续加固

当 schema migration 从 startup DDL 拆成独立 deployment job 后，runtime role 可进一步收紧为只拥有 DML/sequence usage，migration role 独立拥有 DDL。在完成该拆分前，过早删除 schema create/ownership 会使启动失败。
