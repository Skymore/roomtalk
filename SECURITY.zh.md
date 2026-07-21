# RoomTalk 安全

[English](SECURITY.md)

状态：当前
更新：2026-07-20

## 信任边界

RoomTalk 将可信 control plane 与不可信执行分离：

- Node control plane 拥有身份、room 授权、durable record、scoped capability 签发、object metadata 和 sandbox lifecycle。
- PostgreSQL 或 Redis 拥有 durable application fact；Redis 还拥有实时协调和有界 cache state。
- E2B sandbox 拥有可变 workspace 文件、进程、PTY、dev server 和 Agent 执行。Sandbox 输出不可信。
- Coco 和 Codex 拥有各自的推理/工具循环，但只获得当前 turn 需要的 capability。
- 浏览器只获得公开状态和用户授权的签名 URL，不获得基础设施凭据。

## 身份与房间授权

Room access 组合 client identity、可选 password/token auth、Google-linked account、durable room membership 和 owner/admin/member role。Code Agent access 是独立房间策略，默认 owner-only。每个 HTTP/socket workspace read、mutation、PTY、preview、artifact 和 Agent action 都必须重新检查权限；持有旧 token 或 URL 不代表永久授权。

## Scoped Capability

RoomTalk 为 model access、room-context read、static publish、workspace asset 和 Codex auth refresh 签发短期、用途单一的凭据。Claim 根据场景绑定获授权 client、room、turn、mode、model、budget 或 path。Plan 模式不获得 write/shell capability。

## 用户自有 Connection

Codex subscription auth 和 GitHub personal access token 属于单个用户。RoomTalk 加密存储，不向浏览器返回原始凭据，只为该用户获授权的 sandbox turn 物化 secret file。Refresh/update 路径用版本检查和 lease 防止 stale concurrent write，使用后删除 secret file。

## 媒体与发布 Artifact

私有媒体 body 位于 S3-compatible object storage（当前生产为 SeaweedFS）；durable store 只保存 metadata 和 object key。读取在 room auth 后使用短期签名 URL。Upload completion 在创建 durable message 前验证 metadata 和 object existence。公开 static artifact 会被校验、版本化并关联到仍存在的 room；public route 对 path、MIME 和响应 header 进行防御性处理。

## 输入与资源限制

Server 和 runner 边界限制 payload byte、message/context 数量、archive size、path traversal、file count、terminal/preview session、model request、usage budget、sandbox count 和 active/idle lifetime。不可信 path 根据 canonical workspace root 解析；可变更路径还会在 symlink resolution 后再检查。

## Secret 处理

- Secret 只放在平台 secret manager 或已 ignore 的本地环境文件。
- 不要提交 `.env`、auth JSON、PAT、provider key、database URL、E2B credential、private certificate 或生成的 secret file。
- 只有 browser-safe identifier 可以使用 `VITE_*`。
- Log 和 observability payload 必须脱敏 message content、token、auth material、object signature 和 prompt-sensitive data。

## 报告问题

不要在 public issue 中包含 credential、private room data、exploit detail 或 signed URL。请私下联系仓库所有者，提供受影响边界、复现条件和调查所需的最少证据。已暴露凭据应立即轮换。
