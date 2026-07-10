FROM python:3.12-slim-bookworm@sha256:42ada43c4265e1ed6db62ad8df62af99a4abb9a9d49622032522ac76efb0bcef

ARG CODEX_CLI_NPM_VERSION=0.144.0
ARG PLAYWRIGHT_NPM_VERSION=1.61.1
ARG PNPM_NPM_VERSION=11.10.0
ARG YARN_NPM_VERSION=1.22.22
ARG TYPESCRIPT_NPM_VERSION=6.0.3
ARG TSX_NPM_VERSION=4.23.0
ARG OH_MY_ZSH_REF=677a4592b18c08ddea737f8aca70bac0e9fc9313
ARG POWERLEVEL10K_REF=9253fb1c5034410c43a0c681ff8294181c54016c

ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV ROOMTALK_CODE_AGENT_ARTIFACT_VERSION=roomtalk-code-agent-2026-07-10-room-context-cli-v1
ENV ROOMTALK_CODE_AGENT_SOURCE_REF=d7048779e43aaade9fa0abccf42fcca9c6857e1a
ENV ROOMTALK_CODEX_CLI_VERSION=${CODEX_CLI_NPM_VERSION}
ENV ROOMTALK_PLAYWRIGHT_VERSION=${PLAYWRIGHT_NPM_VERSION}
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_PATH=/usr/lib/node_modules
ENV PYTHONPATH=/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner

WORKDIR /workspace

COPY code-agent-engine /opt/code-agent-engine
COPY roomtalk_code_agent_runner /opt/roomtalk_code_agent_runner
COPY artifact.lock.json /opt/roomtalk-code-agent-artifact.lock.json
COPY requirements.lock /opt/roomtalk-code-agent-requirements.lock
COPY codex-sdk.requirements.lock /opt/roomtalk-codex-sdk-requirements.lock

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    build-essential \
    ca-certificates \
    cargo \
    cmake \
    composer \
    curl \
    dnsutils \
    fd-find \
    file \
    git \
    git-lfs \
    gnupg \
    golang-go \
    iproute2 \
    iputils-ping \
    jq \
    less \
    lsof \
    maven \
    netcat-openbsd \
    ninja-build \
    openjdk-17-jdk-headless \
    openssh-client \
    php-cli \
    pkg-config \
    postgresql-client \
    procps \
    psmisc \
    redis-tools \
    ripgrep \
    rsync \
    ruby-full \
    shellcheck \
    sqlite3 \
    tree \
    unzip \
    wget \
    xz-utils \
    zsh \
    zip \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install -g \
    @openai/codex@${CODEX_CLI_NPM_VERSION} \
    playwright@${PLAYWRIGHT_NPM_VERSION} \
    pnpm@${PNPM_NPM_VERSION} \
    yarn@${YARN_NPM_VERSION} \
    typescript@${TYPESCRIPT_NPM_VERSION} \
    tsx@${TSX_NPM_VERSION} \
  && npm cache clean --force \
  && mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" \
  && playwright install --with-deps chromium \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && git lfs install --system \
  && { echo '#!/bin/sh'; echo 'exec python -m roomtalk_code_agent_runner.platform_tools "$@"'; } > /usr/local/bin/roomtalk \
  && chmod 755 /usr/local/bin/roomtalk \
  && CODEX_NATIVE_BIN="$(find "$(npm root -g)/@openai/codex" -path '*/vendor/x86_64-unknown-linux-musl/bin/codex' -type f -perm /111 | head -n 1)" \
  && test -n "${CODEX_NATIVE_BIN}" \
  && ln -sf "${CODEX_NATIVE_BIN}" /usr/local/bin/codex-linux-sandbox \
  && codex --version \
  && codex-linux-sandbox --help >/dev/null \
  && playwright --version >/dev/null \
  && node -e 'const { chromium } = require("playwright"); const fs = require("fs"); const executable = chromium.executablePath(); if (!fs.existsSync(executable)) { console.error(`missing Chromium executable: ${executable}`); process.exit(1); }' \
  && curl --version >/dev/null \
  && wget --version >/dev/null \
  && jq --version >/dev/null \
  && rg --version >/dev/null \
  && fd --version >/dev/null \
  && git --version >/dev/null \
  && git lfs version >/dev/null \
  && python --version >/dev/null \
  && pip --version >/dev/null \
  && node --version >/dev/null \
  && npm --version >/dev/null \
  && pnpm --version >/dev/null \
  && yarn --version >/dev/null \
  && tsc --version >/dev/null \
  && tsx --version >/dev/null \
  && gcc --version >/dev/null \
  && g++ --version >/dev/null \
  && make --version >/dev/null \
  && cmake --version >/dev/null \
  && ninja --version >/dev/null \
  && go version >/dev/null \
  && rustc --version >/dev/null \
  && cargo --version >/dev/null \
  && java -version >/dev/null 2>&1 \
  && javac -version >/dev/null 2>&1 \
  && mvn --version >/dev/null \
  && ruby --version >/dev/null \
  && php --version >/dev/null \
  && composer --version >/dev/null \
  && psql --version >/dev/null \
  && redis-cli --version >/dev/null \
  && shellcheck --version >/dev/null \
  && zsh --version >/dev/null \
  && roomtalk --help >/dev/null \
  && python -m pip install --no-cache-dir --require-hashes -r /opt/roomtalk-code-agent-requirements.lock \
  && python -m pip install --no-cache-dir --no-deps --require-hashes -r /opt/roomtalk-codex-sdk-requirements.lock \
  && python -c 'import importlib; importlib.import_module("core.engine"); importlib.import_module("roomtalk_code_agent_runner.runner"); importlib.import_module("roomtalk_code_agent_runner.codex_cli"); importlib.import_module("roomtalk_code_agent_runner.codex_app_server"); importlib.import_module("roomtalk_code_agent_runner.codex_sdk_app_server"); importlib.import_module("openai_codex")' \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 roomtalk \
  && mkdir -p /tmp/roomtalk-codex \
  && git init -q /home/roomtalk/.oh-my-zsh \
  && git -C /home/roomtalk/.oh-my-zsh remote add origin https://github.com/ohmyzsh/ohmyzsh.git \
  && git -C /home/roomtalk/.oh-my-zsh fetch --depth=1 origin "${OH_MY_ZSH_REF}" \
  && git -C /home/roomtalk/.oh-my-zsh checkout --detach FETCH_HEAD \
  && mkdir -p /home/roomtalk/.oh-my-zsh/custom/themes/powerlevel10k \
  && git init -q /home/roomtalk/.oh-my-zsh/custom/themes/powerlevel10k \
  && git -C /home/roomtalk/.oh-my-zsh/custom/themes/powerlevel10k remote add origin https://github.com/romkatv/powerlevel10k.git \
  && git -C /home/roomtalk/.oh-my-zsh/custom/themes/powerlevel10k fetch --depth=1 origin "${POWERLEVEL10K_REF}" \
  && git -C /home/roomtalk/.oh-my-zsh/custom/themes/powerlevel10k checkout --detach FETCH_HEAD \
  && { \
    echo 'if [ -t 0 ] && [ -z "${ROOMTALK_TERMINAL_STAY_IN_BASH:-}" ] && command -v zsh >/dev/null 2>&1; then'; \
    echo '  export SHELL="$(command -v zsh)"'; \
    echo '  exec "$SHELL" -l'; \
    echo 'fi'; \
  } > /home/roomtalk/.bash_profile \
  && { \
    echo 'export ZSH="$HOME/.oh-my-zsh"'; \
    echo 'ZSH_THEME="powerlevel10k/powerlevel10k"'; \
    echo 'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true'; \
    echo 'plugins=(git)'; \
    echo 'source "$ZSH/oh-my-zsh.sh"'; \
    echo '[[ ! -f "$HOME/.p10k.zsh" ]] || source "$HOME/.p10k.zsh"'; \
  } > /home/roomtalk/.zshrc \
  && { \
    echo 'typeset -g POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true'; \
    echo 'typeset -g POWERLEVEL9K_INSTANT_PROMPT=off'; \
    echo 'typeset -g POWERLEVEL9K_MODE=ascii'; \
    echo 'typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(dir vcs prompt_char)'; \
    echo 'typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(status command_execution_time background_jobs time)'; \
    echo 'typeset -g POWERLEVEL9K_PROMPT_ADD_NEWLINE=true'; \
    echo 'typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_VIINS_CONTENT_EXPANSION=">"'; \
    echo 'typeset -g POWERLEVEL9K_PROMPT_CHAR_ERROR_VIINS_CONTENT_EXPANSION=">"'; \
    echo 'typeset -g POWERLEVEL9K_TIME_FORMAT="%D{%H:%M}"'; \
    echo 'typeset -g POWERLEVEL9K_DIR_MAX_LENGTH=48'; \
    echo 'typeset -g POWERLEVEL9K_SHORTEN_STRATEGY=truncate_to_unique'; \
  } > /home/roomtalk/.p10k.zsh \
  && chown -R roomtalk:roomtalk /workspace /tmp/roomtalk-codex "${PLAYWRIGHT_BROWSERS_PATH}" \
  && chown -R roomtalk:roomtalk /home/roomtalk/.oh-my-zsh /home/roomtalk/.bash_profile /home/roomtalk/.zshrc /home/roomtalk/.p10k.zsh \
  && test -f /home/roomtalk/.oh-my-zsh/oh-my-zsh.sh \
  && test -f /home/roomtalk/.oh-my-zsh/custom/themes/powerlevel10k/powerlevel10k.zsh-theme \
  && chmod 700 /tmp/roomtalk-codex

USER roomtalk
CMD ["python", "-m", "roomtalk_code_agent_runner"]
