# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24.18.0-alpine

FROM ${NODE_IMAGE} AS client-build

WORKDIR /app/client-heroui

COPY client-heroui/package*.json ./
RUN npm ci --no-audit --no-fund \
  && npm cache clean --force

COPY client-heroui/.env.production ./
COPY client-heroui/index.html ./
COPY client-heroui/postcss.config.js ./
COPY client-heroui/tailwind.config.js ./
COPY client-heroui/tsconfig*.json ./
COPY client-heroui/vite.config.ts ./
COPY client-heroui/public ./public
COPY client-heroui/scripts ./scripts
COPY client-heroui/src ./src

RUN npm run translate:i18n:dry \
  && npm run build

FROM ${NODE_IMAGE} AS server-build

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --no-audit --no-fund \
  && npm cache clean --force

COPY server/tsconfig.json ./
COPY server/src ./src

# TypeScript does not copy the sticker catalog, so make the compiled output
# self-contained before it is transferred into the runtime image.
RUN npm run build \
  && mkdir -p dist/src/stickers/data \
  && cp src/stickers/data/catalog.json dist/src/stickers/data/catalog.json

FROM server-build AS server-runtime-deps

RUN npm prune --omit=dev --no-audit --no-fund \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ARG CODEX_CLI_NPM_VERSION=0.144.0

# Codex agent turns run inside the E2B sandbox template. The app host keeps a
# small Codex CLI install only for the subscription device-auth handshake.
RUN apk add --no-cache util-linux \
  && npm install -g @openai/codex@${CODEX_CLI_NPM_VERSION} \
  && npm cache clean --force \
  && test -x /usr/bin/script \
  && codex --version

COPY --from=server-runtime-deps /app/server/package*.json ./server/
COPY --from=server-runtime-deps /app/server/node_modules ./server/node_modules
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=client-build /app/client-heroui/dist ./client-heroui/dist

WORKDIR /app/server

EXPOSE 3012

CMD ["npm", "start"]
