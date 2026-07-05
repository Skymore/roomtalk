# 身份标识、Code Agent 权限与上下文问题

> 2026-06-29 调查记录

---

## 问题一：userId (clientId) 暴露风险

### 现状

- `clientId` 既是身份凭证（类似密码），又在成员管理 UI 中直接显示
- **在线成员列表**（所有人可见）：UI 只显示 nickname，clientId 做 React key 未暴露
- **角色成员列表**（仅 owner/admin 可见）：`RoomSettingsModal.tsx:433` 直接显示完整 clientId
- 所有管理操作（提升 admin、踢人、转让房间）要求**手动输入目标用户的 clientId**
- `lookup_room_client` 事件允许 owner 输入 clientId 查询用户是否存在

### 风险

知道别人的 clientId 就可以冒充该用户（发消息、加入房间等），而成员管理界面把它暴露了。

### 方案：引入 displayId

- 用户对外展示标识改为 `username#xxxx`（xxxx = clientId 最后 4 位）
- 成员管理列表用 displayId 展示，不暴露完整 clientId
- 管理操作（踢人、提权、转让）改为**点击房间内用户头像弹出操作菜单**，前端通过选择用户来传递 clientId，用户无需手动输入
- 后端操作仍然用完整 clientId，对 API 层不影响
- `lookup_room_client` 接口移除或改为仅返回 displayId + role，不返回完整 clientId

---

## 问题二：Code Agent 房间权限

### 现状

`codeAgentSessionService.ts:326`:
```typescript
if (room.creatorId !== clientId) {
  return { success: false, error: 'You do not have access to this Code Agent room' };
}
```

只有房间创建者能发送 Code Agent AI 消息，硬编码不可配置。

### 方案：可配置的 Code Agent 访问权限

Room 上新增字段 `codeAgentAccess: 'owner' | 'admin' | 'member'`，默认 `'owner'`：

| 值 | 谁可以触发 Code Agent |
|---|---|
| `'owner'` | 仅房主（当前行为） |
| `'admin'` | 房主 + 管理员 |
| `'member'` | 所有成员 |

- 房间设置 UI 中加一个选项让房主配置
- `validateRoom` 方法改为读取此字段，结合 `buildRoomPermissions` 判断权限

---

## 问题三：Code Agent 上下文条数不生效

### 现状

普通 AI 聊天通过 `selectAIHistory` 应用 `maxContextMessages` 限制。

Code Agent 走的是独立路径：
1. `readLatestPromptContext()` 读取房间**全部消息** (`store.readMessagesByRoom`)
2. 找到最后一条用户文本消息作为 `prompt`
3. 前面**所有消息**无截断地作为 `priorMessages`
4. 通过 stdin JSONL 传给 runner 进程
5. Runner 原封不动转发给 LLM

客户端设置的 `maxContextMessages` 对 Code Agent 无作用。对话长了之后 priorMessages 无限增长，导致 token 浪费和可能的上下文溢出。

### 方案：Code Agent 路径复用上下文限制

在 `readLatestPromptContext` 中增加 `maxContextMessages` 参数：

```typescript
private async readLatestPromptContext(
  roomId: string,
  clientId: string,
  maxContextMessages?: number
) {
  const messages = await this.store.readMessagesByRoom(roomId);
  // ... 找到 prompt 后 ...
  const prior = messages.slice(0, index);
  const limited = maxContextMessages
    ? prior.slice(-maxContextMessages)
    : prior;
  return {
    prompt: message.content.trim(),
    priorMessages: buildCode AgentPriorMessages(limited),
  };
}
```

`startTurn` 的 input 增加 `maxContextMessages` 字段，由客户端传入。

---

## 问题四：用户操作入口优化

### 现状

管理操作入口：
- 提升/移除管理员：设置 → Members 标签 → 手动输入 clientId
- 转让房间：设置 → Transfer 标签 → 手动输入 clientId
- 踢人：设置 → Members 标签 → 列表中操作

用户不知道别人的 clientId，操作路径不直观。

### 方案：头像点击弹出操作菜单

在聊天界面中，点击任意用户的头像弹出 popover 菜单：

- **所有人可见**：用户名、displayId (`username#xxxx`)
- **管理员可见**：踢出房间
- **房主可见**：设为管理员 / 移除管理员、踢出房间、转让房间

前端通过点击选择用户，自动传递 clientId 到后端，无需手动输入。

---

## 问题五：Code Agent edit/plan mode 的作用域与持久化

### 现状

`edit/plan` mode 现在是客户端本地状态：

- `CodeAgentRoomView` 用 `localStorage["roomtalk_code_agent_mode_${roomId}"]` 记住当前房间的本地选择
- `MessageInput` 正常发送时把 `codeAgentMode` 带给服务端
- `MessageList` 的 retry / edit-and-ask 也需要单独传 `codeAgentMode`
- 服务端没有把“这一轮实际用的 mode”持久化到 room message 或 turn metadata

这导致两个问题：

1. **不同成员可能看到不同 mode**：同一房间、同一 sandbox，A 浏览器是 `acceptEdits`，B 浏览器可能还是 `plan`。
2. **历史 turn 缺少执行事实**：刷新后只能看到 tool_call/tool_result，不能可靠知道这一轮为什么允许或不允许 Shell/Write。

之前出现过具体故障：retry 路径漏传 `codeAgentMode`，服务端回退到默认 `plan`，模型根据历史继续调用 `Shell` / `BackgroundShell`，结果得到 `unknown tool`。虽然客户端漏传已经修复，但这说明“每条入口都必须传本地 mode”的模型本身脆弱。

### 判断：默认 mode 是房间级设置，实际 mode 是 turn/message 执行事实

`edit/plan` 不应该继续作为本地偏好。它决定工具权限和共享 sandbox 副作用，所以当前选择应该写在 Room 上，所有成员看到一致。

建议 Room 新增字段：

```typescript
codeAgentMode?: 'plan' | 'acceptEdits'
```

语义：

- `room.codeAgentMode` 是**新 turn 默认使用的共享房间设置**
- 只有有权限的成员可以修改它（建议 owner/admin；是否允许 member 后续由权限配置决定）
- 前端不再用 `localStorage["roomtalk_code_agent_mode_${roomId}"]` 作为权威状态
- `room_updated` 广播后所有成员 UI 同步显示当前房间 mode

同时，最终执行时解析出的 `resolvedMode` 仍必须作为**本次 Code Agent turn 的事实**持久化。

建议 message/turn metadata 新增字段：

```typescript
codeAgentMode?: 'plan' | 'acceptEdits'
```

落点优先级：

1. **短期**：加到 `room_messages`，同一 turn 的 AI / tool_call / tool_result 都写入相同 `codeAgentMode`
2. **长期**：如果引入 `code_agent_turns` / `assistant_runs` 统一表，则把 `codeAgentMode` 放到 turn metadata，message 通过 `turnId` 关联

### 服务端行为

`CodeAgentSessionService.startTurn()` 应该先解析并校验 mode：

```typescript
const resolvedMode = resolveTurnMode({
  room,
  clientId,
  availableModes,
});
```

然后：

- runner 使用 `resolvedMode`
- AI placeholder 写入 `codeAgentMode: resolvedMode`
- 后续 AI segment、tool_call、tool_result 继承同一个 `resolvedMode`
- final / usage / cost 对应的 AI message 保留这个字段
- 客户端普通发起 AI turn 时不需要再传 `codeAgentMode`；服务端从 `room.codeAgentMode` 读取
- 兼容期内如果旧客户端仍传 `codeAgentMode`，服务端应忽略它，或者只在旧房间没有 `room.codeAgentMode` 时作为 fallback

注意：持久化的 `codeAgentMode` 是审计事实，不是未来授权凭证。retry 时仍要按当前服务端配置和当前用户权限重新校验。

### retry / edit-and-ask 规则

retry 不应该默认回到当前房间默认 mode，而应该优先复用原 turn 的 mode：

```typescript
const requestedMode =
  retryTargetMessage.codeAgentMode
  ?? room.codeAgentMode
  ?? serverDefaultMode;
```

如果原 turn 是 `acceptEdits`，但当前服务端不再允许 edit mode，应该返回明确错误：

```text
This response was originally run in Edit mode, but Edit mode is no longer available.
```

不要静默降级到 `plan`，否则模型会继续尝试 Shell/Write，造成 `unknown tool` 或行为偏差。

edit-and-ask 可以采用：

- 编辑用户 prompt 后重跑：优先复用被截断掉的下一条 AI response 的 `codeAgentMode`
- 如果找不到对应 AI response：使用 `room.codeAgentMode`
- 同样必须经过服务端权限校验

### UI 展示

为了避免“当前默认 mode”和“历史执行 mode”混淆：

- composer 里的 mode selector 表示**房间当前 mode**，切换时更新 Room 并广播给所有成员
- 房间设置页也展示同一个 mode 控件，并标注 `Room setting`
- 每个 Code Agent AI turn 或工具组显示一个小 badge：`Plan` / `Edit`
- retry 按钮 tooltip 可以提示：`Retry using original mode: Edit`
- 房间设置页需要清晰区分：
  - **Room settings**：共享设置，影响所有成员；包含 `codeAgentMode`
  - **My preferences**：本地偏好，只影响当前用户/设备；包含 model / context length / AI role

### 具体改动清单

1. `Room` 类型增加 `codeAgentMode?: 'plan' | 'acceptEdits'`
2. Redis / Postgres store 持久化该字段，创建 Code Agent room 时默认写 `CODE_AGENT_DEFAULT_MODE` 或 `plan`
3. 新增 socket/API 更新房间 code-agent mode，复用房间权限校验
4. `CodeAgentRoomView` 从 `currentRoom.codeAgentMode` 读取 mode，删除本地 `roomtalk_code_agent_mode_${roomId}` 状态
5. `MessageInput` / `MessageList` 不再把 `codeAgentMode` 当作每次请求的权威参数
6. `CodeAgentSessionService.startTurn` 从 room 读取 resolved mode，并写入 AI / tool messages
7. retry / edit-and-ask 优先复用原 AI turn 的 `codeAgentMode`
8. 历史消息和工具消息 UI 显示实际执行 mode badge

---

## 问题六：AI role / model / context length 的作用域

### 现状

AI 设置现在主要是本地偏好：

- `aiRoles`：本地全局自定义角色列表
- `roomtalk:ai-settings:${roomId}`：本地按房间保存 `selectedRoleId`、`selectedModel`、`maxContextMessages`
- 每次请求时客户端把当前 model / role / context length 带给服务端

### 判断

这些设置不应该和 `edit/plan` 一样处理：

| 设置 | 推荐作用域 | 原因 |
|---|---|---|
| `codeAgentMode` | 房间级当前设置 + turn/message 执行事实 | 决定工具权限和共享 sandbox 副作用，所有成员必须一致 |
| `selectedModel` | 本地偏好 + message 上记录实际模型 | 成本、速度、质量偏个人选择 |
| `maxContextMessages` | 本地偏好 + turn metadata 记录实际值 | 是发起者的上下文预算选择 |
| `selectedRole` / custom roles | 本地偏好 | 普通 AI 的个人 prompt 偏好；Code Agent 不使用普通 role systemPrompt 作为主 system prompt |

所以短期不需要把 role/model/context length 迁成房间设置。

但建议把**实际使用值**写入 turn/message metadata，便于刷新和审计：

- `aiModel` 已经写到 AI message
- `usage` / `cost` 已经写到 AI message
- `maxContextMessages` 建议写入 Code Agent turn metadata 或 AI message metadata
- `roleName` 可继续写到 AI message；Code Agent 场景只作显示，不作为权限或工具语义

---

## Code Agent Runner 内部架构（调查记录）

Runner 是无状态 Python 进程 `python -m roomtalk_code_agent_runner`，每次 turn 重新启动。

### 启动流程

1. `CodeAgentSessionService.startTurn()` → `sandboxService.startRunner()` 启动进程
2. 进程环境变量只有模型凭证 + sandbox 配置（不继承 `process.env`）
3. `JsonlCodeAgentRunnerClient` 通过 stdin 写入 JSONL 请求，然后关闭 stdin

### 输入（stdin JSONL）

```json
{
  "type": "run",
  "prompt": "最新用户消息",
  "priorMessages": [/* Anthropic 格式的历史消息 */],
  "mode": "plan | acceptEdits",
  "provider": "...",
  "modelId": "...",
  "apiModel": "...",
  "workspace": "/path",
  "allowedPaths": ["."]
}
```

### 历史消息转换 (`codeAgentTranscript.ts`)

`buildCode AgentPriorMessages` 将房间消息转为 Anthropic 对话格式：
- 用户文本 → `{ role: 'user', content: string }`
- 完成的 AI 回复 → assistant `text` block
- 配对的 tool_call + tool_result → `tool_use` + `tool_result` block
- streaming/error 状态的 AI 消息被跳过

### 输出（stdout JSONL 事件流）

`text_delta` / `tool_call` / `tool_result` / `final` 事件流回服务端。

### 可用工具

- Plan 模式：Read、Glob、Grep（只读）
- AcceptEdits 模式：+ Write、Edit、Shell、BackgroundShell（可写 / 可启动后台任务）
