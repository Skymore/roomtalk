# CI/CD 构建与 Fly 部署提速记录

本文记录 2026-07-12 对 RoomTalk GitHub Actions、Docker 构建和 Fly.io 部署链路所做的性能优化。它同时是后续 CI/CD 改动的性能基线和排障参考。

## 背景

优化前，`.github/workflows/fly-deploy.yml` 会先在 GitHub Actions 中完成以下工作：

1. 安装 server 依赖并执行 TypeScript 构建。
2. 安装 client 依赖并执行 TypeScript、i18n 和 Vite 构建。
3. 调用 `flyctl deploy --remote-only`。

随后，Fly remote builder 又会根据 `Dockerfile` 重新安装前后端依赖，并再次执行 server 和 client 构建。也就是说，同一次发布会在 Actions 和 Docker 中重复完成应用构建，不但浪费时间，也扩大了远端镜像和缓存层。

## 优化目标

- 应用代码只构建一次，Docker 直接打包 Actions 已验证的产物。
- 让互不依赖的 server/client 安装和构建并行执行。
- 提高 npm 与 Docker 层在连续发布中的缓存命中率。
- 保留标准 `docker build` 的源码构建能力，避免 Dockerfile 只能在 CI 中使用。
- 用真实的完整 Actions 和生产部署结果衡量收益，而不是只比较本地 `tsc` 时间。

## 实现方案

### 1. 并行安装和构建

工作流同时启动 server 和 client 的 `npm ci`，等待两个进程都结束后再继续；构建阶段同样并行执行两个 package 的 `npm run build`。

并行脚本会分别保存进程 PID，并在任意一方失败时让步骤失败，避免后台任务掩盖错误。

### 2. 启用 npm 下载缓存

`actions/setup-node` 使用 npm cache，并同时跟踪：

- `server/package-lock.json`
- `client-heroui/package-lock.json`

缓存用于复用 npm 下载内容；`npm ci` 仍会完整、确定性地创建当前工作区的 `node_modules`。

### 3. Docker 复用 Actions 产物

Actions 构建完成后，以下产物会进入 Docker build context：

- `client-heroui/dist`
- `server/dist`

部署命令传入：

```bash
flyctl deploy --remote-only --build-arg USE_PREBUILT_APP=true -a message-system
```

Dockerfile 在该模式下验证 `client-heroui/dist/index.html` 和 `server/dist/src/server.js` 存在，然后直接打包，不再执行 client/server 构建。

Docker 镜像仍会安装 server 运行时所需的依赖。client 依赖只用于编译，因此预构建模式不再把 client `node_modules` 安装到镜像中。

### 4. 保留独立源码构建

`USE_PREBUILT_APP` 默认是 `false`。因此开发者或其他构建系统执行普通命令时，Dockerfile 仍会安装 client 依赖并从源码构建两个应用：

```bash
docker build .
```

在源码构建前会清理已有 `dist`，防止本地旧产物被误认为本次构建结果。

### 5. 缩小镜像与稳定 Docker 缓存层

- package manifests 在源码之前复制，使 lockfile 未变化时可复用依赖层。
- 全局 Codex CLI、client 依赖和 server 依赖安装完成后清理 npm cache。
- 预构建路径不安装 client `node_modules`。
- `.dockerignore` 只放行生产 `dist`，仍排除 `node_modules`、coverage 和其他构建目录。

## 实测结果

以下三次运行均为完整 `CI/CD` workflow，包括依赖安装、翻译检查、server/client 构建、Fly 镜像构建、上传、滚动发布和机器健康检查。

| 指标 | 优化前 | 优化后首次运行 | 优化后缓存命中 |
| --- | ---: | ---: | ---: |
| 完整 Actions | 3 分 37 秒 | 2 分 00 秒 | **1 分 13 秒** |
| Build and Deploy job | 3 分 26 秒 | 1 分 48 秒 | **1 分 03 秒** |
| Fly 部署步骤 | 2 分 29 秒 | 1 分 02 秒 | **24 秒** |

最终缓存命中运行相对优化前：

- 完整 Actions 缩短 2 分 24 秒，**提速 66.4%**。
- Build and Deploy job 缩短 2 分 23 秒，**提速 69.4%**。
- Fly 部署步骤缩短 2 分 05 秒，**提速 83.9%**。

对应运行：

- [优化前：run 29190735724](https://github.com/Skymore/roomtalk/actions/runs/29190735724)
- [优化后首次运行：run 29191206616](https://github.com/Skymore/roomtalk/actions/runs/29191206616)
- [优化后缓存命中：run 29191351083](https://github.com/Skymore/roomtalk/actions/runs/29191351083)

缓存命中运行的 Fly 日志显示系统依赖、Codex CLI、client manifest 和 server `npm ci` 等层均为 `CACHED`，镜像 layers 导出只用了 0.9 秒。Docker 阶段没有再次执行 `tsc` 或 Vite build。

本地镜像验证中，未优化源码镜像约为 1.27 GB，预构建优化镜像约为 630 MB，减少约 50%。Fly 日志显示上传后的压缩镜像为 207 MB。

## 缓存如何失效

缓存是否命中主要由 Docker 层输入决定，并不只是由缓存存放时间决定。

| 变化 | 预期影响 |
| --- | --- |
| 普通 server/client 源码或 `dist` 变化 | 复用依赖层，重新复制产物并导出镜像 |
| `server/package-lock.json` 变化 | 重新执行 server `npm ci` |
| `client-heroui/package-lock.json` 变化 | Actions 的 npm cache key 改变；预构建 Docker 路径仍不会安装 client 依赖 |
| `CODEX_CLI_NPM_VERSION` 或基础镜像变化 | 重新安装系统依赖和 Codex CLI，并可能使后续层失效 |
| Dockerfile 前部指令变化 | 从变化位置开始重建后续层 |
| `USE_PREBUILT_APP` 改为 `false` | Docker 内重新安装 client 依赖并从源码构建 |

Fly 当前 remote build 使用持久化 Docker layer cache，但 Fly 没有为托管项目公开承诺固定的缓存有效期。底层 Depot 容器构建支持 7、14 或 30 天的 retention policy，也会在达到容量策略时清理较旧的层；Fly 具体采用的策略不应被当作稳定契约。因此 CI 必须在冷缓存下也能正确完成，热缓存只用于提速。

相关官方资料：

- [Fly.io：在 CI 中使用 remote build](https://fly.io/docs/flyctl/integrating/)
- [Depot：容器构建缓存与 retention policy](https://depot.dev/docs/container-builds/overview)

## 验证清单

修改 CI、Dockerfile、依赖版本或构建输出路径后，至少检查：

1. server 与 client 的生产构建均成功。
2. `npm run translate:i18n:dry` 成功。
3. `docker build .` 的源码构建路径成功。
4. 预构建模式能构建镜像，且镜像内存在两个 `dist` 入口。
5. 预构建镜像不包含 client `node_modules`，server 运行时依赖可加载。
6. 完整 GitHub Actions 成功，Fly 日志中没有第二次执行 `tsc` 或 Vite build。
7. 发布后 `https://room.ruit.me/api/status` 返回 `online`，PostgreSQL、Redis 和 Socket Adapter 正常。

## 性能回退排查

如果完整 Actions 明显超过约 1～2 分钟，按以下顺序查看：

1. 对比 `Install application dependencies`、`Build applications` 和 `Deploy to Fly` 三个步骤的耗时。
2. 检查 Fly 日志中的依赖层是否出现 `CACHED`。
3. 检查 workflow 是否仍传入 `USE_PREBUILT_APP=true`。
4. 检查 `.dockerignore` 是否意外重新排除了两个 `dist` 目录。
5. 确认 Docker 阶段没有出现实际执行的 `npm run build`、`tsc` 或 `vite build`。
6. 如果只是首次运行、基础镜像升级或 lockfile 变化，允许一次冷缓存重建，再用下一轮判断稳定性能。

## 相关文件

- `.github/workflows/fly-deploy.yml`
- `Dockerfile`
- `.dockerignore`
- `CLAUDE.md` 的 Deployment 与 Task Completion 章节

本次优化的实现提交为 `8335735b`（`ci: package prebuilt application artifacts`）。
