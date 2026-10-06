# Personal Agent：Codex 优先实施计划

[English](personal-agent-implementation-plan.md)

状态：实现完成，发布验证中
更新：2026-10-05

## 产品范围

在 RoomTalk 增加独立的个人 Agent 入口。第一版每个登录账号一个 Agent，采用 Muse 的长期主聊天、专题聊天、头像状态、目标追踪和活动记录布局。执行器固定为 `codex-app-server`，复用现有 E2B 工作区、回合、审批、队列、文件和成果能力。

本次完成后部署现有本地生产服务，并验证公网实际行为。本版不引入 OpenMuse/CopilotKit Gateway，也不增加邮箱、支付、连接器市场或其他运行后端。

## 模型认证

本次首发复用系统现有的 Codex 订阅连接，执行器固定为 app-server；不新增 API provider 或 OAuth 应用。模型认证与执行器保持分离，之后可以接入 API。

官方限制旧 app-server 认证用于商业或托管服务。公开托管的订阅产品需要适用的 Sign in with ChatGPT 接入资格；本次复用已有连接不代表取得该资格，技术登录成功不能作为托管授权证明。

官方来源：

- [Codex app-server 认证限制](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [Sign in with ChatGPT 套餐使用](https://developers.openai.com/siwc/token-sharing-open-source)
- [Muse 产品设计](https://introducing.muse.ai/)

## 功能和数据边界

1. 登录后创建个人资料和私密主聊天；资料包含名字、头像、做事偏好和记忆。
2. 专题聊天和目标执行复用 `codeAgent` room，但记录个人所有者与主/任务类型。
3. 个人资料、记忆、目标、日程保存在 PostgreSQL；沙箱仅承载执行与工作文件。
4. 私密聊天在列表、加入、消息、媒体、工作区、实时订阅、上下文读取上检查所有者，不允许普通房间分享、成员邀请或转移所有权。
5. 记忆可查看、修改、删除；每次执行读取当前个人资料，并将其传给 Codex，不把内部上下文重复写进聊天。
6. 目标支持手动、每日、每周执行，保存本地时间和时区；可修改、暂停、删除、立即运行。
7. 后台任务先持久写入执行请求，再由现有回合队列执行；重启后恢复，多个 App 实例不得重复认领同一次调度。
8. 页面关闭不取消执行。任务状态和结果可在活动页回看；完成时使用现有账户推送设施。

## 界面

- 桌面侧栏和手机底栏增加“个人 Agent”。
- 个人首页显示头像、名字、当前工作状态与主聊天入口。
- 聊天、目标、活动、记忆/设置分区保持简洁；专题聊天可重新打开。
- 文件和成果沿用当前工作区面板；开发工具收到高级入口。
- 所有按钮连接真实持久化或运行能力，反馈沿用 `StatusMessage`。

## 实施步骤

- [x] 添加向前迁移、资料/目标仓储和原子调度认领。
- [x] 添加个人 API 与所有者授权，封闭普通房间入口泄露路径。
- [x] 接入 Codex 个人上下文、后台调度与完成通知。
- [x] 实现桌面和手机个人入口、聊天、目标、活动、记忆设置。
- [ ] 完成首发 Codex 认证路径并验证真实回合。
- [x] 运行授权/仓储/调度/会话测试、客户端测试和双方构建。
- [ ] 通过真实 UI 验证主聊天、专题任务、记忆、目标、刷新恢复和私密性。
- [ ] 推送 `origin/master`，核对生产 checkout，再部署。
- [ ] 验证本地和公网 readiness、部署后的页面入口，以及真实 Codex 沙箱记忆读写。

## 发布要求

新增迁移只能追加，不能更改已经部署的迁移。本次扩展沙箱内的 `roomtalk memory` 工具，因此必须遵循 `CLAUDE.md` 的 runner 版本、E2B artifact 重建和生产 pin 更新规则，并验证实际沙箱工具与记忆写回。

验证应覆盖第二个账号直接访问个人 room ID、多个实例的调度认领、任务持久化后重启恢复、时区和夏令时，以及浏览器离开页面后仍执行。不能用只有 mock runner 的测试宣称实际 Codex 可用。

发布命令：`node scripts/local-production.mjs --profile edge up -d --build`。源码推送、Compose 发布、E2B artifact 状态和公网 smoke 分开记录。

## 验证记录

- 前后端生产构建通过；授权、持久化、调度、会话及客户端相关测试通过。
- 独立 PostgreSQL 数据库验证并发主聊天创建、记忆 CAS、原子调度认领、队列持久化与回滚，5 项通过。
- Runner/broker/CLI/app-server/daemon/ACP Python 测试 83 项通过。
- E2B artifact `roomtalk-code-agent-2026-10-05-personal-memory-v1` 已构建并发布；runner 版本 `0.1.55`。
- 浏览器端到端验证、生产部署和真实 Codex 记忆读写仍在进行。
