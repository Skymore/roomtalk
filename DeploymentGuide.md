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

### Creating Dockerfile

Create a `Dockerfile` in the project root:

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
   fly secrets set CLIENT_URL="https://your-app-name.fly.dev"
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
| NODE_ENV | Running environment | production |
| CLIENT_URL | Client address (optional) | https://example.com |

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
  "rooms": 5,
  "timestamp": "2023-03-30T12:00:00Z"
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

> **Note**: As of July 2024, Fly.io has discontinued their free tier for new users, switching to a "Pay As You Go" model.

### Minimum Cost Estimate

For basic configuration, monthly costs are approximately:

1. **Compute Resources**:
   - Smallest size (shared-cpu-1x, 256MB RAM): ~$2.43/month
   - Only storage costs when machines are stopped: ~$0.15/GB/month

2. **Redis Service**:
   - Upstash Redis charges per command: $0.20/100k commands
   - Estimated $1-5/month for light usage

3. **Data Transfer**:
   - North America & Europe: $0.02/GB
   - Asia Pacific & South America: $0.04/GB
   - Africa & India: $0.12/GB

4. **Total**:
   - Minimum configuration running continuously: ~$3-8/month
   - Running only when needed: depends on usage duration and storage size

### Cost Reduction Strategies

1. Stop machines when not needed (use `fly machine stop` command)
2. Monitor Redis command usage, avoid unnecessary polling operations
3. Optimize data transfer, reduce cross-region traffic
4. Consider compute reservations for 40% discount (for long-term usage) 