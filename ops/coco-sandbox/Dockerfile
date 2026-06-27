FROM python:3.12-slim-bookworm@sha256:42ada43c4265e1ed6db62ad8df62af99a4abb9a9d49622032522ac76efb0bcef

ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV ROOMTALK_COCO_ARTIFACT_VERSION=roomtalk-coco-2026-06-27-7ac42db
ENV ROOMTALK_COCO_SOURCE_REF=7ac42db5b270168366cd836b2b14ec7eb4604cdf
ENV PYTHONPATH=/opt/coco/src:/opt/roomtalk_coco_runner

WORKDIR /workspace

COPY coco /opt/coco
COPY roomtalk_coco_runner /opt/roomtalk_coco_runner
COPY artifact.lock.json /opt/roomtalk-coco-artifact.lock.json
COPY requirements.lock /opt/roomtalk-coco-requirements.lock

RUN python -m pip install --no-cache-dir --require-hashes -r /opt/roomtalk-coco-requirements.lock \
  && python -c 'import importlib; importlib.import_module("core.engine"); importlib.import_module("roomtalk_coco_runner.runner")'

RUN useradd --create-home --uid 10001 roomtalk \
  && chown -R roomtalk:roomtalk /workspace

USER roomtalk
CMD ["python", "-m", "roomtalk_coco_runner"]
