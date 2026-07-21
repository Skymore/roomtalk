# 房间事件与自托管切换记录

[English](room-event-sync-portable-deployment-progress.md)

状态：源码、基础设施、数据与不可变事件生产切换全部完成

验证日期：2026-07-21

本文是 RoomTalk 从 Fly/Supabase/Tigris 迁到 MacBook Compose，以及随后替换 room-event 协议的证据账本。它只记录改了什么、生产何时跨过边界、哪些检查通过。运行协议见[房间可靠性架构](room-reliability-architecture.zh.md)，拓扑和未来迁移方式见[房间事件同步与可迁移部署](room-event-sync-portable-deployment.zh.md)。

## 两次切换，不是一次

这条工程主线分两个维护窗口进入生产：

1. 2026-07-20，App、PostgreSQL 数据、Redis 实时状态和 S3-compatible 对象从 Fly/Supabase/Upstash/Tigris 迁到 MacBook 的 Docker Compose。Cloudflare Tunnel 开始承载 `room.ruit.me`、`roomtalk.ruit.me` 和 `roomtalk-objects.ruit.me`。
2. 2026-07-21，生产把保留的 ID-only room-event 历史替换为严格的不可变 after-image；migration `0004` 同时从公共事件流移除成员 ID 和角色。第二条边界再次要求先备份，再停止所有旧 app。

把两个日期分开，可以避免一个常见误读：数据库宿主先迁走，最终事件 payload 协议在第二天才进入生产。

## 变更账本

实施从本地 `master` 的 `d94d2cd0` 开始。

| 阶段 | 结果 | 证据 commit |
| --- | --- | --- |
| 1 | 架构决策、证据账本、初版 Compose runtime | `ec0ac9af` |
| 2 | PostgreSQL event stream、snapshot/replay 客户端、退役 version 字段、integration/E2E | `d2c051ab` |
| 3 | 运维演练与第一轮文档合并 | `63ef29bc` |
| 4 | 本地持久媒体、签名 URL、Compose env 检查、成对恢复演练 | `77a5826c` |
| 5 | Mac 生产 runtime、SeaweedFS 目标、源数据演练、tunnel、备份恢复 | `bdad6d2f`、`94d7feed`、`f878752d` |
| 6 | 最终停写、日志归档、数据恢复、DNS route、公网 smoke、显式凭据 | `a554554c`、`56871060` |
| 7 | 已提交事件 Socket fast path、字节上限 fallback、大差距 snapshot | `1201ba88` |
| 8 | 不可变 after-image、`io.local` fan-out、listener 反熵、一次性旧协议边界 | `c3650de8` |
| 9 | 公共成员隐私、严格 payload validator、提前到达 AI 临时事件 buffer | `609c5e3c` |
| 10 | 保留 optimistic send、不依赖数据库的 payload 单测 | `a8afcf49` |
| 11 | `CURSOR_AHEAD` 旧水位清理、持久 AI 错误的确定性 fast path | `fbfd908b` |
| 12 | Per-room 同步状态机、权限屏障、广播合并、message room 不可变、强制 PostgreSQL CI | `b607ad7a` |

定时 Fly workflow 继续禁用，Fly machine 保持为零。Supabase、Tigris 和 Upstash 是回滚源，不是 live writer。`ai-chat.wenlin.dev` 仍在允许 origin 中，其 DNS 单独管理。

## 生产证据

### 基础设施与数据，2026-07-20

最终 Supabase dump 向 PostgreSQL 17 恢复了 98 个 room、7,939 条 message、179 条 member、404 个 media asset、6,361 条 observability event、28 条 outbox event 和 60 条 room-agent turn。Tigris 复制覆盖私有媒体、发布站点和贴纸，共校验 2,857 个对象、1,302,853,579 bytes。成对 PostgreSQL archive 与 SeaweedFS snapshot 已恢复到隔离目标，抽查对象的 SHA-256 一致。

公网验证覆盖 TLS、HTTP、Socket.IO polling 与 WebSocket upgrade、snapshot/delta、presigned PUT/GET 字节一致和删除清理。真实 PostgreSQL 重启后 marker 与 event head 保留；pool 处理断连，重新建立 `LISTEN room_event_committed`，没有未捕获异常。

### 不可变事件协议，2026-07-21

本次发布先生成：

- `backups/roomtalk-20260721T110310Z.dump`
- `backups/roomtalk-object-storage-20260721T110310Z.tar.gz`

随后停止 `cloudflared` 和旧 app，构建 commit `fbfd908b`，只启动新镜像。启动日志先记录 `0003_room_events_immutable_after_images` 与 `0004_public_member_change_events`，然后 PostgreSQL listener、Redis adapter、outbox worker 与 HTTP server 才进入 ready。

生产只读查询确认 migration `0001` 到 `0004` 全部存在，没有非 V1 保留事件；旧 stream 只留下经过授权的 `room.deleted` cutover tombstone。公网状态端点报告 PostgreSQL、Redis、media storage 与 Socket adapter ready，room 数为 98。

公网 WSS smoke 使用临时房间验证了下面的链路：

```text
register -> create -> join -> send
  -> Socket 收到已提交 messages.upserted payload
  -> repeatable-read snapshot 含同一消息
  -> 从 seq 0 replay 得到同一 after-image
  -> delete -> 获授权读取 room.deleted tombstone
  -> 清理完成
```

Smoke 强制使用 WebSocket transport，达到 `snapshotSeq=3`，重放三条 event，并删除临时房间。

### 并发状态收敛，2026-07-21

Commit `b607ad7a` 没有继续增加彼此独立的恢复 flag，而是直接缩小并发状态空间。浏览器现在由一个 per-room `idle/replay/replace/prepend` controller 统一协调 event replay、replacement recovery 与历史 prepend。未持久化的 AI 终止错误不会再让 placeholder 永远停在 streaming；当前窗口被删除清空时，也不会再被误判为没有更早历史；`CURSOR_AHEAD` 会同时清除过期高水位与旧的大差距 snapshot target。

服务端会把同一房间的 PostgreSQL 通知合并为 seq range。完整 after-image payload 发出前，每个实例都会重新检查 PostgreSQL membership，并先让已失去权限的本机 socket 离开房间。Listener 使用 generation 关闭并忽略旧 client。Migration `0005_message_room_immutability_and_event_clock` 禁止把已有 message ID 移进另一个房间，并把保留事件时间改为真实墙上时间 `clock_timestamp()`。

生产从 `b607ad7a` 重新构建并启动。启动日志确认 `0005`、`LISTEN room_event_committed`、Redis adapter、outbox worker 全部就绪，broadcaster 初始无积压。PostgreSQL、Redis、SeaweedFS 与 app 均健康，Cloudflare Tunnel 正常运行。本机回环、`room.ruit.me` 和 `roomtalk.ruit.me` 都返回 `online`，并报告 PostgreSQL persistence、Redis connected、media configured、Socket adapter ready 与 98 个 room。

## 并发状态收敛版本的验证

| 检查 | 结果 |
| --- | --- |
| 完整 Client suite | 96 个文件、1,012 项通过 |
| 完整 Server suite | 101 个 suite、766 项通过 |
| 真实 PostgreSQL 17 room-event integration | 17 项通过 |
| 状态机与 room-event 竞态回归 | 通过 |
| Server TypeScript build | 通过 |
| Client production build 与 i18n check | 通过 |
| Production Docker image build | 通过 |
| Compose health | 五个服务 healthy/running |
| 本机回环 `/api/status` | Online |
| `room.ruit.me` 与 `roomtalk.ruit.me` `/api/status` | Online |
| 强制 PostgreSQL 17 service 的 GitHub CI | 已加入；room-event integration 不能再静默 skip |

回归测试覆盖 recovery 与 prepend pagination 竞争、当前窗口被删除清空但仍有旧历史、只有 deletion event 才关闭消息弹窗、未持久化 AI 错误早于或晚于 placeholder、1,000 条通知突发合并、旧 PostgreSQL listener generation、跨房间 message 拒绝，以及真实墙上 event 时间。真实 PostgreSQL suite 使用 PostgreSQL 17 而不是 mock；新的 GitHub workflow 会在每次 `master` push 和 pull request 中提供同样的数据库 service。

更早的完整 Server、Client、PostgreSQL integration、PostgreSQL Playwright、persistence、Compose restart 与成对恢复结果仍保留在产生它们的 Git commit 中。这里不复制每个测试用例，因为当前架构文档已经说明协议层覆盖。

## 回滚与持续运维

跨过任一生产边界后，回滚都是数据操作。Mac 已接受写入时，不能只重新启用 Fly 或切 DNS。应先停止或 gate 当前 writer，协调 PostgreSQL 与对象增量，恢复匹配的数据库和对象备份，验证目标，然后才切流量。

定期生成成对维护备份，把加密副本复制到 Mac 外，并实际演练恢复。Mac 需要持续供电，Docker Desktop 需要运行。未来 AWS 可复用现有镜像、PostgreSQL schema、Redis 可重建边界、S3 object key 和 E2B execution plane；但若 event payload 不兼容，滚动迁移仍需两阶段协议。
