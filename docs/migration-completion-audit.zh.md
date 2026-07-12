# 迁移完成审计

[English](migration-completion-audit.md)

状态：有界审计；实际操作前需阅读当前 runbook
原始审计：2026-06-26；存储迁移范围复核：2026-07-12

本审计记录 Code Agent 合并和遗留 media migration 恢复后的 migration completion 证据。其 Git branch、commit 和测试数量属于当时快照；当前以 `master`、runbook 和源码为准。

## 审计范围

| Migration line | 状态 | 当前证据 |
| --- | --- | --- |
| Redis durable 到 PostgreSQL durable | 生产已用历史 room/message/cost 范围切换；可复用命令已覆盖当前完整 `R` durable model | `migrateRedisToPostgres.ts`、focused test、PostgreSQL rollout runbook |
| PostgreSQL schema migration | Startup DDL + versioned one-time migration | `postgresSchema.ts`、`PostgresStore.initializeSchema()` 和 schema migration test |
| PostgreSQL application role | 已实现 | provisioning script 与 app-user runbook |
| Legacy base64 image 到 object storage | 已实现 | media migration script/test/runbook |
| Code Agent room/sandbox migration | 已合并 | lifecycle/archive migration、artifact metadata 和 E2B verification |

## 存储迁移复核

2026-07-12 的完整 `R -> R+P` script 覆盖：

- room、message、member、save、password、cost；
- Agent turn、media asset、pending upload、transcription；
- assistant run/outbox、push subscription；
- account/link/password/token/nickname；
- Codex/GitHub connection。

它不迁移 presence/socket/pubsub/cache/live lease 等 runtime state。Dry-run 不初始化 PostgreSQL；malformed durable JSON 和缺失 room-save timestamp 会 fail closed。写入使用 stable key/upsert、room message replacement 和 exact cost total，可幂等重跑。

## 媒体迁移证据

- Script 默认 dry-run，execute 需要 verified absolute backup file。
- Serving Fly VM 默认被 guard 拒绝。
- Legacy data URL 解析、lossless WebP 转换、object upload、message/asset replacement 和失败 cleanup 有 focused test。
- PostgreSQL store contract 覆盖 media replacement 不更改 room activity 的语义。

## 外部验证边界

本地 unit/build 不能代替：

- 真实 production PostgreSQL/Redis/object inventory 对账；
- Fly/GitHub workflow 结果；
- 真实 E2B template/backend smoke；
- production backup/restore 演练。

这些边界必须在对应操作或 release 时单独验证，不应因审计文档标记“已实现”而默认通过。

## 结论

代码层面 migration line 存在且有 guard/test/runbook，但每次真实 cutover 仍需要当时的 backup、inventory、write freeze、verification 和 rollback decision。
