# RoomTalk Deployment Guide

This guide provides simplified instructions for deploying your chat application to production environments, particularly for platforms supporting multi-instance deployment like Fly.io.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Deploying to Fly.io](#deploying-to-flyio)
3. [Deploying to Other Platforms](#deploying-to-other-platforms)
4. [Environment Variables](#environment-variables)
5. [Multi-Instance Considerations](#multi-instance-considerations)
6. [Monitoring & Maintenance](#monitoring--maintenance)
7. [Troubleshooting](#troubleshooting)
8. [Fly.io Pricing Information](#flyio-pricing-information)

## Prerequisites

### Building the Application

1. Build the frontend:
   ```bash
   cd client-heroui
   npm install
   npm run build
   ```

2. Build the backend:
   ```bash
   cd server
   npm install
   npm run build
   ```

### Current Dockerfile

The repository already includes the production `Dockerfile`. Keep deployment changes in that file rather than creating a second Dockerfile:

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy package.json files
COPY client-heroui/package*.json ./client-heroui/
COPY server/package*.json ./server/

# Install dependencies
RUN cd client-heroui && npm ci
RUN cd server && npm ci

# Copy all source code
COPY . .

# Build frontend (using production env)
RUN cd client-heroui && npm run build

# Build backend
RUN cd server && npm run build

# Set working directory to server
WORKDIR /app/server

# Expose port
EXPOSE 3012

# Start server
CMD ["npm", "start"]
```

## Deploying to Fly.io

Current production deployment is CI-first. Pushes to `master` and manual
`workflow_dispatch` runs use `.github/workflows/fly-deploy.yml` to build,
verify required Fly secrets, and deploy `message-system` with `flyctl deploy
--remote-only`. Use `fly launch` only when bootstrapping a new Fly app, and do
not run ad hoc `fly deploy` for the existing production app unless CI is
unavailable and the incident owner explicitly chooses a manual deploy.

### 1. Install and Configure Fly CLI

```bash
# MacOS or Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

Add Fly CLI to your PATH:

```bash
# For current session
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

# For permanent addition to your profile
echo 'export FLYCTL_INSTALL="$HOME/.fly"' >> ~/.bashrc
echo 'export PATH="$FLYCTL_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# If using zsh
echo 'export FLYCTL_INSTALL="$HOME/.fly"' >> ~/.zshrc
echo 'export PATH="$FLYCTL_INSTALL/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 2. Login or Sign Up

```bash
fly auth login
```

Follow the prompts to complete login or registration.

### 3. Initialize and Deploy Application

Ensure you're in the project root directory:

```bash
cd /path/to/your/project
fly launch
```

Answer the following questions:
- Choose "Y" when asked to adjust settings
- A web browser will open where you can:
  - Confirm app name and region
  - Add Redis service (choose Upstash as provider)
  - Confirm other settings
- Choose "Y" when asked to create .dockerignore from .gitignore

The system will automatically:
- Create app configuration
- Set up Redis
- Build and deploy your application

If you encounter errors during the build process, fix them and redeploy:

```bash
fly deploy
```

After deployment, you'll need to set environment variables first, then you can access your application at:

```
https://your-app-name.fly.dev
```

### 4. Setting Environment Variables

After deployment, set environment variables:

1. **Get Redis URL from deployment logs**:
   When you run `fly launch` and configure Redis, you'll see output like:
   ```
   Your database message-system-redis is ready. Apps in the personal org can connect to Redis at redis://default:password@fly-message-system-redis.upstash.io:6379
   
   Redis database message-system-redis is set on message-system as the REDIS_URL environment variable
   ```
   Note this URL

2. **Set environment variables via command line**:
   ```bash
   fly secrets set NODE_ENV="production"
   fly secrets set CLIENT_URL="https://room.ruit.me"
   fly secrets set CLIENT_URLS="https://room.ruit.me,https://room.ruit.me"
   fly secrets set REDIS_URL="redis://default:password@fly-message-system-redis.upstash.io:6379"
   ```
   When you use the `fly secrets set` command, Fly.io automatically restarts your application to apply the new environment variables.

3. **Set non-sensitive variables in fly.toml**:
   ```toml
   [env]
     NODE_ENV = "production"
     # Note: Don't put sensitive info like REDIS_URL here
   ```
   Run `fly deploy` to apply changes.

4. **Set via Web Interface**:
   - Login to Fly.io console (https://fly.io/dashboard)
   - Select your application
   - Navigate to "Secrets" tab
   - Add key-value pairs

## Deploying to Other Platforms

### Railway

1. Create new project and connect Git repository
2. Add Redis service
3. Set environment variables:
   - `REDIS_URL`: Redis connection URL
   - `PORT`: 3012
   - `NODE_ENV`: production

### Digital Ocean App Platform

1. Create new app and connect Git repository
2. Add Redis database service
3. Set build command:
   ```
   cd client-heroui && npm install && npm run build && cd ../server && npm install && npm run build
   ```
4. Set run command:
   ```
   cd server && npm start
   ```
5. Set environment variables

### Oracle Cloud

Using perpetually free VM instances:
1. Create two VM instances
2. Run Redis on one instance
3. Run your application on the other
4. Set up firewall rules for necessary ports
5. Configure reverse proxy with SSL certificates

## Environment Variables

The application requires these environment variables:

| Variable | Description | Example Value |
|----------|-------------|---------------|
| PORT | Server listening port | 3012 |
| REDIS_URL | Redis connection URL | redis://user:pass@host:port |
| PERSISTENCE_STORE | Durable store mode, `redis` or `postgres` | postgres |
| DATABASE_URL | PostgreSQL connection URL, required for `PERSISTENCE_STORE=postgres` | postgres://user:pass@host:5432/db |
| POSTGRES_SSL | Enable PostgreSQL TLS | true |
| POSTGRES_SSL_REJECT_UNAUTHORIZED | Validate PostgreSQL TLS certificate | true |
| POSTGRES_SSL_CA_BASE64 / POSTGRES_SSL_CA | Optional managed PostgreSQL root CA | ... |
| ROOM_MESSAGES_CACHE_TTL_SECONDS | Redis message cache TTL in PostgreSQL mode; `0` disables cache writes | 30 |
| NODE_ENV | Running environment | production |
| CLIENT_URL | Primary client address, also used by public callback defaults | https://room.ruit.me |
| CLIENT_URLS | Comma-separated CORS origin allowlist for multiple production domains | https://room.ruit.me,https://room.ruit.me |
| DEEPSEEK_API_KEY | DeepSeek official API key for the default model | sk-... |
| OPENROUTER_API_KEY | OpenRouter key for routed models and AI role drafts | sk-or-... |
| ANTHROPIC_API_KEY | Optional Anthropic official API key | sk-ant-... |
| OPENAI_API_KEY | Optional direct OpenAI API key | sk-... |
| MEDIA_BUCKET_NAME | Private media bucket name | message-system-media |
| MEDIA_STORAGE_ENDPOINT | S3/Tigris-compatible endpoint | https://fly.storage.tigris.dev |
| AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY | Private media storage credentials | ... |
| GOOGLE_CLIENT_ID | Google OAuth Web Client ID accepted by the server | ...apps.googleusercontent.com |
| ASSEMBLYAI_API_KEY | Optional voice transcription key | ... |
| WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY | Optional web-push keys | ... |

## PostgreSQL Rollout

Redis-only persistence remains the default and is the safest rollback path. To cut over durable data to PostgreSQL:

1. Keep the current Redis deployment running and create a PostgreSQL database.
2. Preview migration without writing PostgreSQL:
   ```bash
   cd server
   REDIS_URL="redis://..." npm run migrate:redis-to-postgres -- --dry-run
   ```
3. Run the idempotent migration:
   ```bash
   REDIS_URL="redis://..." DATABASE_URL="postgres://..." npm run migrate:redis-to-postgres
   ```
4. Set production secrets and restart/deploy:
   ```bash
   fly secrets set PERSISTENCE_STORE="postgres"
   fly secrets set DATABASE_URL="postgres://..."
   fly secrets set POSTGRES_SSL="true"
   ```
5. Verify `/api/status` shows `persistenceStore: "postgres"` and the expected room count.

Rollback is configuration-only: set `PERSISTENCE_STORE` back to `redis` and restart/redeploy:

```bash
fly secrets set PERSISTENCE_STORE="redis"
```

Keep Redis data until PostgreSQL mode has been verified with production smoke tests.

Detailed checklist: [docs/postgres-rollout-runbook.md](docs/postgres-rollout-runbook.md).

## Multi-Instance Considerations

Your application now supports multi-instance deployment through:

1. Socket.IO Redis Adapter:
   - Enables Socket.IO message synchronization between instances
   - Ensures broadcast messages reach all users

2. Redis State Management:
   - User session data stored in Redis
   - Room member lists maintained in Redis sets

3. Stateless Application:
   - All server instances share the same state
   - Users can connect to any instance

## Monitoring & Maintenance

### Health Checks

Access the `/api/status` endpoint to view system status, example response:

```json
{
  "status": "online",
  "redis": "connected",
  "socketAdapterReady": true,
  "persistenceStore": "postgres",
  "rooms": 5,
  "timestamp": "2026-06-18T12:00:00Z"
}
```

### Log Management

Your application uses structured logging, recommended:

1. Configure centralized log collection (e.g., ELK Stack, Loki)
2. Monitor error logs
3. Set up alerts for critical events

### Scaling Application

Scale your application on Fly.io:

```bash
# Increase instance count
fly scale count 2

# Increase memory per instance
fly scale memory 512
```

## Troubleshooting

### Fly CLI Command Not Found

If you encounter `zsh: command not found: fly` or similar:

1. Verify Fly CLI installation:
   ```bash
   ls -la $HOME/.fly/bin/flyctl
   ```

2. Add Fly CLI to PATH (temporary fix):
   ```bash
   export FLYCTL_INSTALL="$HOME/.fly"
   export PATH="$FLYCTL_INSTALL/bin:$PATH"
   ```

3. Check if command works:
   ```bash
   which fly
   # or
   $HOME/.fly/bin/flyctl --version
   ```

4. If still having issues, try using full path:
   ```bash
   $HOME/.fly/bin/flyctl auth login
   ```

### WebSocket Connection Issues

If WebSocket connections fail:

1. Check if client connection URL is correct
2. Verify `VITE_SOCKET_URL` environment variable is set correctly
3. Confirm firewall isn't blocking WebSocket traffic

### Redis Connection Issues

If Redis connection fails:

1. Check REDIS_URL environment variable
2. Verify Redis service is running
3. Test Redis connection:
   ```bash
   redis-cli -u $REDIS_URL ping
   ```

### Multi-Instance Sync Issues

If messages aren't syncing between instances:

1. Check Redis adapter settings
2. Verify all instances use the same Redis URL
3. Monitor Redis adapter channel pub/sub activity

## Fly.io Pricing Information

Pricing changes over time and depends on region, VM size, storage, traffic, and
attached services. Check the official [Fly.io pricing page](https://fly.io/docs/about/pricing/)
before estimating production cost. The current `fly.toml` uses a shared CPU VM
with 512 MB memory; Redis, PostgreSQL, Tigris/S3 storage, and AI providers are
billed separately by their providers.

Cost reduction strategies:

1. Stop or auto-stop machines when traffic allows.
2. Monitor Redis command volume and avoid unnecessary polling.
3. Keep media/object storage lifecycle policies explicit.
4. Review AI model pricing before exposing premium models broadly.
