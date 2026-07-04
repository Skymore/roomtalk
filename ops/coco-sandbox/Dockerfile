FROM python:3.12-slim-bookworm@sha256:42ada43c4265e1ed6db62ad8df62af99a4abb9a9d49622032522ac76efb0bcef

ARG CODEX_CLI_NPM_VERSION=0.142.5

ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV ROOMTALK_COCO_ARTIFACT_VERSION=roomtalk-coco-2026-07-04-codex-app-server
ENV ROOMTALK_COCO_SOURCE_REF=a4e70e674e46d59a63874371276f5fec0fcd3f41
ENV ROOMTALK_CODEX_CLI_VERSION=${CODEX_CLI_NPM_VERSION}
ENV PYTHONPATH=/opt/coco/src:/opt/roomtalk_coco_runner

WORKDIR /workspace

COPY coco /opt/coco
COPY roomtalk_coco_runner /opt/roomtalk_coco_runner
COPY artifact.lock.json /opt/roomtalk-coco-artifact.lock.json
COPY requirements.lock /opt/roomtalk-coco-requirements.lock

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg git bash bubblewrap \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install -g @openai/codex@${CODEX_CLI_NPM_VERSION} \
  && printf '%s\n' '#!/bin/sh' 'exec python -m roomtalk_coco_runner.platform_tools "$@"' > /usr/local/bin/roomtalk \
  && chmod 755 /usr/local/bin/roomtalk \
  && CODEX_NATIVE_BIN="$(find "$(npm root -g)/@openai/codex" -path '*/vendor/x86_64-unknown-linux-musl/bin/codex' -type f -perm /111 | head -n 1)" \
  && test -n "${CODEX_NATIVE_BIN}" \
  && ln -sf "${CODEX_NATIVE_BIN}" /usr/local/bin/codex-linux-sandbox \
  && codex --version \
  && codex-linux-sandbox --help >/dev/null \
  && roomtalk --help >/dev/null \
  && python -m pip install --no-cache-dir --require-hashes -r /opt/roomtalk-coco-requirements.lock \
  && python -c 'import importlib; importlib.import_module("core.engine"); importlib.import_module("roomtalk_coco_runner.runner"); importlib.import_module("roomtalk_coco_runner.codex_cli"); importlib.import_module("roomtalk_coco_runner.codex_app_server")' \
  && apt-get purge -y --auto-remove curl gnupg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 roomtalk \
  && mkdir -p /tmp/roomtalk-codex \
  && chown -R roomtalk:roomtalk /workspace /tmp/roomtalk-codex \
  && chmod 700 /tmp/roomtalk-codex

USER roomtalk
CMD ["python", "-m", "roomtalk_coco_runner"]
