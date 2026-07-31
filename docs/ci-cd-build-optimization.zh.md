# CI/CD 构建与 Fly 部署提速记录

[English](ci-cd-build-optimization.md)

状态：重要构建/发布复盘
Reviewed: 2026-07-12

本文记录 2026-07-12 对 RoomTalk GitHub Actions、Docker 构建和 Fly.io 部署链路所做的两阶段性能优化。它同时是后续 CI/CD 改动的性能基线和排障参考。

## 原始问题

最初，`.github/workflows/fly-deploy.yml` 会先在 GitHub Actions 中安装 server/client 依赖并构建，再由 Fly remote builder 根据单阶段 `Dockerfile` 重复安装依赖和构建。同一次发布因此做了两遍 TypeScript 和 Vite 构建。

第一阶段先让 Actions 并行构建，Docker 只打包 Actions 生成的 `dist`。完整 Actions 从 3 分 37 秒降到缓存命中时的 1 分 13 秒。

第二阶段进一步确定 Docker 是唯一构建来源：Actions 只负责变更 gate、checkout、Fly secret 检查和触发部署，client/server 构建由 Fly 的独立 Docker stages 完成。这避免 GitHub-hosted runner 每次重新创建约 770 MB 的 `node_modules`，并让 package 级 Docker 缓存直接决定需要重建哪一侧。

## 当前架构

```text
GitHub Actions
  ├─ Check for changes
  ├─ Checkout
  ├─ Verify Fly runtime secrets
  └─ flyctl deploy --remote-only
       └─ Docker / Fly remote builder
            ├─ client-build
            │    ├─ npm ci
            │    ├─ translate:i18n:dry
            │    └─ TypeScript + Vite build
            ├─ server-build
            │    ├─ npm ci
            │    ├─ TypeScript build
            │    └─ package sticker catalog
            ├─ server-runtime-deps
            │    └─ npm prune --omit=dev
            └─ runtime
                 ├─ server production dependencies
                 ├─ server dist
                 ├─ client dist
                 └─ host-side Codex CLI
```

Docker 构建失败时，`fly deploy` 会在更新生产 Machine 之前失败，因此 TypeScript、i18n 和 Vite 构建仍然是发布门禁。

## 关键实现

### 独立 client/server stages

client 和 server 分别复制自己的 lockfile、配置和源码。这样：

- 只修改 server 时，client stage 可以完整命中缓存。
- 只修改 client 时，server build 和生产依赖可以完整命中缓存。
- lockfile 未变化时，昂贵的 `npm ci` 层可以继续复用。
- 两个互不依赖的 builder stage 可以由 BuildKit 并行调度。

### 精简 runtime

最终镜像不再执行 `COPY . .`，只包含：

- `client-heroui/dist`
- `server/dist`
- server 生产依赖
- Node.js、`util-linux` 和 host-side Codex CLI

`@anthropic-ai/sdk` 被生产代码直接引用，因此从 `devDependencies` 移入 `dependencies`。server 完成编译后执行 `npm prune --omit=dev`，最终镜像不包含 TypeScript、ts-node 和测试工具。

Sticker catalog 是运行时文件，但 TypeScript 不会自动复制 JSON。server builder 会把它放入 `dist/src/stickers/data/catalog.json`，让 compiled output 自包含。

### 最小 Docker context

`.dockerignore` 排除本地 `dist`、`node_modules`、Git 数据、文档、测试输出、E2B artifact 源码和其他不参与生产应用构建的目录。本地测试中，Docker context 从约 21 MB 降到约 230 KB；完全缓存时只传输了约 38 KB 的变更 context。

### 文档变更 gate

定时 workflow 会比较最新成功运行的 SHA 与当前 `master`。只有以下生产输入发生变化时才部署：

- `Dockerfile`、`.dockerignore`、`fly.toml`
- `.github/workflows/fly-deploy.yml`
- `client-heroui/**`
- `server/**`

纯文档或其他非 runtime 改动会在 gate 后结束。手动 `workflow_dispatch` 始终强制部署；无法可靠比较或文件数达到 API 上限时也会保守地执行完整部署。

## 第一阶段实测基线

| 指标 | 原始链路 | Actions 预构建首次运行 | Actions 预构建缓存命中 |
| --- | ---: | ---: | ---: |
| 完整 Actions | 3 分 37 秒 | 2 分 00 秒 | **1 分 13 秒** |
| Build and Deploy job | 3 分 26 秒 | 1 分 48 秒 | **1 分 03 秒** |
| Fly 部署步骤 | 2 分 29 秒 | 1 分 02 秒 | **24 秒** |

第一阶段缓存命中相对原始链路：

- 完整 Actions 提速 66.4%。
- Build and Deploy job 提速 69.4%。
- Fly 部署步骤提速 83.9%。

对应运行：

- [原始链路：run 29190735724](https://github.com/Skymore/roomtalk/actions/runs/29190735724)
- [Actions 预构建首次运行：run 29191206616](https://github.com/Skymore/roomtalk/actions/runs/29191206616)
- [Actions 预构建缓存命中：run 29191351083](https://github.com/Skymore/roomtalk/actions/runs/29191351083)

## 第二阶段实测结果

| 指标 | Docker 冷缓存首次运行 | Docker 热缓存运行 | 相对第一阶段热缓存 |
| --- | ---: | ---: | ---: |
| 完整 Actions | 2 分 21 秒 | **44 秒** | **快 39.7%** |
| Build and Deploy job | 2 分 10 秒 | **33 秒** | **快 47.6%** |
| Fly 部署步骤 | 2 分 03 秒 | **24 秒** | 持平 |

热缓存运行相对最初 3 分 37 秒的完整链路缩短 2 分 53 秒，**提速 79.7%**。所有 client/server 安装、构建和 prune 层均为 `CACHED`，镜像 layers 导出为 0 秒；剩余的 24 秒主要是 Fly 获取 builder、更新 Machine、smoke checks 和 machine checks。

对应运行：

- [Docker 冷缓存首次运行：run 29192119017](https://github.com/Skymore/roomtalk/actions/runs/29192119017)
- [Docker 热缓存运行：run 29192200757](https://github.com/Skymore/roomtalk/actions/runs/29192200757)

Fly 压缩镜像从第一阶段的 207 MB 降至 196 MB，减少约 5.3%。

## 第二阶段本地验证

多阶段 Docker 的首次本地冷构建为 71.57 秒，其中 client/server 依赖安装、构建和 Codex CLI 安装会并行推进。完全缓存构建为约 3～7 秒。

运行时验证确认：

- client/server 构建入口和 sticker catalog 均存在。
- client `node_modules`、server 源码和 TypeScript 编译器不在最终镜像中。
- `@anthropic-ai/sdk`、Sharp 和 compiled sticker module 可以加载。
- 容器连接 Redis 后 `/api/status` 返回 `online`，Socket Adapter ready。

本地验证用于覆盖冷构建和 runtime 内容，最终性能结论以上述完整 GitHub Actions/Fly 运行数据为准。

## 缓存失效矩阵

| 变化 | 预期影响 |
| --- | --- |
| 普通 client 源码、public 或构建配置变化 | 重跑 client build；server 和 runtime 基础层继续缓存 |
| 普通 server 源码变化 | 重跑 server build 和 prune；client build 继续缓存 |
| `client-heroui/package-lock.json` 变化 | 重跑 client `npm ci` 和 client build |
| `server/package-lock.json` 变化 | 重跑 server `npm ci`、server build 和 prune |
| `CODEX_CLI_NPM_VERSION` 或 runtime 基础镜像变化 | 重建 Codex CLI/runtime 基础层 |
| Dockerfile 前部指令变化 | 从变化位置开始重建相关 stage |
| 只有文档或非 runtime 文件变化 | 定时 workflow 跳过 Build and Deploy |

Fly 当前 remote build 使用持久化 Docker layer cache，但 Fly 没有为托管项目公开承诺固定的缓存有效期。底层 Depot 容器构建支持 7、14 或 30 天的 retention policy，也会按容量策略清理较旧层；Fly 具体策略不应被视为稳定契约。因此冷缓存必须始终能够正确构建，热缓存只负责提速。

相关官方资料：

- [Fly.io：在 CI 中使用 remote build](https://fly.io/docs/flyctl/integrating/)
- [Fly.io：当前资源定价](https://fly.io/docs/about/pricing/)
- [Depot：容器构建缓存与 retention policy](https://depot.dev/docs/container-builds/overview)

## 验证清单

修改 CI、Dockerfile、依赖版本或构建输出路径后，至少检查：

1. workflow YAML 可以解析，shell gate 能正确区分 runtime 和 docs-only 变更。
2. 无缓存 `docker build .` 能完成 translations、client 和 server 生产构建。
3. 第二次 `docker build .` 的依赖和未变化 package stages 显示 `CACHED`。
4. runtime 镜像存在两个 `dist` 入口和 sticker catalog。
5. runtime 不包含 client `node_modules`、server 源码或 TypeScript 编译器。
6. Anthropic、Sharp 等生产依赖可以从 runtime 加载。
7. 完整 GitHub Actions 成功，Fly 日志只在 Docker builder stage 执行一次 TypeScript/Vite 构建。
8. 发布后 `https://room.ruit.me/api/status` 返回 `online`，PostgreSQL、Redis 和 Socket Adapter 正常。

## 性能回退排查

1. 区分冷缓存、package 源码变化和真正的缓存异常。
2. 查看 client/server 的 `npm ci` 层是否 `CACHED`。
3. 确认普通 server 改动没有让 client stage 失效，反之亦然。
4. 检查 Docker context 是否异常增大，尤其是 `node_modules`、`dist`、测试输出和 Git 数据。
5. 确认 Actions 中没有重新出现 `setup-node`、`npm ci` 或应用构建步骤。
6. 检查 Fly 的镜像构建、镜像导出、smoke checks 和 machine checks 各自耗时，避免把正常滚动发布时间误判为构建退化。

## 相关文件与提交

- `.github/workflows/fly-deploy.yml`
- `Dockerfile`
- `.dockerignore`
- `server/package.json`、`server/package-lock.json`
- `CLAUDE.md` 的 Deployment 与 Task Completion 章节

第一阶段实现提交：`8335735b`（`ci: package prebuilt application artifacts`）。

第二阶段实现提交：`1618676d`（`ci: build applications in Docker`）。
