FROM node:24.18.0-alpine

WORKDIR /app

ARG CODEX_CLI_NPM_VERSION=0.144.0
ARG USE_PREBUILT_APP=false

# Codex agent turns run inside the E2B sandbox template. The app host keeps a
# small Codex CLI install only for the subscription device-auth handshake.
RUN apk add --no-cache util-linux \
  && npm install -g @openai/codex@${CODEX_CLI_NPM_VERSION} \
  && npm cache clean --force \
  && test -x /usr/bin/script \
  && codex --version

# 复制前端和后端的 package.json
COPY client-heroui/package*.json ./client-heroui/
COPY server/package*.json ./server/

# Install client build dependencies only when the image is building from source.
RUN if [ "${USE_PREBUILT_APP}" != "true" ]; then \
      cd client-heroui && npm ci && npm cache clean --force; \
    fi
RUN cd server && npm ci && npm cache clean --force

# 复制所有源代码
COPY . .

# CI builds the application once and sends the generated output in the Docker
# context. Standalone Docker builds keep the source-build path as a fallback.
RUN if [ "${USE_PREBUILT_APP}" = "true" ]; then \
      test -f client-heroui/dist/index.html; \
    else \
      rm -rf client-heroui/dist && cd client-heroui && npm run build; \
    fi

RUN if [ "${USE_PREBUILT_APP}" = "true" ]; then \
      test -f server/dist/src/server.js; \
    else \
      rm -rf server/dist && cd server && npm run build; \
    fi

# 设置工作目录到服务器
WORKDIR /app/server

# 暴露端口
EXPOSE 3012

# 启动服务器
CMD ["npm", "start"]
