# Documentation Audit

Audit date: 2026-06-18.

This file records the repository-wide documentation quality-control pass. It
classifies active docs, historical records, archival plans, and known follow-up
items. Generated cache docs such as `.pytest_cache/README.md` are intentionally
excluded.

## Active Entry Points

| Document | Status | Notes |
| --- | --- | --- |
| `README.md` | Rewritten | Current product, architecture, commands, config, persistence, media, deployment, testing, and doc map. |
| `README.zh.md` | Rewritten | Chinese mirror of the current README. |
| `CLAUDE.md` | Active | Agent/developer guide. `AGENTS.md` is a symlink to this file. |
| `DeploymentGuide.md` | Active runbook | Updated to CI-first deployment, existing Dockerfile, current secrets, and non-static pricing guidance. |
| `部署指南.md` | Active runbook | Chinese deployment guide with the same current constraints. |
| `docs/postgres-rollout-runbook.md` | Active runbook | Updated with final-sync/write-freeze requirements and PostgreSQL CA options. |
| `docs/media-viewer-gesture-requirements.md` | Active requirements | Added implementation/test status and known coverage gaps. |

## Historical Or Archival Docs

| Document | Status | Notes |
| --- | --- | --- |
| `COMMIT_REVIEW.md` | Historical | Covers `5a991ae` through `7238ebe`, not current `master`. |
| `DESIGN.md` | Visual reference | Claude-inspired reference, not the RoomTalk design source of truth. |
| `docs/postgres-persistence-plan.md` | Completed plan | Marked as historical; current schema has expanded beyond the original plan. |
| `docs/postgres-test-coverage-plan.zh.md` | Completed plan | Early “gaps” are pre-implementation state; execution status is later in the doc. |
| `docs/postgres-migration-development-summary.zh.md` | Historical summary | Still useful as migration/postmortem context. |
| `docs/code-agent-sandbox.md` | Completed historical plan | Coco sandbox/runner phases are implemented; current validation status is recorded in the document. |
| `docs/image-object-storage-migration-runbook.md` | Active runbook | Legacy base64 media migration script is restored; runbook documents dry-run, execute-mode safety checks, verification, rollback, and tests. |
| `docs/a2ui-streaming-implementation.zh.md` | Implementation record | Appears current against A2UI v0.9 integration; no action taken. |
| `docs/mobile-keyboard-viewport-fix.zh.md` | Fix record | Added current viewport/keyboard behavior notes. |
| `docs/room-reliability/*.zh.md` | Historical reliability series | Added status banners where needed; current index records the remaining stable-error-code cleanup item. |

## Known Follow-Ups

- Replace string/regex socket error handling with stable error codes, especially `ROOM_NOT_FOUND`.
- Add missing automated coverage for media-viewer pinch, zoomed-image swipe suppression, edge resistance, velocity-only commits, keyboard controls, and single-tap delay.

---

## Diff Review（2026-06-18）

对本次文档审计的全量 diff（23 文件，+514 / -777）做了深入代码的交叉验证。

### 发现的问题与处置

| # | 问题 | 状态 |
| --- | --- | --- |
| 1 | CI 缺 `DEEPSEEK_API_KEY` 校验：默认模型需要该 key，但 `fly-deploy.yml` 未检查 | **已修**，CI 加了 `require_secret DEEPSEEK_API_KEY` |
| 2 | PostgreSQL `image_assets` / `media_assets` 双表并存 | **已修**，生产 180 行全冗余，已 DROP 表 + 清理代码 |
| 3 | `AGENTS.md` 未被 Git 跟踪 | **已不成立**，已作为 symlink 提交 |
| 4 | `package.json` 里 `migrate:media-to-object-storage` 指向不存在的文件 | **已修**，当前指向 `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.ts` 并有单元测试覆盖 |
| 5 | `.claude/settings.local.json` 含个人路径 | 提交时排除，不纳入 |

### 已验证正确

- `IMAGE_*` -> `MEDIA_*` 环境变量重命名与服务端代码一致
- i18n 语言列表 `en/zh/hi/ja/ko` 与 `i18n.ts` + `languages.ts` 一致
- `MessageType` 是 `'media'` 不是 `'image'`，runbook SQL 正确
- AI provider 描述与 `aiClients.ts` 实现一致
- 所有历史文档状态标注准确
- Postgres rollout runbook 写入冻结指导和 CA 证书选项合理
- 定价段用官方链接替代过时金额正确

### 补充

- README 从 ~520 行压到 ~220 行，删掉的内容（版本历史、API/WebSocket 事件表、Upstash 文案、MIT 全文）可从代码获取，精简合理
- `DeploymentGuide.md` 和 `部署指南.md` 变更平行一致
- Fly media secret 校验已从旧 `IMAGE_*` 切到 `MEDIA_*` 口径
