# 文档审计

[English](documentation-audit.md)

状态：当前文档 inventory
审计日期：2026-07-13

本审计对仓库文档分类并记录质量控制。它不替代 [文档索引](README.zh.md)、当前架构、runbook、源码或测试。

## 文档合约

- 当前文档标注 `Updated` 或 `Verified` 日期并说明事实源。
- 历史方案和复盘保留原始语境、具体证据和决策路径；它们指向当前参考，不被改写成现在时。
- 人类文档提供英文/中文 edition 和语言切换。双语 interview HTML 保持单文件。
- `CLAUDE.md`/`AGENTS.md` 保持单一 machine-instruction 事实源；人类贡献规则位于双语 `CONTRIBUTING`。
- 顶层 README 直接展示重要技术设计，只对更深证据或操作流程做链接。

## 当前入口

| 文档 | 职责 |
| --- | --- |
| `README.md` / `README.zh.md` | 产品、技术亮点、架构、本地开发、持久化、发布模型、精选复盘和简洁导航。 |
| `docs/README.md` / `docs/README.zh.md` | 完整分类双语文档索引。 |
| `docs/room-session-controller-design*.md` | 当前客户端房间会话 ownership、状态机、epoch/resync、消息/媒体连续性、诊断日志与后端 ordering contract。 |
| `docs/code-agent-runtime-architecture*.md` | 当前 Code Agent control/execution plane、lifecycle、security、workspace、recovery、persistence 和 release 边界。 |
| `DeploymentGuide.md` / `部署指南.md` | 当前 GitHub Actions/Fly 生产 runbook。 |
| `docs/configuration*.md` | Operator-facing 配置分组与事实源边界。 |
| `CONTRIBUTING*.md` | 人类开发、验证、artifact、commit 和 release 合约。 |
| `SECURITY*.md` | 身份、授权、scoped capability、credential、media 和 sandbox trust boundary。 |
| `docs/code-agent-sandbox-artifact*.md` | 固定 E2B artifact build/acceptance/release 合约。 |
| `docs/postgres-rollout-runbook*.md` | 完整 `R` 到 `R+P` cutover 流程和回滚边界。 |

## 当前子系统参考

- room-context CLI 与受限 shell；
- sandbox daemon runtime/protocol；
- static publishing implementation；
- Code Agent model access；
- PostgreSQL application role；
- legacy media migration；
- media-viewer gesture requirements。

它们通过 docs index 和 README/架构的上下文链接保持可发现，不在每个导航区重复。

## 工程复盘

以下文档是重要证据，不是可丢弃 stale docs：

- PostgreSQL 生产迁移；
- room reliability/restore 系列；
- Code Agent text/tool ordering；
- A2UI streaming；
- mobile viewport/keyboard；
- CI/CD build optimization；
- Codex app-server integration；
- GitHub connector research。

历史 count、machine size、file line、branch 和 commit ID 会被标记为 snapshot。当前操作始终以 current runbook 和代码为准。

## 已完成方案与报告

原始 sandbox phase、backend spike、workspace UI plan、identity/permission plan、outbox migration、PostgreSQL design/test plan、E2E plan、code review、commit review、design reference 和 UI/UX audit 保留在 Historical Plans 或 Reports。其价值是推理和 review 记录，不是当前配置。

## 本轮修正的漂移

- 用当前定时/手动 dispatch GitHub Actions workflow 替换通用/手动 Fly 部署教程。
- 将生产 VM 声明修正为 `fly.toml` 的 1024 MB。
- 区分 canonical repository example 和 environment-specific browser-origin alias。
- 明确 current/historical status，不再依赖笼统 disclaimer。
- 在 README 保留关键复盘可见性。
- 补齐双语 configuration、contribution、security、architecture、runbook、subsystem、retrospective、plan 和 report。
- 为链接稳定保留 `sandbox-daemon-plan.md` 历史文件名，但标记为当前 runtime。
- 将已实现的 Room Session Controller 提升为双语当前架构入口，并把较早的 suppression/in-flight 恢复 scheduler 文档明确标记为历史记录。

## 已知产品/协议 Follow-up

- 用 stable error code 替换 room socket string/regex error，尤其是 `ROOM_NOT_FOUND`。
- 补齐 media viewer 的 pinch、zoomed swipe suppression、edge resistance、velocity-only commit、keyboard 和 single-tap delay 自动化覆盖。

这些是产品/测试 follow-up，不是把文档标记为 incomplete 的理由。

## 验证要求

- 所有 index link 可解析。
- 每个人类文档有预期 language counterpart，或明确标注 single-file bilingual。
- 中英 current doc 的 status、date、command、env name 和 architecture fact 一致。
- 文档引用的 package command、`fly.toml`、workflow trigger、artifact lock 和 source identifier 与仓库一致。
- Markdown/HTML 可解析，`git diff --check` 成功。

## 早期审计记录（2026-06-18）

早期审计发现并解决了 CI secret validation、legacy media table 重复、Agent 指令未 tracked、media-migration package entrypoint 断裂和 local Claude settings 误入 scope。它还核对了 media env rename、i18n language、统一 `media` message type、provider 描述、PostgreSQL CA 和当时的 Redis/PostgreSQL smoke/E2E。

这些结论作为 dated report 保留；当前验证记录在上文。
