# RoomTalk Client

[English](README.md)

状态：当前 package 指南
更新：2026-07-12

RoomTalk 的 React + TypeScript + Vite 前端。应用负责 room discovery、实时聊天、AI streaming、媒体上传、贴纸、saved rooms、设置，以及移动/桌面布局。

## 目录

- `src/components/`：共享 UI 与聊天组件；
- `src/hooks/`：room、media、sticker、AI 与 gesture 状态 hook；
- `src/pages/`：页面级编排，主要入口为 `MessagePage`；
- `src/utils/`：socket wrapper、API helper、i18n、本地持久化与 domain helper；
- `public/`：PWA manifest、service worker 与静态品牌资源；
- `e2e/`：Playwright 用户流程覆盖。

## 命令

```bash
npm install
npm run dev                 # Vite 开发服务器
npm test                    # Vitest 单元/组件测试
npm run lint                # ESLint
npm run build               # i18n 检查 + TypeScript + Vite 构建
npm run test:e2e            # Playwright E2E
npm run test:e2e:postgres   # PostgreSQL durable 模式 E2E
```

开发环境从 `.env.development` 读取 `VITE_SOCKET_URL`，默认连接 `http://localhost:3012` 的本地 server。生产使用 `.env.production`，Socket.IO/API 走同源路由。
