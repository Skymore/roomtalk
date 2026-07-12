# E2E 用户流程方案

[English](e2e-user-flows-plan.md)

状态：已实施的历史方案
复核：2026-07-12

> 本文记录最初 rollout 计划与当前本地执行入口；脚本以 `client-heroui/package.json` 为准。

## 目标

建立 browser-level regression coverage，捕捉“组件看起来正常，但真实用户无法完成任务”的故障，例如 room card 无法打开、modal 自动关闭、socket 更新没有进入页面、AI stream 完成却缺少 metadata。

E2E 补充 unit、component、API 与 socket tests，不替代它们。

## 测试策略

- 使用 Playwright 驱动真实浏览器；
- E2E 启动真实 frontend 与 backend；
- Redis 使用隔离 DB，默认测试路径为 DB 15；
- PostgreSQL 覆盖使用显式、可丢弃的测试 database；
- 每个测试生成唯一 room name/client identity，降低相互污染；
- AI 流程使用受控 test provider，不调用真实外部模型；
- 断言用户可见结果，不绑定组件内部实现。

## Stage 1：E2E Harness

加入 Playwright config、package scripts、webServer startup、test-only environment guard、trace/screenshot/video on failure 和稳定的 data cleanup。Harness 必须能在本地一条命令运行，也能为 CI 提供同样入口。

验收：空环境可启动；测试失败保留证据；测试不会连接生产 Redis/PostgreSQL；重复运行不依赖上一次数据。

## Stage 2：核心 Room 与 Message

覆盖：

- 首次身份/昵称设置；
- 创建、加入、离开与重新打开 room；
- 房间列表、saved rooms 与失效 room 清理；
- 普通消息发送与多客户端接收；
- reply、edit、delete、reaction；
- room settings、posting hours、member role 与 transfer/delete 的允许/拒绝路径；
- reload/reconnect 后 history 和排序一致。

关键断言以 durable history 为准，同时确认 optimistic UI 不产生 duplicate。

## Stage 3：AI、Media、Sharing 与 Reconnect

覆盖 controlled AI streaming、role/model metadata、失败与 startup recovery；图片/视频/文件/贴纸/语音的选择、上传、显示与错误；分享/邀请入口；网络断开重连后 room、message、stream status 与 pending UI 的恢复。

涉及对象存储的流程用 test storage/config，不向生产 bucket 写入。需要真实外部服务的 smoke 与 deterministic E2E 分开。

## Stage 4：CI 与部署集成

当前主要入口：

```bash
cd client-heroui
npm run test:e2e
npm run test:e2e:postgres
```

Redis 模式使用隔离 DB。PostgreSQL 命令必须要求安全的 test database，并配合 Redis realtime。CI 保存 Playwright report 与 failure artifacts，同时避免把 external-service flakiness 伪装为产品 regression。

## Commit 与交付边界

原计划按 harness、core flows、extended flows、CI/deployment integration 分批提交，使失败可以定位到能力层。最终交付要求：

- 核心用户旅程在 Redis durable 模式通过；
- 高风险持久化旅程在 PostgreSQL durable + Redis realtime 模式通过；
- 多客户端、reload/reconnect 与顺序问题有稳定断言；
- test data 与 production credential 明确隔离；
- README/贡献指南记录可执行命令和失败证据位置。

PostgreSQL 专项矩阵见 [迁移后测试覆盖方案](postgres-test-coverage-plan.zh.md)。
