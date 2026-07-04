FROM node:24.18.0-alpine

WORKDIR /app

ARG CODEX_CLI_NPM_VERSION=0.142.5

# Codex agent turns run inside the E2B sandbox template. The app host keeps a
# small Codex CLI install only for the subscription device-auth handshake.
RUN apk add --no-cache util-linux \
  && npm install -g @openai/codex@${CODEX_CLI_NPM_VERSION} \
  && test -x /usr/bin/script \
  && codex --version

# 复制前端和后端的 package.json
COPY client-heroui/package*.json ./client-heroui/
COPY server/package*.json ./server/

# 安装前端和后端依赖
RUN cd client-heroui && npm ci
RUN cd server && npm ci

# 复制所有源代码
COPY . .

# 构建前端 (使用生产环境变量)
RUN cd client-heroui && npm run build

# 构建后端
RUN cd server && npm run build

# 设置工作目录到服务器
WORKDIR /app/server

# 暴露端口
EXPOSE 3012

# 启动服务器
CMD ["npm", "start"]
