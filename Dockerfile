# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv@sha256:b46b03ddfcfbf8f547af7e9eaefdf8a39c8cebcba7c98858d3162bd28cf536f6 AS uv-bin

FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732

ARG CODEX_NPM_VERSION=latest
ARG NPM_VERSION=11.16.0
ARG NPM_UNDICI_VERSION=6.27.0
ARG NPM_UNDICI_SHA256=cb4ecdf54572260fbbbd0fb03929ff04ca1be8b3d3bb41e60e8b4a72fc2b1036
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    CODEX_NPM_VERSION=${CODEX_NPM_VERSION} \
    CODEX_UPDATE_ON_START=true \
    CODEX_UPDATE_ON_START_TIMEOUT=180 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        bash \
        bubblewrap \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        libgnutls30 \
        openssh-server \
        passwd \
        procps \
        python3 \
        python3-venv \
        ripgrep \
        tini \
        tmux \
        util-linux \
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv-bin /uv /uvx /usr/local/bin/

RUN set -euo pipefail; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64|x86_64) ttyd_asset="ttyd.x86_64"; ttyd_sha256="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55" ;; \
      arm64|aarch64) ttyd_asset="ttyd.aarch64"; ttyd_sha256="b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165" ;; \
      *) echo "unsupported TARGETARCH for ttyd: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${ttyd_asset}" -o /usr/local/bin/ttyd; \
    echo "${ttyd_sha256}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/ttyd

RUN set -euo pipefail; \
    npm install -g "npm@${NPM_VERSION}" "@openai/codex@${CODEX_NPM_VERSION}"; \
    npm_root="$(npm root -g)"; \
    npm pack "undici@${NPM_UNDICI_VERSION}" --pack-destination /tmp; \
    echo "${NPM_UNDICI_SHA256}  /tmp/undici-${NPM_UNDICI_VERSION}.tgz" | sha256sum -c -; \
    rm -rf "${npm_root}/npm/node_modules/undici"; \
    mkdir -p "${npm_root}/npm/node_modules/undici"; \
    tar -xzf "/tmp/undici-${NPM_UNDICI_VERSION}.tgz" -C "${npm_root}/npm/node_modules/undici" --strip-components=1; \
    actual_undici_version="$(node -p "require('${npm_root}/npm/node_modules/undici/package.json').version")"; \
    test "${actual_undici_version}" = "${NPM_UNDICI_VERSION}"; \
    rm -f "/tmp/undici-${NPM_UNDICI_VERSION}.tgz"; \
    npm cache clean --force

RUN groupmod -n codex node \
    && usermod -l codex -d /home/codex -m node \
    && passwd -l root \
    && usermod -p "$(openssl passwd -6 "$(openssl rand -base64 48)")" codex \
    && mkdir -p /config /etc/codex-terminal /home/codex /run/sshd /var/empty \
    && rm -rf /home/codex/.cache /home/codex/.codex /home/codex/.local /workspace \
    && ln -s /config/.codex /home/codex/.codex \
    && ln -s /config/cache /home/codex/.cache \
    && ln -s /config/local /home/codex/.local \
    && ln -s /config/workspace /workspace \
    && chown -R codex:codex /home/codex \
    && chown -h codex:codex /home/codex/.cache /home/codex/.codex /home/codex/.local /workspace

COPY sshd_config /etc/codex-terminal/sshd_config
COPY codex-terminal-shell /usr/local/bin/codex-terminal-shell
COPY codex-terminal-profile.sh /etc/profile.d/codex-terminal.sh
COPY entrypoint.sh /usr/local/bin/codex-terminal-entrypoint
COPY media-path-check /usr/local/bin/media-path-check
COPY web-terminal.sh /usr/local/bin/codex-web-terminal

RUN chmod 0644 /etc/codex-terminal/sshd_config \
    && chmod 0755 /usr/local/bin/codex-terminal-shell \
    && chmod 0644 /etc/profile.d/codex-terminal.sh \
    && chmod 0755 /usr/local/bin/codex-terminal-entrypoint /usr/local/bin/media-path-check /usr/local/bin/codex-web-terminal \
    && printf '%s\n' /usr/local/bin/codex-terminal-shell >> /etc/shells \
    && usermod -s /usr/local/bin/codex-terminal-shell codex

EXPOSE 2222 7681

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/codex-terminal-entrypoint"]
CMD ["/usr/local/bin/codex-web-terminal"]
