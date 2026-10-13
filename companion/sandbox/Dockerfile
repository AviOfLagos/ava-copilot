# Nex Brain's sandbox image: Node 24 (pnpm through corepack) and Python 3, run as an unprivileged user.
# Every command runs in a fresh container from this image with no network (unless the agent profile
# allows it), a read-only root, CPU/memory/process limits and only its workspace mounted (see
# src/sandbox/docker.ts). Build it once with `pnpm sandbox:build` (needs Docker running and the network).

# node:24-bookworm-slim, pinned to the index digest seen on 2026-10-12; bump deliberately
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ENV COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.34.6 --activate \
 && chmod -R a+rX /usr/local/share/corepack

# uid 1000 is the image's "node" user; the companion also passes --user 1000:1000
USER 1000:1000
WORKDIR /workspace
