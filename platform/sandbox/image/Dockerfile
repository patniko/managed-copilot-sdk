# Managed Copilot base sandbox image (spec section 1; architecture "Isolated placement").
#
# Contents: Node 24, git, curl, jq, ripgrep, Python 3 with pip/venv, CA certificates, the stock headless Copilot
# runtime from @github/copilot-sdk (installed from npm through the operator's registry), and the platform agent
# (sandboxd). Workloads run as uid/gid 10001 in /workspace; sandboxd itself is started as root by the platform.
#
# Build from platform/sandbox after `pnpm build` (the gateway does this automatically):
#   docker build -f image/Dockerfile --build-arg NPM_REGISTRY=<npm config get registry> \
#     -t ghcr.io/patniko/managed-copilot-sandbox:0.1.0 .
#
# Customer images extend it and must keep its non-root execution, transport, and certificate-trust contract:
#   FROM ghcr.io/patniko/managed-copilot-sandbox:0.1.0
#   USER root
#   RUN apt-get update && apt-get install -y python3-pip
#   USER 10001:10001
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG NPM_REGISTRY
ARG PIP_INDEX_URL=
ARG COPILOT_SDK_VERSION=1.0.26
ARG SANDBOXD_VERSION=0.1.0

LABEL org.opencontainers.image.title="Managed Copilot sandbox" \
      org.opencontainers.image.description="Base image for Managed Copilot isolated sandboxes" \
      managed-copilot.copilot-sdk="${COPILOT_SDK_VERSION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less openssh-client procps python3 python3-pip python3-venv ripgrep tini unzip zip \
 && rm -rf /var/lib/apt/lists/*

# Session-time npm installs use the operator's registry by default (npm's builtin config is read regardless of the
# per-session prefix), and pip uses the operator's index when one is given. Network policy still applies: the
# registry and index hosts must be allowed for the session.
RUN test -n "${NPM_REGISTRY}" || { echo "Pass --build-arg NPM_REGISTRY=<registry URL> (npm config get registry)." >&2; exit 1; } \
 && echo "registry=${NPM_REGISTRY}" >> /usr/local/lib/node_modules/npm/npmrc \
 && if [ -n "${PIP_INDEX_URL}" ]; then printf '[global]\nindex-url = %s\n' "${PIP_INDEX_URL}" > /etc/pip.conf; fi

# The stock headless runtime the Copilot SDK spawns by default (@github/copilot-sdk-<platform>/prebuilds/.../copilot-runtime).
RUN mkdir -p /opt/managed-copilot/runtime \
 && cd /opt/managed-copilot/runtime \
 && echo '{"name":"managed-copilot-runtime","private":true}' > package.json \
 && npm install --no-audit --no-fund --omit=dev "@github/copilot-sdk@${COPILOT_SDK_VERSION}" \
 && arch="$(node -p 'process.arch')" \
 && runtime="/opt/managed-copilot/runtime/node_modules/@github/copilot-sdk-linux-${arch}/prebuilds/linux-${arch}/copilot-runtime" \
 && test -x "${runtime}" \
 && printf '#!/bin/sh\nexec "%s" "$@"\n' "${runtime}" > /usr/local/bin/copilot-runtime \
 && chmod 0755 /usr/local/bin/copilot-runtime \
 && npm cache clean --force

# Workload identity and the layout each session's volumes are pre-populated from.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --create-home --shell /bin/bash agent \
 && mkdir -p /workspace/outputs /opt/managed-copilot/customizations /var/lib/managed-copilot/runtime /var/lib/managed-copilot/sandboxd \
 && chown -R 10001:10001 /workspace /var/lib/managed-copilot/runtime \
 && chmod 0700 /var/lib/managed-copilot/runtime /var/lib/managed-copilot/sandboxd
USER 10001:10001
RUN python3 -m venv /home/agent/.venv \
 && mkdir -p /home/agent/.npm-global/bin /home/agent/.local/bin
USER root

# The platform agent (sandboxd) and relay.
WORKDIR /opt/managed-copilot/sandboxd
COPY image/sandboxd-package.json package.json
RUN npm install --no-audit --no-fund --omit=dev && npm cache clean --force
COPY dist/ dist/
COPY image/trust-ca.sh /usr/local/bin/managed-copilot-trust-ca
RUN sed -i 's/\r$//' /usr/local/bin/managed-copilot-trust-ca && chmod 0755 /usr/local/bin/managed-copilot-trust-ca
ENV SANDBOXD_VERSION=${SANDBOXD_VERSION}

WORKDIR /workspace
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/sandboxd/dist/sandboxd/main.js"]
