# PostgreSQL App User Runbook

[中文](postgres-app-user-runbook.zh.md)

Status: Current PostgreSQL role-hardening runbook
Updated: 2026-07-20

RoomTalk currently calls `PostgresStore.initializeSchema()` on startup in
PostgreSQL mode. The runtime database role therefore needs enough ownership and
schema privileges to run the idempotent startup DDL in
`server/src/repositories/postgresSchema.ts`.

This runbook replaces a broad owner/runtime role with a dedicated
`roomtalk_app` role while keeping the current startup flow compatible. The
bundled Compose database uses the configured `POSTGRES_USER` as its startup
owner by default; apply this runbook deliberately when hardening that host or
when moving to managed PostgreSQL/RDS.

## Create Or Update The Role

Generate a password outside the repository:

```bash
openssl rand -base64 36 > /private/tmp/roomtalk_app_db_password
chmod 600 /private/tmp/roomtalk_app_db_password
```

Run the provisioner with an admin-capable `DATABASE_URL`:

```bash
cd server
APP_DATABASE_USER=roomtalk_app \
APP_DATABASE_PASSWORD="$(cat /private/tmp/roomtalk_app_db_password)" \
npm run provision:postgres-app-user
```

The script:

- creates or updates `roomtalk_app` with `NOSUPERUSER`, `NOCREATEDB`, and
  `NOCREATEROLE`;
- grants database connect and `public` schema usage/create privileges;
- transfers known RoomTalk table ownership to `roomtalk_app`;
- grants table and sequence access required by the application.

It only targets the known RoomTalk tables listed in the script. It does not
reassign all objects owned by `postgres`.

## Verify Before Switching

Build a connection URL using the same host/database as production, but with
`roomtalk_app` and the generated password. Then verify:

```sql
SELECT current_user;
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname = current_user;
```

Expected:

```text
current_user = roomtalk_app
rolsuper = false
rolcreatedb = false
rolcreaterole = false
```

Also run a disposable smoke test against a non-production database when
available:

```bash
TEST_DATABASE_URL="postgres://roomtalk_app:...@host:5432/message_system_test" \
npm run smoke:persistence
```

## Switch Production

Only switch after the role has been verified. Update the production Keychain
environment with the application-role database values without printing the
JSON, then reconcile only the app first:

```bash
node scripts/local-production.mjs --profile edge up -d app
```

Verify startup schema initialization, room-event listener registration, and
public health immediately:

```bash
node scripts/local-production.mjs --profile edge logs --tail=200 app
curl -fsS http://127.0.0.1:3012/api/status
curl -fsS https://room.ruit.me/api/status
```

Rollback is the previous known-good Keychain database values, followed by the
same app reconcile and verification. Keep the admin-capable role as a separate
emergency/migration credential; never expose it to the browser or sandbox.

## Future Hardening

The stricter end state is two roles:

- `roomtalk_migrator`: used by deployment to run schema migrations.
- `roomtalk_app`: used at runtime with only DML privileges.

That requires changing startup so production does not automatically run
`initializeSchema()` on every boot.
