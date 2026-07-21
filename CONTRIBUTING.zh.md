# 贡献 RoomTalk

[English](CONTRIBUTING.md)

状态：当前
更新：2026-07-20

## 范围

RoomTalk 包含 React/Vite 客户端、Node/Express/Socket.IO control plane，以及被打包进固定 E2B artifact 的 Python runner/daemon。修改应落在真正拥有该职责的边界，并保留工作区中与任务无关的改动。

## 本地开发

```bash
cp server/.env.example server/.env
cd server && npm install
cd ../client-heroui && npm install
cd .. && ./start.sh
```

客户端监听 `http://localhost:3011`，服务端监听 `http://localhost:3012`。

## 验证

根据 diff 可能产生的真实故障选择检查：

- 纯文档/文案：解析、链接检查和 `git diff --check`。
- 局部服务端或客户端改动：focused test，以及在编译相关时运行受影响 package 的 build/typecheck。
- 持久化、auth、权限、顺序、共享合约或跨 package 改动：扩展到相关 suite 和 production build。
- E2E 或外部服务：只在该边界发生变化时运行对应 Playwright、persistence、public-edge/Compose 或 E2B smoke。

常用命令：

```bash
cd server
npm test
npm run build
npm run smoke:persistence

cd ../client-heroui
npm test
npm run lint
npm run check:i18n
npm run build
npm run test:e2e
npm run test:e2e:postgres
```

## Code Agent Artifact 规则

生产 Code Agent 房间不会直接运行 RoomTalk 应用镜像里的 runner 源码。以下改动需要新的固定 E2B artifact：

- `server/roomtalk_code_agent_runner/`
- runner 工具或 system prompt
- `ops/code-agent-sandbox/Dockerfile`
- `ops/code-agent-sandbox/artifact.lock.json`
- `scripts/code-agent/prepare-sandbox-context.mjs` 复制的依赖或文件
- 固定的 code-agent-engine source ref

此类改动必须同步更新源码与 lock、构建新 template、更新生产 pin，并运行真实 E2B smoke 或等价直接验证。只合并源码不等于完成发布。

## 持久化改动

新 runtime durable operation 必须进入共享 store contract，并优先在 PostgreSQL 实现；只有 import/migration 路径仍需要时才继续对齐旧 Redis 实现。PostgreSQL 拥有 durable state 与 room-event replay，Redis 只保存可重建 realtime/cache 状态。Schema、event emission、retention、迁移、回滚与 cache invalidation 必须一起审查。

## 安全与凭据

- 不得向浏览器代码或 prompt 暴露 provider、database、E2B、Codex、GitHub、model-gateway、room-context 或 publish secret。
- 用户自有 connection 必须加密存储，并且只为获授权 turn 物化。
- 每个 workspace read/mutation、terminal、preview 和 Agent 入口都要重新检查 room access。
- 将 path、archive 内容、object key、upload metadata 和 socket payload 视为不可信输入。

## Commit 与发布

使用简短的现在时 commit subject。`master` 是 release branch。Source push 不会部署生产 Mac；runtime release 从目标生产 checkout 执行 `node scripts/local-production.mjs --profile edge up -d --build`，随后验证 Compose 与公网 edge。旧 Fly workflow 已禁用，只保留为回滚历史。E2B artifact 改动仍需完成独立 release contract。

机器 Agent 指令继续以 `CLAUDE.md`/`AGENTS.md` 为准；本文是人类贡献者合约。
