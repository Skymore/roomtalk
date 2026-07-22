# PostgreSQL App User Runbook

[中文](postgres-app-user-runbook.zh.md)

Status: Current PostgreSQL role-hardening runbook
Updated: 2026-07-22

RoomTalk now separates schema mutation from serving. A one-shot migration job
uses `MIGRATION_DATABASE_URL` (or `DATABASE_URL` as a local fallback), while the
App calls read-only `PostgresStore.verifySchema()` before becoming ready.

This runbook replaces a broad runtime owner with a DML-only `roomtalk_app`
role. The bundled single-host Compose database may continue using one owner
credential; managed PostgreSQL/RDS should use a separate migrator credential.

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
- grants database connect and schema usage, but not schema creation;
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

Only switch after the role has been verified. Keep the owner/DDL URL as
`MIGRATION_DATABASE_URL`, set `DATABASE_URL` to the application role, and run
the normal deployment so migration completes before the App is replaced:

```bash
node scripts/local-production.mjs --profile edge up -d --build
```

Verify migration completion, read-only schema verification, room-event listener registration, and
public health immediately:

```bash
node scripts/local-production.mjs --profile edge logs --tail=200 app
curl -fsS http://127.0.0.1:3012/api/status
curl -fsS https://room.ruit.me/api/status
```

Rollback is the previous known-good Keychain database values, followed by the
same app reconcile and verification. Keep the admin-capable role as a separate
emergency/migration credential; never expose it to the browser or sandbox.

## Role Boundary

The supported managed-database boundary is two roles:

- `roomtalk_migrator`: used by deployment to run schema migrations.
- `roomtalk_app`: used at runtime with only DML privileges.

The migration job records checksums in `schema_migrations`; the App needs only
`SELECT` there. Do not restore schema ownership or `CREATE` merely to make a
missed migration pass—fix the deployment ordering instead.
