# RoomTalk

[English Version](./README.md)

一个基于 WebSocket 和 Redis 的轻量级实时消息系统，支持房间管理、消息持久化、本地主题切换等功能。适合作为 IM、团队协作、聊天室功能的基础模块。

---

## 🚀 技术栈

### 客户端（Client）

- React + TypeScript
- Tailwind CSS
- React Router
- Socket.io Client
- i18next 多语言支持

### 服务端（Server）

- Node.js + Express.js
- Socket.io
- Redis（数据持久化）
- UUID 用户标识

---

## 🌟 功能特点

- ✅ 实时消息收发
- ✅ 加入/创建房间（room）
- ✅ 本地保存已加入的房间
- ✅ 消息和房间数据持久化（使用 Redis）
- ✅ 支持暗色/浅色模式
- ✅ 响应式界面（支持手机与桌面）
- ✅ 多语言切换（中英文）

---

## 🧪 快速开始

### 环境准备

- 安装 Node.js
- 安装并启动本地 Redis（支持默认配置：localhost:6379）

### 安装依赖

```bash
# 安装服务端依赖
cd server
npm install

# 安装客户端依赖
cd ../client
npm install
```

### 启动系统

你可以使用脚本一键启动：

```bash
./start.sh
```

或者分开启动：

```bash
# 启动服务端
cd server
npm start

# 启动客户端
cd ../client
npm run dev
```

---

## 🧭 使用说明

1. 打开浏览器访问 [http://localhost:3011](http://localhost:3011)
2. 页面将自动为用户分配唯一 ID（存储在 localStorage）
3. 创建房间、加入房间、开始聊天

---

## 🔌 API 接口说明

### HTTP API

| 路径 | 方法 | 描述 |
|------|------|------|
| `/api/rooms` | `GET` | 获取当前用户创建的房间 |
| `/api/rooms` | `POST` | 创建房间 |
| `/api/messages` | `GET` | 获取用户消息（可选传入 roomId） |
| `/api/messages` | `POST` | 发送消息 |
| `/api/rooms/:id` | `GET` | 获取指定房间（仅限创建者） |

### WebSocket 事件

| 事件名 | 发起方 | 描述 |
|--------|--------|------|
| `register` | 客户端 | 注册用户，加入 clientId 组 |
| `get_rooms` | 客户端 | 获取自己创建的房间 |
| `create_room` | 客户端 | 创建房间 |
| `join_room` | 客户端 | 加入房间 |
| `leave_room` | 客户端 | 离开房间 |
| `send_message` | 客户端 | 发送消息 |
| `get_room_by_id` | 客户端 | 获取房间详情（用于 URL 加入） |
| `message_history` | 服务端 | 返回房间消息历史 |
| `new_room` | 服务端 | 新房间推送（仅发送给用户） |
| `new_message` | 服务端 | 房间新消息广播 |

---

## ⚙️ 配置

### 服务端环境变量 (.env)

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 3012 | 服务端端口 |
| `CLIENT_URL` | http://localhost:3011 | CORS 配置使用 |

### 客户端环境变量

`.env.development`:

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `VITE_SOCKET_URL` | http://localhost:3012 | WebSocket 地址 |

`.env.production`:

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `VITE_SOCKET_URL` | `/` | 相对路径（适用于部署同域） |

---

## 📦 Redis 持久化

本项目使用 Redis 默认的 RDB 快照持久化。你可以通过修改 `redis.conf` 来启用 AOF 或调整快照策略。

---

## 📄 许可证

MIT License

Copyright (c) 2024 RoomTalk

特此免费授予任何获得本软件和相关文档文件（"软件"）副本的人不受限制地处理本软件的权利，包括但不限于使用、复制、修改、合并、发布、分发、再许可和/或销售本软件的副本，以及允许本软件的使用者这样做，但须符合以下条件：

上述版权声明和本许可声明应包含在本软件的所有副本或主要部分中。

本软件按"原样"提供，不提供任何形式的明示或暗示的保证，包括但不限于对适销性、特定用途的适用性和非侵权性的保证。在任何情况下，作者或版权持有人均不对任何索赔、损害或其他责任负责，无论是在合同诉讼、侵权行为还是其他方面，与本软件或本软件的使用或其他交易有关。
