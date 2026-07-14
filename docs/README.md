# RoomTalk Documentation

[中文](README.zh.md)

Status: Current index
Updated: 2026-07-13

This index separates current sources of truth from runbooks, subsystem references, engineering retrospectives, completed plans, and reports. Historical documents remain first-class engineering evidence; their original dates and decisions are preserved.

## Status Vocabulary

- **Current**: describes the implementation or operating contract now. Check its `Updated`/`Verified` date.
- **Runbook**: an executable operational procedure with prerequisites, rollback boundaries, and verification.
- **Retrospective**: evidence and lessons from completed engineering work. Concrete counts and file lines may be historical snapshots.
- **Historical plan**: records design evolution and review reasoning; it is not the current operating contract.
- **Report**: a bounded audit or review tied to a named date or commit range.

Source code and tests are always the final authority. Start with the current architecture, then follow subsystem links when deeper evidence is needed.

## Repository Guides

| Guide | English | 中文 |
| --- | --- | --- |
| Product and architecture overview | [README](../README.md) | [README](../README.zh.md) |
| Client package | [Client guide](../client-heroui/README.md) | [Client 指南](../client-heroui/README.zh.md) |

## Current Architecture and Product Contracts

| Topic | English | 中文 |
| --- | --- | --- |
| Room reliability | [Architecture](room-reliability-architecture.md) | [架构](room-reliability-architecture.zh.md) |
| Code-agent runtime | [Architecture](code-agent-runtime-architecture.md) | [架构](code-agent-runtime-architecture.zh.md) |
| E2B sandbox artifact | [Artifact contract](code-agent-sandbox-artifact.md) | [Artifact 合约](code-agent-sandbox-artifact.zh.md) |
| Sandbox daemon | [Runtime and protocol](sandbox-daemon-plan.md) | [运行时与协议](sandbox-daemon-plan.zh.md) |
| Room-context CLI | [Design and implementation](codex-room-context-cli-design.md) | [设计与实现](codex-room-context-cli-design.zh.md) |
| Static publishing | [Implementation](code-agent-static-publish-implementation.md) | [实现](code-agent-static-publish-implementation.zh.md) |
| Model access | [Model access](code-agent-model-access.md) | [Model access](code-agent-model-access.zh.md) |
| Configuration | [Configuration](configuration.md) | [配置](configuration.zh.md) |

## Operations and Runbooks

| Operation | English | 中文 |
| --- | --- | --- |
| Production deployment | [Deployment guide](../DeploymentGuide.md) | [部署指南](../部署指南.md) |
| Redis durable to PostgreSQL durable | [PostgreSQL rollout](postgres-rollout-runbook.md) | [PostgreSQL 上线](postgres-rollout-runbook.zh.md) |
| PostgreSQL application role | [App-user runbook](postgres-app-user-runbook.md) | [应用用户 runbook](postgres-app-user-runbook.zh.md) |
| Legacy media bodies | [Media migration](image-object-storage-migration-runbook.md) | [媒体迁移](image-object-storage-migration-runbook.zh.md) |
| Contributor workflow | [Contributing](../CONTRIBUTING.md) | [贡献指南](../CONTRIBUTING.zh.md) |
| Security boundaries | [Security](../SECURITY.md) | [安全](../SECURITY.zh.md) |

## Engineering Retrospectives

| Engineering line | English | 中文 |
| --- | --- | --- |
| PostgreSQL production migration | [Retrospective](postgres-migration-development-summary.md) | [复盘](postgres-migration-development-summary.zh.md) |
| Tool-event ordering | [Ordering record](code-agent-tool-ordering-fix-plan.md) | [顺序记录](code-agent-tool-ordering-fix-plan.zh.md) |
| A2UI streaming | [Implementation record](a2ui-streaming-implementation.md) | [实现记录](a2ui-streaming-implementation.zh.md) |
| Mobile keyboard/viewport | [Fix record](mobile-keyboard-viewport-fix.md) | [修复记录](mobile-keyboard-viewport-fix.zh.md) |
| CI/CD optimization | [Build retrospective](ci-cd-build-optimization.md) | [构建复盘](ci-cd-build-optimization.zh.md) |
| Codex app-server integration | [Progress record](code-agent-app-server-integration-progress.md) | [进展记录](code-agent-app-server-integration-progress.zh.md) |
| GitHub connector research | [Research](github-connector-research.md) | [调研](github-connector-research.zh.md) |

## Historical Design and Completed Plans

| Topic | English | 中文 |
| --- | --- | --- |
| Original code-agent sandbox | [Plan](code-agent-sandbox.en.md) | [方案](code-agent-sandbox.md) |
| Real runner phase 6 | [Plan](code-agent-phase6-real-runner-plan.md) | [方案](code-agent-phase6-real-runner-plan.zh.md) |
| Codex backend spike | [Spike](code-agent-codex-backend-spike.md) | [Spike](code-agent-codex-backend-spike.zh.md) |
| Codex subscription CLI path | [Plan](codex-cli-subscription-backend-plan.md) | [方案](codex-cli-subscription-backend-plan.zh.md) |
| Workspace UI | [Plan](code-agent-workspace-ui-plan.md) | [方案](code-agent-workspace-ui-plan.zh.md) |
| Identity and permissions | [Plan](identity-code-agent-permission-plan.en.md) | [方案](identity-code-agent-permission-plan.md) |
| Static-publish requirements | [Requirements](code-agent-static-publish-requirements.md) | [需求](code-agent-static-publish-requirements.zh.md) |
| AI-run outbox worker | [Migration plan](ai-run-outbox-worker-migration-plan.md) | [迁移方案](ai-run-outbox-worker-migration-plan.zh.md) |
| PostgreSQL persistence | [Completed plan](postgres-persistence-plan.en.md) | [已完成方案](postgres-persistence-plan.md) |
| PostgreSQL test coverage | [Coverage plan](postgres-test-coverage-plan.md) | [测试方案](postgres-test-coverage-plan.zh.md) |
| E2E user flows | [Plan](e2e-user-flows-plan.md) | [方案](e2e-user-flows-plan.zh.md) |

## Requirements, Audits, and Reports

| Report | English | 中文 |
| --- | --- | --- |
| Media gestures | [Requirements](media-viewer-gesture-requirements.md) | [需求](media-viewer-gesture-requirements.zh.md) |
| Migration completion | [Audit](migration-completion-audit.md) | [审计](migration-completion-audit.zh.md) |
| Documentation | [Audit](documentation-audit.md) | [审计](documentation-audit.zh.md) |
| Code review 2026-07-12 | [Review](code-review-2026-07-12.md) | [Review](code-review-2026-07-12.zh.md) |
| UI/UX audit | [Report](../output/ui-ux-audit/ui-ux-audit-2026-07-10.en.md) | [报告](../output/ui-ux-audit/ui-ux-audit-2026-07-10.md) |
| Commit-range review | [Review](../COMMIT_REVIEW.en.md) | [Review](../COMMIT_REVIEW.md) |
| Visual design reference | [Reference](../DESIGN.md) | [参考](../DESIGN.zh.md) |

## Interview Guide

[RoomTalk interview preparation](interview-preparation.html) is a single bilingual HTML document. It is intentionally not linked from the top-level README.
