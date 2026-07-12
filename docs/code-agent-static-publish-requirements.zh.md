# Code Agent 静态发布需求

[English](code-agent-static-publish-requirements.md)

状态：历史需求；当前行为以实现文档为准
日期：2026-06-30
复核：2026-07-12

## 问题

Code Agent 可以在 E2B sandbox 里生成静态页面或小型前端 demo，但 sandbox URL 与生命周期绑定。Sandbox pause、销毁或重建后，该 URL 不能作为长期分享的产物。RoomTalk 因此需要一等静态发布能力，把工作区目录发布为稳定的 RoomTalk-hosted artifact。

这是 RoomTalk 暴露给 Code Agent 的 tool。Agent engine 只看到普通 tool schema；RoomTalk 负责授权、持久化、对象存储与公开 serving route。

## 用户流程

1. Code Agent room owner 要求 agent 创建并发布静态页面。
2. Agent 在当前 sandbox workspace 中生成或修改文件。
3. Agent 调用 `PublishStaticSite`，提交 root、entry、title 和可选 slug。
4. RoomTalk 校验 turn token、room ownership、路径、文件数量与大小。
5. RoomTalk 上传 versioned files、写 manifest，并返回稳定 URL 与 metadata。

## V1 范围

- 发布当前 room sandbox workspace 中的静态目录；
- 默认 `root="."`、`entry="index.html"`，允许其他入口文件；
- 使用 RoomTalk 的 local/S3-compatible object storage；
- 每个 slug 保存版本化 manifest；
- 以稳定 `/p/:slug/` route 提供最新成功版本；
- 返回 URL、slug、entry、file count、byte size 和 version ID；
- 使用 RoomTalk 签发的 per-turn scoped token 保护 publish API；
- 同一 room 可以覆盖自己的 slug，禁止覆盖其他 room 的 slug；
- 发布失败时保留上一成功版本。

## 非目标

- 不运行 server-side code、SSR、database 或长期进程；
- 不把 sandbox preview URL 包装成“持久 URL”；
- 不提供任意 S3 browser credential；
- V1 不做自定义域名、CDN purge UI、复杂站点构建平台或跨 room ownership transfer；
- 不允许通过 symlink/path traversal 逃出声明的发布根目录。

## 安全要求

- publish token 同时绑定 room、turn、sandbox 与过期时间；
- server 重新检查 room access 和 posting/execution policy；
- 规范化并验证所有相对路径，拒绝 absolute path、`..` escape 与越界 symlink；
- MIME、cache header 和下载行为由 serving layer 控制；
- HTML/JS 作为不可信用户内容隔离提供，不能获得 RoomTalk app credential；
- manifest 记录 room owner、创建者、时间、版本和内容摘要，便于审计与删除；
- object-store credential 只存在于 server。

## 限制

实现必须配置单文件、总字节数、文件数、路径长度、slug 长度和请求时限上限。超限错误要可操作，不得留下半发布的 latest pointer。目录枚举和上传顺序必须确定，便于重试与内容摘要验证。

## 验收标准

- sandbox 销毁后 URL 仍能访问；
- 发布新版本后 stable route 原子切换；
- 其他 room 不能覆盖或删除该 slug；
- 无效 token、越界路径、超限和对象存储失败均返回结构化错误；
- manifest 与实际对象一致；
- 删除 room/artifact 时可按 ownership 找到所有对象；
- local 与 S3-compatible backend 通过同一 contract test；
- agent 获得足够 metadata 向用户报告发布结果。

当前数据模型、上传流程、route、清理和验证以 [静态发布实现](code-agent-static-publish-implementation.zh.md) 为准。
