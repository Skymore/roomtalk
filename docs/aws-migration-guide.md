# AWS Migration Guide: Fly.io → AWS ECS

本文档覆盖 RoomTalk 全套技术栈从 Fly.io 生态迁移到 AWS 的完整方案。

## 当前架构

```text
Client (React/Vite)
  │
  ▼
Fly.io Proxy (TLS termination, sticky routing)
  │
  ▼
Fly.io VM ── Node.js + Express + Socket.IO ── port 3012
  │         (Dockerfile, shared-cpu-1x, 512MB)
  │
  ├──▶ Supabase PostgreSQL (durable store)
  ├──▶ Upstash Redis (realtime state + Socket.IO adapter + message cache)
  ├──▶ Tigris S3 (private media object storage)
  ├──▶ DeepSeek / Anthropic / OpenAI / OpenRouter (AI providers)
  ├──▶ AssemblyAI (voice transcription, optional)
  └──▶ Google OAuth (sign-in, optional)

CI: GitHub Actions → flyctl deploy --remote-only
```

## 目标架构

```text
Client (React/Vite) ── CloudFront CDN (static assets)
  │
  ▼
Application Load Balancer (TLS, sticky sessions)
  │
  ▼
ECS Fargate Service (1+ tasks, 0.25 vCPU / 512MB)
  │         same Docker image, same server code
  │
  ├──▶ RDS PostgreSQL (db.t4g.micro, Multi-AZ optional)
  ├──▶ ElastiCache Redis (cache.t4g.micro, single node or cluster)
  ├──▶ S3 Bucket (private media, same SDK, swap endpoint)
  ├──▶ AI providers (unchanged, external API calls)
  ├──▶ AssemblyAI (unchanged)
  └──▶ Google OAuth (unchanged)

CI: GitHub Actions → ECR push → ECS service update
All resources inside one VPC, private subnets for DB/Redis.
Monitoring: CloudWatch Metrics + Logs + Alarms → SNS → Slack/Email
```

## 组件迁移详细

### 1. 网络基础 — VPC

在迁移任何组件之前，先创建 VPC：

```text
VPC: 10.0.0.0/16
├── Public Subnets (2 AZ):   10.0.1.0/24, 10.0.2.0/24   ← ALB
├── Private Subnets (2 AZ):  10.0.3.0/24, 10.0.4.0/24   ← ECS tasks
└── Database Subnets (2 AZ): 10.0.5.0/24, 10.0.6.0/24   ← RDS, ElastiCache
```

安全组规则：

| Security Group | Inbound | From |
|---|---|---|
| ALB-SG | 443 (HTTPS) | 0.0.0.0/0 |
| ECS-SG | 3012 | ALB-SG |
| RDS-SG | 5432 | ECS-SG |
| Redis-SG | 6379 | ECS-SG |

### 2. 计算 — Fly.io VM → ECS Fargate

#### Dockerfile

现有 `Dockerfile` 不需要修改。它已经是标准的 Node 22 Alpine 多阶段构建。

#### ECS Task Definition

```json
{
  "family": "roomtalk",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [{
    "name": "roomtalk",
    "image": "<account-id>.dkr.ecr.<region>.amazonaws.com/roomtalk:latest",
    "portMappings": [{ "containerPort": 3012, "protocol": "tcp" }],
    "environment": [
      { "name": "PORT", "value": "3012" },
      { "name": "NODE_ENV", "value": "production" },
      { "name": "PERSISTENCE_STORE", "value": "postgres" }
    ],
    "secrets": [
      { "name": "DATABASE_URL", "valueFrom": "arn:aws:ssm:<region>:<account>:parameter/roomtalk/DATABASE_URL" },
      { "name": "REDIS_URL", "valueFrom": "arn:aws:ssm:<region>:<account>:parameter/roomtalk/REDIS_URL" },
      { "name": "DEEPSEEK_API_KEY", "valueFrom": "arn:aws:ssm:<region>:<account>:parameter/roomtalk/DEEPSEEK_API_KEY" },
      { "name": "OPENROUTER_API_KEY", "valueFrom": "arn:aws:ssm:<region>:<account>:parameter/roomtalk/OPENROUTER_API_KEY" },
      { "name": "AWS_ACCESS_KEY_ID", "valueFrom": "arn:aws:ssm:<region>:<account>:parameter/roomtalk/S3_ACCESS_KEY" },
      { "name": "AWS_SECRET_ACCESS_KEY", "valueFrom": "arn:aws:ssm:<region>:<account>:parameter/roomtalk/S3_SECRET_KEY" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/roomtalk",
        "awslogs-region": "<region>",
        "awslogs-stream-prefix": "ecs"
      }
    },
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:3012/api/status || exit 1"],
      "interval": 30,
      "timeout": 5,
      "retries": 3
    }
  }]
}
```

#### ALB 配置

```text
ALB (internet-facing, public subnets)
├── Listener: 443 HTTPS → Target Group
├── Target Group:
│   ├── Target type: IP (Fargate)
│   ├── Port: 3012
│   ├── Health check: GET /api/status
│   ├── Stickiness: enabled, duration 1 day
│   └── Deregistration delay: 30s
└── Listener: 80 HTTP → redirect 443
```

**Stickiness 必须开启**：Socket.IO 握手阶段的 HTTP polling 请求必须落到同一台实例，否则握手失败。当前 Fly.io proxy 天然做了这件事，ALB 需要显式配置。

#### ECS Service

```text
Service:
  Launch type: FARGATE
  Desired count: 1 (可按需扩到 2+)
  Subnets: private subnets
  Security group: ECS-SG
  Load balancer: 上面的 ALB target group
  Auto Scaling: target tracking on CPU 70%
```

#### 代码变更

**零改动**。Dockerfile、server.ts、端口、环境变量读取方式全部兼容。

### 3. 数据库 — Supabase → RDS PostgreSQL

#### 创建 RDS 实例

```text
Engine: PostgreSQL 16
Instance: db.t4g.micro (2 vCPU, 1GB RAM, 免费额度 12 个月)
Storage: 20GB gp3, auto-scaling to 100GB
Multi-AZ: 初期关闭，生产稳定后开启
Subnet group: database subnets
Security group: RDS-SG
Encryption: enabled
Automated backups: 7 days retention
```

#### 数据迁移

```bash
# 1. 从 Supabase 导出
pg_dump "$SUPABASE_DATABASE_URL" \
  --no-owner --no-privileges --clean --if-exists \
  -F custom -f roomtalk_backup.dump

# 2. 导入到 RDS
pg_restore \
  -h <rds-endpoint>.rds.amazonaws.com \
  -U roomtalk -d roomtalk \
  --no-owner --no-privileges --clean --if-exists \
  roomtalk_backup.dump

# 3. 验证
psql -h <rds-endpoint> -U roomtalk -d roomtalk \
  -c "SELECT COUNT(*) FROM rooms; SELECT COUNT(*) FROM room_messages; SELECT COUNT(*) FROM media_assets;"
```

#### 连接配置

```text
DATABASE_URL=postgres://roomtalk:<password>@<rds-endpoint>:5432/roomtalk
POSTGRES_SSL=true
POSTGRES_SSL_REJECT_UNAUTHORIZED=true
```

RDS 默认使用 AWS 根 CA，Node.js 内置信任，不需要额外的 `POSTGRES_SSL_CA_BASE64`。

### 4. Redis — Upstash → ElastiCache

#### 创建 ElastiCache

```text
Engine: Redis 7.x
Node type: cache.t4g.micro (0.5GB)
Cluster mode: disabled (单节点，省钱)
Subnet group: database subnets
Security group: Redis-SG
Encryption in-transit: enabled
Auth: Redis AUTH token
```

#### 连接配置

```text
REDIS_URL=rediss://:<auth-token>@<elasticache-endpoint>:6379
```

#### 数据迁移

**不需要迁移数据。** Redis 里存的是实时状态（socket sessions、在线成员、消息缓存），服务重启后自动重建。

### 5. 媒体存储 — Tigris → S3

#### 创建 S3 Bucket

```text
Bucket name: roomtalk-media-<account-id>
Region: 和 ECS 同区域
Block all public access: enabled
Encryption: SSE-S3
Versioning: optional
Lifecycle: 可配置旧媒体归档到 Glacier
```

#### 存量文件迁移

```bash
# 从 Tigris 同步到 S3（用 rclone 或 aws s3 sync）
rclone sync tigris:message-system-media s3:roomtalk-media-<account-id> \
  --transfers 16 --checkers 32 --progress
```

#### 连接配置

```text
MEDIA_BUCKET_NAME=roomtalk-media-<account-id>
MEDIA_STORAGE_REGION=us-east-1
# 不需要 MEDIA_STORAGE_ENDPOINT（AWS S3 是默认 endpoint）
# 不需要 MEDIA_STORAGE_FORCE_PATH_STYLE
AWS_ACCESS_KEY_ID=<iam-user-or-role>
AWS_SECRET_ACCESS_KEY=<secret>
```

#### 代码变更

`mediaObjectStorage.ts` 已经用的 `@aws-sdk/client-s3`，完全兼容。唯一区别是 AWS S3 不需要自定义 endpoint，去掉 `MEDIA_STORAGE_ENDPOINT` 即可（代码已处理 undefined endpoint 的情况）。

更好的做法：用 **ECS Task Role** 而不是 Access Key，给 task 分配 IAM role 直接访问 S3，不需要在环境变量传 credentials。

### 6. 静态前端 — CloudFront + S3 (可选优化)

当前架构是 server 同时 serve 前端静态文件。迁到 AWS 后可以拆分：

```text
方案 A（保持现状）: ALB → ECS → Express static serving
方案 B（推荐优化）: CloudFront → S3 (静态) + ALB → ECS (API + WebSocket)
```

方案 B 的好处：
- CDN 全球加速静态资源
- 减轻 ECS 负载
- 前后端独立部署

```text
CloudFront Distribution:
├── Origin 1: S3 bucket (client-heroui/dist/) → 默认行为 /*
├── Origin 2: ALB → /api/*, /socket.io/*
└── Behavior: /api/* 和 /socket.io/* 转发到 ALB origin
```

### 7. CI/CD — GitHub Actions → ECR + ECS

替换 `fly-deploy.yml`：

```yaml
name: Deploy to AWS

on:
  push:
    branches: [master]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<account>:role/github-actions-deploy
          aws-region: us-east-1

      - name: Login to Amazon ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push Docker image
        run: |
          docker build -t ${{ steps.ecr.outputs.registry }}/roomtalk:${{ github.sha }} .
          docker build -t ${{ steps.ecr.outputs.registry }}/roomtalk:latest .
          docker push ${{ steps.ecr.outputs.registry }}/roomtalk:${{ github.sha }}
          docker push ${{ steps.ecr.outputs.registry }}/roomtalk:latest

      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster roomtalk \
            --service roomtalk \
            --force-new-deployment
```

### 8. 监控与告警 — CloudWatch

#### 自动采集的指标

ECS、RDS、ElastiCache、ALB 的基础指标（CPU、内存、连接数、延迟）自动进入 CloudWatch，零配置。

#### 应用日志

ECS Task Definition 里已配置 `awslogs` driver，容器 stdout/stderr 自动进入 CloudWatch Logs `/ecs/roomtalk`。当前服务端的 winston 日志会直接出现在这里。

#### 关键告警

```text
Alarm: ECS CPU > 80% for 5 min         → SNS → Slack
Alarm: ECS Memory > 85% for 5 min      → SNS → Slack
Alarm: ALB 5xx count > 10 in 5 min     → SNS → Slack
Alarm: ALB target response time > 2s   → SNS → Slack
Alarm: RDS CPU > 80% for 10 min        → SNS → Slack
Alarm: RDS free storage < 2GB          → SNS → Slack
Alarm: RDS connections > 80% max       → SNS → Slack
Alarm: ElastiCache memory > 80%        → SNS → Slack
Alarm: ECS running task count = 0      → SNS → PagerDuty (critical)
```

#### Dashboard

创建一个 CloudWatch Dashboard 包含：
- ECS: CPU、内存、running tasks、desired tasks
- ALB: request count、5xx rate、response time p50/p99
- RDS: CPU、connections、read/write IOPS、free storage
- ElastiCache: CPU、memory、connections、cache hit rate

### 9. Secrets 管理

| 当前 (Fly secrets) | AWS 推荐 |
|---|---|
| `fly secrets set KEY=value` | AWS Systems Manager Parameter Store (SecureString) |

```bash
# 批量写入 secrets
aws ssm put-parameter --name /roomtalk/DATABASE_URL --value "postgres://..." --type SecureString
aws ssm put-parameter --name /roomtalk/REDIS_URL --value "rediss://..." --type SecureString
aws ssm put-parameter --name /roomtalk/DEEPSEEK_API_KEY --value "sk-..." --type SecureString
aws ssm put-parameter --name /roomtalk/OPENROUTER_API_KEY --value "sk-or-..." --type SecureString
# ... 其余 secrets
```

ECS Task Definition 通过 `secrets` 字段引用，task role 需要 `ssm:GetParameters` 权限。

## 迁移步骤清单

### Phase 1: 准备（不影响线上）

- [ ] 创建 AWS 账户、开启 billing alerts
- [ ] 创建 VPC、subnets、security groups
- [ ] 创建 ECR repository
- [ ] 创建 RDS PostgreSQL 实例
- [ ] 创建 ElastiCache Redis 节点
- [ ] 创建 S3 media bucket
- [ ] 写入 SSM Parameter Store secrets
- [ ] 创建 ECS cluster + task definition + service
- [ ] 创建 ALB + target group (stickiness enabled)
- [ ] 配置 GitHub Actions OIDC role
- [ ] 部署到 ECS，用 ALB DNS 测试

### Phase 2: 数据迁移

- [ ] `pg_dump` Supabase → `pg_restore` RDS
- [ ] `rclone sync` Tigris → S3
- [ ] 验证 RDS 数据完整性（rooms、messages、media_assets 行数）
- [ ] 验证 S3 文件完整性（对比文件数和总大小）

### Phase 3: 切换

- [ ] DNS 从 Fly.io 切到 ALB (CloudFront)
- [ ] 观察 CloudWatch：错误率、延迟、WebSocket 连接数
- [ ] 验证核心功能：创建房间、发消息、AI 流式、媒体上传下载
- [ ] 保留 Fly.io 服务 48 小时作为回滚

### Phase 4: 清理

- [ ] 确认 AWS 稳定运行 48+ 小时
- [ ] 关闭 Fly.io app
- [ ] 取消 Supabase 项目（保留备份）
- [ ] 删除 Upstash Redis 实例
- [ ] 删除 Tigris bucket（确认 S3 数据完整后）
- [ ] 配置 CloudWatch alarms 和 dashboard

## 成本估算

| 组件 | 规格 | 月费 (us-east-1) |
|---|---|---|
| ECS Fargate | 0.25 vCPU / 512MB × 1 task | ~$9 |
| ALB | 固定费 + LCU | ~$18 |
| RDS PostgreSQL | db.t4g.micro, 20GB | ~$13 |
| ElastiCache | cache.t4g.micro | ~$9 |
| S3 | 按用量 | ~$1-3 |
| CloudWatch | 基础免费，告警 $0.10/alarm | ~$2 |
| ECR | 存储 $0.10/GB | ~$1 |
| Data Transfer | 前 100GB/月免费 | ~$0-5 |
| **合计** | | **~$53-60/月** |

扩展时增长点：Fargate task 数量、RDS 升级到 db.t4g.small ($25)、ElastiCache 开 Multi-AZ。

## 回滚方案

迁移期间 Fly.io 服务保持运行。如果 AWS 出现问题：

1. DNS 切回 Fly.io
2. 确认 Supabase / Upstash / Tigris 数据仍可用
3. 排查 AWS 问题后重新尝试

回滚只需要改 DNS，不需要数据回迁（Fly 侧数据在迁移期间未被删除）。
