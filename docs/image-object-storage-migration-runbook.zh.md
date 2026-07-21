# 遗留图像媒体对象存储迁移 Runbook

[English](image-object-storage-migration-runbook.md)

状态：当前 legacy-data migration runbook
更新：2026-07-20

当前入口：

```bash
cd server
npm run migrate:media-to-object-storage
```

不要使用旧文档中的 `dist/...migrateImageMessagesToObjectStorage.js`。

本 runbook 处理 PostgreSQL 中遗留 base64 image message：将图像 body 迁移到私有 S3-compatible object storage，并使用统一 `media_assets` table。当前生产目标是 SeaweedFS，保留的回滚环境是 Tigris，AWS 对应 S3；旧 `image_assets` 已删除。

## 决策

从本地 workstation 或专用 migration container 运行，不在 serving RoomTalk app container 内运行。迁移会读取大 base64 payload 并用 `sharp` 转换，会与 live Node server 竞争 CPU/memory。Script 仍默认拒绝 Fly app VM，作为遗留安全 guard。

只对有意准备的非 serving Fly migration machine 设置 `ALLOW_FLY_APP_VM_IMAGE_MIGRATION=true`，不在 serving app 上设置。

迁移目标：

- 从 `room_messages.content` 删除大 base64 payload；
- 将 image byte 保存为 lossless WebP；
- PostgreSQL 只保存 media metadata；
- 保留视觉质量、message identity/order/time 和 room activity。

## 前置条件

- Execute mode 前存在已验证 PostgreSQL backup。
- Migration host 可访问 production PostgreSQL 和 object storage。
- `DATABASE_URL`、PostgreSQL TLS/CA、media bucket/endpoint/region/credential 已配置；当前本地生产使用 loopback SeaweedFS S3 endpoint 与 path-style addressing。
- Backup file 是绝对 path，确实存在，且是本次运行前生成/验证的。
- 先对特定 room 和全库运行 dry-run。

## Dry Run

```bash
cd server
DATABASE_URL='postgres://...' npm run migrate:media-to-object-storage
```

Dry-run 读取选中 room，解码并在内存中转换 image，报告 candidate/count/byte 和 failure；不上传 object，不更新 PostgreSQL。

可用 `--room-id <id>` 限制 room。确认：

- candidate 是 legacy `data:image/...;base64,...`；
- 已有 `mediaAsset` 的 message 跳过；
- decode/convert failure 明确报告；
- 数量和预期 inventory 一致。

## Execute

```bash
cd server
DATABASE_URL='postgres://...' \
ROOMTALK_DB_BACKUP_FILE='/absolute/path/pre-migration.dump' \
npm run migrate:media-to-object-storage -- --execute
```

执行顺序：

1. 校验非 serving Fly VM 和 backup guard。
2. 读取 candidate message。
3. 解码，转换 lossless WebP，计算 metadata/object key。
4. 上传 object。
5. 原子替换 message payload 并写 `media_assets`。
6. PostgreSQL replacement 失败时 best-effort 删除已上传 object。

Script 幂等跳过已迁移 message。不允许分开执行“上传成功”与“message/asset 替换”而不处理 orphan cleanup。

## 验证

- 重跑 dry-run，candidate 为 0 或只剩已知 failure。
- 检查 `room_messages` 不再包含目标 base64 body。
- `media_assets` 与 message/room/object metadata 对应。
- Object storage 中 object existence/size/MIME 正确。
- 通过真实应用读取图像，确认 signed URL 和视觉质量。
- 删除 message/room 时 backing object cleanup 仍正常。
- 对迁移前后 count/bytes/failure 做记录。

## 回滚

迁移同时改变 PostgreSQL 和 object storage，不支持简单 config rollback。如需完整回滚：

1. 停止写入。
2. 恢复已验证 PostgreSQL backup。
3. 根据 migration log/manifest 删除迁移新增 object。
4. 重新验证 room history 和 media read。

事故调查中不要立即删除 backup、失败 object 或 migration log。
