# Coco / Codex 房间上下文 CLI 与受限 Shell 设计

[English](codex-room-context-cli-design.md)

状态：当前实现
已按 `master` 核对：2026-07-12

## 状态

- 方案：CLI-first，不新增 MCP server。
- 适用范围：RoomTalk Workspace 房间中的 Coco 与 Codex app-server backend；Codex CLI 只保留兼容/迁移路径，不再承接新能力。
- 数据所有者：RoomTalk。Codex thread 只保存 Codex 自己参与过的会话，不作为房间历史的权威来源。

## 问题

RoomTalk 已经把最新用户消息交给 Codex，并用 `codeAgentSessionId` 续接同一个 Codex thread。服务端也会生成 `priorMessages`，但 Codex backend 不消费它。因此：

- Codex 能记住自己在当前 thread 中见过的内容；
- 新建 Codex thread 时看不到之前的 RoomTalk 讨论；
- 其他成员或 agent 在 Codex 两轮之间发送的消息，不会自动进入 Codex thread；
- 把全部房间历史每轮复制进 prompt 会重复占用上下文，也无法自然支持分页和搜索。

## 决策

参考 OpenAgents 的 channel + agent CLI 模式，RoomTalk 将房间历史暴露为可组合 CLI：

```bash
roomtalk room history --limit 20 --json
roomtalk room history --before <message-id> --limit 20 --json
roomtalk room delta --since <message-id> --limit 50 --json
roomtalk room search --query "关键词" --limit 20 --json
roomtalk room message <message-id> --json
roomtalk site list --json
```

Codex prompt 只注入当前 RoomTalk room 身份和最短使用说明。Codex 在缺少背景、用户引用旧讨论或需要确认其他参与者意见时主动调用 CLI。默认不读取整个历史。

## 架构

```text
RoomTalk room_messages
        |
        v
CodeAgentRoomContextService
  - 签发/验证 room + client + turn 短期 token
  - 分页、增量、搜索、按 ID 读取
  - 输出安全的消息投影
        |
        v
GET /api/code-agent/room-context/*
        |
        v
trusted runner room-context broker
  - 持有 URL / token
  - 只允许 history / delta / search / message
        |
        v
turn-scoped Unix socket
        |
        v
roomtalk room ... --json
        |
        +--> Coco restricted Shell
        +--> Codex app-server command execution
        +--> legacy Codex CLI compatibility path
```

### Turn 环境

RoomTalk 启动 agent turn 时注入：

```text
ROOMTALK_CODE_AGENT_ROOM_ID
ROOMTALK_CODE_AGENT_TURN_ID
ROOMTALK_ROOM_CONTEXT_URL
ROOMTALK_ROOM_CONTEXT_TOKEN
```

URL 和 token 只进入可信 runner。runner 为该 turn 创建本地 Unix socket broker，随后从模型可见环境移除 URL/token，只下发 `ROOMTALK_ROOM_CONTEXT_SOCKET`。Coco 与 Codex app-server 都通过同一个 socket 调用 `roomtalk` CLI；legacy Codex CLI 兼容路径复用相同合约。turn 结束即关闭并删除 socket。

### Token

token 使用 HMAC 签名并包含：

- `roomId`
- `clientId`
- `turnId`
- `mode`
- `exp`
- 唯一 `jti`

API 不接受调用者指定 `roomId`，只读取 token 声明中的房间。这样即使 Codex 修改命令参数，也不能跨房间读取。

CLI 按能力分为只读面和写入面：`roomtalk room ...` 与 `roomtalk site list --json` 属于只读面；`roomtalk site publish ...` 和 `roomtalk site unpublish --slug <slug>` 属于写入面。取消发布表示下线该房间拥有的公开站点并清理其全部版本，不删除 workspace 文件。Plan 的 shell environment 只拿到 broker socket 路径，并设置 `ROOMTALK_CODE_AGENT_CLI_ACCESS=read-only`；写命令会在 CLI 入口再次拒绝。Ask（内部 `edit`）、Auto（内部 `approveForMe`）和 Full（内部 `fullAccess`）才会拿到写入凭证。旧命令 `roomtalk publish-static-site` 仅保留为发布别名；原生 `PublishStaticSite` engine tool 已删除，当前 Coco 与 Codex app-server 统一走 CLI。

Plan shell 始终关闭直接 IP 网络。room-context broker 在 sandbox 外访问 RoomTalk API，模型命令只能连接本轮 Unix socket。broker 还会再次限制路径，只接受四类 GET 读取操作，因此即使模型绕过 CLI 手写 socket 请求，也不能借 broker 调用写接口。

### 统一 Shell 权限

| 模式 | Shell | 文件系统 | 网络 | 后台进程 |
| --- | --- | --- | --- | --- |
| Plan | 前台通用命令 | OS sandbox 强制只读；仅 `/tmp` 为临时可写 | 直接 IP 网络关闭；仅放行本轮 broker Unix socket | 禁止 |
| Ask (`edit`) | 前台命令 | workspace 可写 | 开启 | 独立 `BackgroundShell` |
| Auto (`approveForMe`) | 前台命令 | workspace 可写 | 开启 | 独立 `BackgroundShell` |
| Full (`fullAccess`) | 前台命令 | sandbox 内不额外限制 | 开启 | 独立 `BackgroundShell` |

Coco 以前在 Plan 中直接过滤 `Shell`，因为 engine 的 `PermissionChecker` 只能按工具判断读写，不能可靠判断任意 shell 字符串。新实现不尝试维护“只读命令白名单”，而是提供同名的 Plan Shell，并在执行每条命令时使用 bubblewrap 建立只读 mount namespace。任意 `python`、`node` 或重定向写入都会由内核拒绝，而不是依赖命令解析。Coco 的 Plan `allowed_tools` 包含这个受限 Shell，但不包含 `Write`、`Edit` 或 `BackgroundShell`。

Codex app-server 在 Plan 中使用自定义 permission profile：继承 `:read-only`，开启网络权限框架但不允许任何 IP 域名，只在 `network.unix_sockets` 中允许本轮 broker 路径。Legacy Codex CLI 兼容路径使用同一 profile。这样 Coco 与 Codex 的安全语义一致，执行器仍各自使用其原生 sandbox。

### 消息投影

API 不直接返回数据库 `Message`：

- 保留消息 ID、类型、发送者、时间、正文、回复引用和必要的 tool 状态；
- 不返回成本、usage、AI stream owner、内部恢复字段或对象存储信息；
- 不返回 streaming 中的消息；
- 不返回完整 `toolArgs`，避免历史命令中的敏感参数再次暴露；
- 限制单条正文和单次响应规模。

当前默认 token TTL 为 30 分钟；history 默认 20 条、单次最多 100 条，单条正文最多 20,000 字符，search 只扫描最近 5,000 条消息。每次 API 调用都会重新检查房间是否存在以及该 client 是否仍满足房间的 Workspace access policy，因此撤权不必等待 token 过期。

## API

所有接口要求 `Authorization: Bearer <turn-token>`。

### 最近历史

```http
GET /api/code-agent/room-context/history?limit=20&beforeMessageId=<id>
```

返回按时间正序排列的消息、`hasMore` 和 `oldestMessageId`。

### 增量

```http
GET /api/code-agent/room-context/delta?sinceMessageId=<id>&limit=50
```

返回该消息之后的内容和下一游标。游标不存在时明确报错，不静默返回全量历史。

### 搜索

```http
GET /api/code-agent/room-context/search?query=<text>&limit=20
```

第一版对最近有界消息做大小写不敏感的文本匹配，结果按新到旧返回。以后数据量需要时可替换为 PostgreSQL FTS，而 CLI 合约保持不变。

### 精确读取

```http
GET /api/code-agent/room-context/messages/:messageId
```

### 已发布站点

```http
GET /api/code-agent/room-context/sites
```

使用同一个只读 room-context token 返回当前房间拥有的静态站点，供 `roomtalk site list --json` 使用；Plan 无需获得发布 token。

## 为什么不用 MCP

房间历史是标准的 list/search/read 数据面，Codex sandbox 已经拥有 shell 和 `roomtalk` helper。CLI 有以下优势：

- 与 `gh`、`rg`、`git` 一样可组合；
- JSON 输出可测试，也可供人类调试；
- 不增加 MCP server 生命周期和 tool catalog 上下文；
- Coco、Codex app-server 和其他 shell-based agent 可共用；
- 复用现有 `roomtalk publish-static-site` 的打包方式。

只有当 RoomTalk 需要服务没有 shell 的客户端、提供 OAuth 外部连接或 MCP resource/UI 时，再增加 MCP adapter。MCP 若加入，也应调用相同 RoomTalk API，而不是复制业务逻辑。

## 发布与回滚

`platform_tools.py` 和 Codex prompt 属于 E2B sandbox artifact。上线必须：

1. 推送 RoomTalk 源码；
2. bump artifact version；
3. 构建并发布新 E2B template；
4. smoke `roomtalk --help` 和 Codex runner；
5. 将 Fly 的 template/artifact/source ref 切到一致版本；
6. 验证 API health 和真实 sandbox 命令。

回滚时同时恢复 Fly template/artifact/source ref，避免 Node 服务与 sandbox CLI 合约不一致。
