# RoomTalk 文档

[English](README.md)

状态：当前索引
更新：2026-07-13

本索引将当前事实源、runbook、子系统参考、工程复盘、已完成方案和报告分开。历史文档仍是一等工程证据；它们的原始日期和决策会被保留。

## 状态词汇

- **当前**：描述现行实现或操作合约，需检查 `Updated`/`Verified` 日期。
- **Runbook**：包含前置条件、回滚边界和验证的可执行操作流程。
- **复盘**：已完成工程的证据和教训；具体数量与 file line 可能是历史快照。
- **历史方案**：记录设计演进与 review 推理，不是当前操作合约。
- **报告**：绑定特定日期或 commit range 的有界审计/review。

源码和测试始终是最终事实源。阅读时先从当前架构开始，再按需进入子系统证据。

## 仓库级指南

| 指南 | English | 中文 |
| --- | --- | --- |
| 产品与架构总览 | [README](../README.md) | [README](../README.zh.md) |
| Client package | [Client guide](../client-heroui/README.md) | [Client 指南](../client-heroui/README.zh.md) |

## 当前架构与产品合约

| 主题 | English | 中文 |
| --- | --- | --- |
| 房间会话恢复 | [Architecture](room-session-controller-design.md) | [架构](room-session-controller-design.zh.md) |
| Code Agent runtime | [Architecture](code-agent-runtime-architecture.md) | [架构](code-agent-runtime-architecture.zh.md) |
| E2B sandbox artifact | [Artifact contract](code-agent-sandbox-artifact.md) | [Artifact 合约](code-agent-sandbox-artifact.zh.md) |
| Sandbox daemon | [Runtime and protocol](sandbox-daemon-plan.md) | [运行时与协议](sandbox-daemon-plan.zh.md) |
| Room-context CLI | [Design and implementation](codex-room-context-cli-design.md) | [设计与实现](codex-room-context-cli-design.zh.md) |
| Static publishing | [Implementation](code-agent-static-publish-implementation.md) | [实现](code-agent-static-publish-implementation.zh.md) |
| Model access | [Model access](code-agent-model-access.md) | [Model access](code-agent-model-access.zh.md) |
| 配置 | [Configuration](configuration.md) | [配置](configuration.zh.md) |

## 操作与 Runbook

| 操作 | English | 中文 |
| --- | --- | --- |
| 生产部署 | [Deployment guide](../DeploymentGuide.md) | [部署指南](../部署指南.md) |
| Redis durable 到 PostgreSQL durable | [PostgreSQL rollout](postgres-rollout-runbook.md) | [PostgreSQL 上线](postgres-rollout-runbook.zh.md) |
| PostgreSQL application role | [App-user runbook](postgres-app-user-runbook.md) | [应用用户 runbook](postgres-app-user-runbook.zh.md) |
| 遗留媒体 body | [Media migration](image-object-storage-migration-runbook.md) | [媒体迁移](image-object-storage-migration-runbook.zh.md) |
| 贡献流程 | [Contributing](../CONTRIBUTING.md) | [贡献指南](../CONTRIBUTING.zh.md) |
| 安全边界 | [Security](../SECURITY.md) | [安全](../SECURITY.zh.md) |

## 工程复盘

| 工程主线 | English | 中文 |
| --- | --- | --- |
| PostgreSQL 生产迁移 | [Retrospective](postgres-migration-development-summary.md) | [复盘](postgres-migration-development-summary.zh.md) |
| 房间恢复与一致性 | [Series index](room-reliability/README.md) | [系列索引](room-reliability/README.zh.md) |
| 移动端 room restore | [Historical strategy](room-reliability/mobile-room-restore-strategy.md) | [历史策略](room-reliability/mobile-room-restore-strategy.zh.md) |
| Restore review 与修复 | [Historical review record](room-reliability/room-restore-review-fix-plan.md) | [历史 Review 记录](room-reliability/room-restore-review-fix-plan.zh.md) |
| Stale room update | [Analysis](room-reliability/room-update-stale-analysis.md) | [分析](room-reliability/room-update-stale-analysis.zh.md) |
| Room-update follow-up | [Follow-up](room-reliability/room-update-review-followup.md) | [Follow-up](room-reliability/room-update-review-followup.zh.md) |
| Tool-event ordering | [Ordering record](code-agent-tool-ordering-fix-plan.md) | [顺序记录](code-agent-tool-ordering-fix-plan.zh.md) |
| A2UI streaming | [Implementation record](a2ui-streaming-implementation.md) | [实现记录](a2ui-streaming-implementation.zh.md) |
| 移动端 keyboard/viewport | [Fix record](mobile-keyboard-viewport-fix.md) | [修复记录](mobile-keyboard-viewport-fix.zh.md) |
| CI/CD optimization | [Build retrospective](ci-cd-build-optimization.md) | [构建复盘](ci-cd-build-optimization.zh.md) |
| Codex app-server integration | [Progress record](code-agent-app-server-integration-progress.md) | [进展记录](code-agent-app-server-integration-progress.zh.md) |
| GitHub connector research | [Research](github-connector-research.md) | [调研](github-connector-research.zh.md) |

## 历史设计与已完成方案

| 主题 | English | 中文 |
| --- | --- | --- |
| 原始 Code Agent sandbox | [Plan](code-agent-sandbox.en.md) | [方案](code-agent-sandbox.md) |
| Real runner phase 6 | [Plan](code-agent-phase6-real-runner-plan.md) | [方案](code-agent-phase6-real-runner-plan.zh.md) |
| Codex backend spike | [Spike](code-agent-codex-backend-spike.md) | [Spike](code-agent-codex-backend-spike.zh.md) |
| Codex subscription CLI path | [Plan](codex-cli-subscription-backend-plan.md) | [方案](codex-cli-subscription-backend-plan.zh.md) |
| Workspace UI | [Plan](code-agent-workspace-ui-plan.md) | [方案](code-agent-workspace-ui-plan.zh.md) |
| Identity 与 permission | [Plan](identity-code-agent-permission-plan.en.md) | [方案](identity-code-agent-permission-plan.md) |
| Static-publish requirements | [Requirements](code-agent-static-publish-requirements.md) | [需求](code-agent-static-publish-requirements.zh.md) |
| AI-run outbox worker | [Migration plan](ai-run-outbox-worker-migration-plan.md) | [迁移方案](ai-run-outbox-worker-migration-plan.zh.md) |
| PostgreSQL persistence | [Completed plan](postgres-persistence-plan.en.md) | [已完成方案](postgres-persistence-plan.md) |
| PostgreSQL test coverage | [Coverage plan](postgres-test-coverage-plan.md) | [测试方案](postgres-test-coverage-plan.zh.md) |
| E2E user flows | [Plan](e2e-user-flows-plan.md) | [方案](e2e-user-flows-plan.zh.md) |

## 需求、审计与报告

| 报告 | English | 中文 |
| --- | --- | --- |
| Media gesture | [Requirements](media-viewer-gesture-requirements.md) | [需求](media-viewer-gesture-requirements.zh.md) |
| Migration completion | [Audit](migration-completion-audit.md) | [审计](migration-completion-audit.zh.md) |
| Documentation | [Audit](documentation-audit.md) | [审计](documentation-audit.zh.md) |
| Code review 2026-07-12 | [Review](code-review-2026-07-12.md) | [Review](code-review-2026-07-12.zh.md) |
| UI/UX audit | [Report](../output/ui-ux-audit/ui-ux-audit-2026-07-10.en.md) | [报告](../output/ui-ux-audit/ui-ux-audit-2026-07-10.md) |
| Commit-range review | [Review](../COMMIT_REVIEW.en.md) | [Review](../COMMIT_REVIEW.md) |
| Visual design reference | [Reference](../DESIGN.md) | [参考](../DESIGN.zh.md) |

## 面试资料

[RoomTalk 面试准备](interview-preparation.html) 是单文件双语 HTML。按仓库约定，它不从顶层 README 链接。
