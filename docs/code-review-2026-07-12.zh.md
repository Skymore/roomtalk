# RoomTalk Code Review — 2026-07-12

[English](code-review-2026-07-12.md)

状态：按日期固定的 review 报告
Reviewed: 2026-07-12

## 范围

本轮 review 覆盖：

- server repository/store 的 Redis/PostgreSQL 持久化语义；
- AI run/outbox/streaming 恢复；
- Code Agent session/lifecycle/daemon/artifact 边界；
- workspace file/diff/PTY/preview 访问控制；
- client room/message/media/cache 与多客户端状态；
- deployment/configuration/test coverage。

这是 2026-07-12 的快照，不是永久开放的 issue list。

## 已确认问题与 Commit 边界

Review 将已确认问题按最小所有权边界拆分，避免用大范围重构掩盖具体 correctness bug。实施时每个 commit 必须有可单独验证的失败模式，并不夹带无关 cleanup。

当时重点包括：

- 大型 store/service 文件增加修改风险；
- Redis/PostgreSQL 语义必须继续用共享 contract test 锁定；
- 不能把 runtime handle 当 durable truth；
- 对 auth、room access、path 和 secret 边界应 fail closed；
- UI cache/recovery 需与 server version/ack 协议一起评审。

## 后续重构

Review 建议的结构性改进不应与紧性 bug fix 绑定：

1. 将 Redis/PostgreSQL store 按 room、message、membership、media、Agent turn 拆分，共用 contract suite。
2. 进一步缩小 socket handler 编排与 domain/service 逻辑的耦合。
3. 明确 browser cache、durable state、realtime state 和 sandbox state 的 owner。
4. 将历史 compatibility path 与当前 Codex app-server/daemon 方向隔离。
5. 继续补齐对高风险手势、移动恢复和跨存储语义的自动化验证。

## 最终验证与 Release Gate

完成标准取决于改动边界：局部变更运行 focused test；shared contract/auth/persistence/ordering 扩展 suite/build；跨 browser 运行 Playwright；真实 sandbox/artifact 改动必须 E2B 验证并同步 production pin。

只有 source、lock、artifact/template、deployment 和真实目标一致时，对应 release 才算完成。
