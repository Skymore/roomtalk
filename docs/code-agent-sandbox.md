# Code Agent Sandbox — 需求与实现方案

> 状态：草稿  
> 日期：2026-05-08  
> 作者：Sky

---

## 一、背景与目标

### 问题

RoomTalk 目前是一个纯对话系统——AI 只能输出文本，无法真正执行代码、操作文件、安装依赖、运行脚本。用户如果想让 AI 帮助完成编程任务，必须手动复制代码到本地终端执行，然后把结果粘回来，效率极低。

### 目标

在 RoomTalk 中引入 **代码助手（Code Agent）模式**：AI 拥有一个持久的云端沙盒环境，可以直接执行代码、读写文件、安装依赖，并将过程和结果实时流回聊天界面。用户无需离开聊天窗口即可完成完整的编程任务。

### 对标参考

- **Coco**：终端 AI Agent，通过工具调用（bash、文件操作）完成任务，过程透明可见
- **Claude Managed Agents**：Anthropic 托管沙盒，但仅支持 Claude 模型
- **E2B**：支持任意模型的云端代码执行沙盒，TypeScript SDK，150ms 冷启动

---

## 二、产品需求

### 2.1 Room 模式

创建 Room 时，用户选择模式：

| 模式 | 描述 | 沙盒 |
|------|------|------|
| **普通对话** | 当前行为，纯文字/图片对话 | 无 |
| **代码助手** | AI 可执行代码，有持久云端环境 | E2B 沙盒 |

两种模式在同一界面，通过 badge 区分。创建后不可切换。

### 2.2 代码助手 Room 行为

**用户视角：**
1. 创建 Code Agent Room
2. 发送任务，如"帮我分析这个 CSV 文件的数据分布"
3. 聊天界面实时显示：
   - AI 思考/规划的文字
   - 每一步工具调用（调用了什么命令）
   - 每一步工具结果（命令输出）
   - 最终总结回复
4. 同一个 Room 内，沙盒环境持久保留——上一条消息装的包、写的文件，下一条消息还在

**AI 视角：**
- 拥有工具：bash、文件读写、目录列表
- 可以循环调用工具，直到任务完成
- 工具调用失败时可以自行调整策略重试

### 2.3 工具集（初版）

| 工具 | 功能 | 参数 |
|------|------|------|
| `bash` | 执行 shell 命令 | `command: string` |
| `read_file` | 读取文件内容 | `path: string` |
| `write_file` | 写入文件 | `path: string, content: string` |
| `list_files` | 列出目录 | `path: string` |

后续可扩展：`install_package`、`fetch_url`、图片渲染、数据库连接等。

### 2.4 模型支持

支持所有现有模型切换（Claude、DeepSeek、GPT）。各模型均支持工具调用（Function Calling），后端按 provider 格式化工具定义。

### 2.5 结果展示（初版）

工具调用和结果以独立消息条展示，文本格式：

```
┌──────────────────────────────┐
│ ⚡ bash                       │
│ $ pip install pandas          │
└──────────────────────────────┘

┌──────────────────────────────┐
│ Collecting pandas             │
│ Successfully installed ...    │
└──────────────────────────────┘
```

后续可扩展：matplotlib 图片渲染、文件预览、代码 diff 展示。

### 2.6 沙盒生命周期

| 事件 | 行为 |
|------|------|
| 首次发消息 | 懒创建沙盒，sandboxId 存入 Room |
| 后续消息 | 通过 sandboxId 重连已有沙盒 |
| 沙盒超时（5min 无活动） | 自动重建，提示用户"环境已重置" |
| Room 删除 | 销毁对应沙盒（异步） |

---

## 三、技术方案

### 3.1 技术选型

**沙盒平台：E2B**
- TypeScript/Python 官方 SDK
- 150ms 冷启动（Firecracker 微虚拟机）
- 沙盒 ID 持久化，支持断线重连
- 自定义 Docker 镜像（预装依赖）
- 按使用时间计费（约 $0.05/hr）

**沙盒模板（自定义 Dockerfile）：**
```dockerfile
FROM e2bdev/code-interpreter:latest

# Python 常用库
RUN pip install \
    numpy pandas matplotlib seaborn scikit-learn \
    requests httpx pillow beautifulsoup4 \
    jupyter ipython

# Node.js + npm
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# 全局工具
RUN npm install -g typescript ts-node
```

### 3.2 数据模型变更

**`server/src/types.ts`**

```typescript
// Room 新增字段
export interface Room {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  lastActivityAt?: string;
  creatorId: string;
  type: 'chat' | 'code_agent';   // 新增
  sandboxId?: string;             // 新增，E2B sandbox ID
}

// 新增 messageType
export interface Message {
  // ...现有字段...
  messageType: 'text' | 'image' | 'ai' | 'tool_call' | 'tool_result'; // 扩展
  toolName?: string;      // tool_call 用：工具名
  isError?: boolean;      // tool_result 用：是否出错
}
```

### 3.3 服务端新增文件

#### `server/src/services/sandboxService.ts`

```typescript
import { Sandbox } from '@e2b/code-interpreter';

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE_ID || 'base';
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

export async function createSandbox(): Promise<string> {
  const sandbox = await Sandbox.create(SANDBOX_TEMPLATE, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  return sandbox.sandboxId;
}

export async function getSandbox(sandboxId: string): Promise<Sandbox> {
  return await Sandbox.connect(sandboxId);
}

export async function executeBash(
  sandboxId: string,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sandbox = await getSandbox(sandboxId);
  const result = await sandbox.commands.run(command);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export async function readFile(sandboxId: string, path: string): Promise<string> {
  const sandbox = await getSandbox(sandboxId);
  return await sandbox.files.read(path);
}

export async function writeFile(
  sandboxId: string,
  path: string,
  content: string
): Promise<void> {
  const sandbox = await getSandbox(sandboxId);
  await sandbox.files.write(path, content);
}

export async function listFiles(sandboxId: string, path: string): Promise<string[]> {
  const sandbox = await getSandbox(sandboxId);
  return await sandbox.files.list(path);
}

export async function destroySandbox(sandboxId: string): Promise<void> {
  try {
    const sandbox = await getSandbox(sandboxId);
    await sandbox.kill();
  } catch {
    // 沙盒已超时销毁，忽略
  }
}
```

#### `server/src/services/toolDefinitions.ts`

工具定义按 provider 格式化（Anthropic vs OpenAI/DeepSeek）：

```typescript
// Anthropic 格式
export const anthropicTools = [
  {
    name: 'bash',
    description: 'Execute a shell command in the sandbox environment.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run' } },
      required: ['command'],
    },
  },
  // read_file, write_file, list_files ...
];

// OpenAI/DeepSeek 格式
export const openaiTools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command in the sandbox environment.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  // ...
];
```

### 3.4 AI 工具调用循环

`server/src/socket/aiHandlers.ts` 新增 code_agent 分支：

```
ask_ai (code_agent room)
  ↓
获取/重连沙盒（懒创建）
  ↓
构建消息历史 + 工具定义
  ↓
┌─────────────────────────────┐
│         AI 调用循环          │
│                             │
│  调用 AI API（带工具）        │
│       ↓                     │
│  解析响应                    │
│   ├── 有 tool_call →        │
│   │   emit tool_call_msg    │
│   │   → 在 E2B 执行         │
│   │   emit tool_result_msg  │
│   │   → 追加到历史 → 继续    │
│   └── 无 tool_call →        │
│       emit AI 最终回复       │
│       → 结束循环             │
└─────────────────────────────┘
  ↓
保存完整历史到 Redis
```

**循环保护：**
- 最大工具调用次数：20 次（防止死循环）
- 单次命令超时：30 秒
- 总任务超时：5 分钟

### 3.5 Socket 事件扩展

| 事件 | 方向 | 描述 |
|------|------|------|
| `create_room` | Client → Server | 新增 `type` 字段 |
| `tool_call_message` | Server → Client | 工具调用开始 |
| `tool_result_message` | Server → Client | 工具执行结果 |
| `sandbox_status` | Server → Client | 沙盒状态变化（创建中/已重置） |

### 3.6 客户端变更

**新增/修改组件：**

| 组件 | 变更 |
|------|------|
| `CreateRoomModal` | 新增模式选择（普通对话 / 代码助手）|
| `RoomCard` | Code Agent room 显示 `⚡` badge |
| `RoomHeader` | 显示沙盒状态 |
| `MessageItem` | 支持 `tool_call` / `tool_result` messageType |
| `ToolCallMessage`（新） | 展示工具调用 |
| `ToolResultMessage`（新） | 展示工具输出 |

**`ToolCallMessage` 样式：**
```
┌─────────────────────────────────────────┐
│ ⚡ bash                           [折叠] │
├─────────────────────────────────────────┤
│ $ pip install pandas matplotlib         │
└─────────────────────────────────────────┘
```

**`ToolResultMessage` 样式：**
```
┌─────────────────────────────────────────┐
│ stdout                                  │
├─────────────────────────────────────────┤
│ Collecting pandas...                    │
│ Successfully installed pandas-2.2.0     │
│ exit code: 0                            │
└─────────────────────────────────────────┘
```

---

## 四、环境配置

### 4.1 新增环境变量

```env
# E2B
E2B_API_KEY=e2b_xxx
E2B_TEMPLATE_ID=your_template_id   # 可选，不填用默认模板
```

### 4.2 Fly.io Secrets

```bash
fly secrets set E2B_API_KEY=e2b_xxx -a message-system
```

### 4.3 服务端依赖

```bash
cd server && npm install @e2b/code-interpreter
```

---

## 五、实现顺序

### Phase 1：后端基础（无前端）
1. `server/src/types.ts` — Room.type, Room.sandboxId, 新 messageType
2. `server/src/services/sandboxService.ts` — E2B SDK 封装
3. `server/src/services/toolDefinitions.ts` — 工具定义（Anthropic + OpenAI 格式）
4. `server/src/socket/roomHandlers.ts` — create_room 支持 type，懒创建沙盒
5. `server/src/socket/aiHandlers.ts` — code_agent 工具调用循环

### Phase 2：前端展示
6. `client/components/CreateRoomModal` — 模式选择
7. `client/components/ToolCallMessage` — 工具调用组件
8. `client/components/ToolResultMessage` — 工具结果组件
9. `client/components/MessageItem` — 支持新 messageType
10. `client/components/RoomCard` + `RoomHeader` — badge + 沙盒状态

### Phase 3：完善
11. E2B 自定义模板（Dockerfile + 发布）
12. 沙盒超时重建逻辑
13. Room 删除时销毁沙盒
14. 错误处理和用户提示

---

## 六、后续可扩展

- **文件上传**：用户上传文件到沙盒（CSV、代码等）
- **图片渲染**：matplotlib/seaborn 图直接显示在聊天
- **文件下载**：沙盒生成的文件可下载
- **终端视图**：可选的实时终端 UI（xterm.js）
- **MCP 支持**：沙盒内运行 MCP server，扩展工具集
- **Coco 集成**：在沙盒内直接运行 Coco CLI，复用其工具链

---

## 七、前置工作

开始开发前需要：

1. [ ] 注册 E2B 账号：https://e2b.dev
2. [ ] 获取 `E2B_API_KEY`
3. [ ] （可选）创建自定义沙盒模板，获取 `E2B_TEMPLATE_ID`
4. [ ] 将 API Key 配置到本地 `.env` 和 Fly.io secrets
