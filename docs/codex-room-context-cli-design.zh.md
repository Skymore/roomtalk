# Codex 房间上下文 CLI 设计

## 状态

- 方案：CLI-first，不新增 MCP server。
- 适用范围：RoomTalk Workspace 房间中的 Codex CLI / Codex app-server backend。
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
roomtalk room ... --json
        |
        v
Codex CLI / Codex app-server
```

### Turn 环境

RoomTalk 启动 agent turn 时注入：

```text
ROOMTALK_CODE_AGENT_ROOM_ID
ROOMTALK_CODE_AGENT_TURN_ID
ROOMTALK_ROOM_CONTEXT_URL
ROOMTALK_ROOM_CONTEXT_TOKEN
```

这些值由 runner 写入该 turn 的 Codex shell environment policy。token 不进入普通子进程环境，只在 Codex 明确执行 `roomtalk` 命令时由 Codex 的受控 shell 环境提供。

### Token

token 使用 HMAC 签名并包含：

- `roomId`
- `clientId`
- `turnId`
- `mode`
- `exp`
- 唯一 `jti`

API 不接受调用者指定 `roomId`，只读取 token 声明中的房间。这样即使 Codex 修改命令参数，也不能跨房间读取。

默认 Plan 模式仍是文件只读；只有该 turn 同时具备房间上下文 URL 和 token 时，Codex 的只读 sandbox 才开放网络，让 CLI 可以访问 RoomTalk API。没有房间上下文能力的普通 Plan turn 继续保持断网。

### 消息投影

API 不直接返回数据库 `Message`：

- 保留消息 ID、类型、发送者、时间、正文、回复引用和必要的 tool 状态；
- 不返回成本、usage、AI stream owner、内部恢复字段或对象存储信息；
- 不返回 streaming 中的消息；
- 不返回完整 `toolArgs`，避免历史命令中的敏感参数再次暴露；
- 限制单条正文和单次响应规模。

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

## 为什么不用 MCP

房间历史是标准的 list/search/read 数据面，Codex sandbox 已经拥有 shell 和 `roomtalk` helper。CLI 有以下优势：

- 与 `gh`、`rg`、`git` 一样可组合；
- JSON 输出可测试，也可供人类调试；
- 不增加 MCP server 生命周期和 tool catalog 上下文；
- Codex CLI、app-server 和其他 shell-based agent 可共用；
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
