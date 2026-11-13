# syntax=docker/dockerfile:1
# Long-running assistant demo as a container, for `aspire deploy` (`aspire run` runs it as a Node process instead).
#
# Build from the repository root (the build stage runs natively, so ARM64 hosts cross-build amd64 quickly):
#   docker buildx build -f demos/assistant/Dockerfile --platform linux/amd64 \
#     --build-arg NPM_REGISTRY="$(npm config get registry)" -t managed-copilot-assistant .
#
# The deployment supplies MANAGED_COPILOT_URL, the GitHub identity the assistant acts as, ASSISTANT_PUBLIC_URL, the
# webhook and sealing secrets, and a persistent data directory (ASSISTANT_DATA_DIR, default /data). The entrypoint is
# the lease supervisor from deployments/azure: only one replica at a time runs the server against /data
# (MANAGED_COPILOT_DATA_DIR; MANAGED_COPILOT_LEASE_STAMP orders deployments).
ARG NODE_IMAGE=node:24-bookworm-slim

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
ARG PNPM_VERSION=10.34.5
ARG TARGETARCH
RUN test -n "${NPM_REGISTRY}" || { echo "Pass --build-arg NPM_REGISTRY=<registry URL> (npm config get registry)." >&2; exit 1; }
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_update_notifier=false \
    CI=true
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Install the target platform's native packages as well as the build platform's (Vite needs the latter).
RUN cpu="$(case "${TARGETARCH}" in amd64) echo x64;; *) echo "${TARGETARCH}";; esac)" \
 && printf '\nsupportedArchitectures:\n  os: [current, linux]\n  cpu: [current, %s]\n  libc: [current, glibc]\n' "${cpu}" >> pnpm-workspace.yaml \
 && pnpm fetch
COPY libraries/protocol/ libraries/protocol/
COPY libraries/demo-log/ libraries/demo-log/
COPY libraries/sdk/ libraries/sdk/
COPY libraries/github-theme/ libraries/github-theme/
COPY demos/assistant/ demos/assistant/
COPY deployments/azure/ deployments/azure/
RUN pnpm install --offline --frozen-lockfile --filter @managed-copilot/protocol --filter @managed-copilot/demo-log --filter @managed-copilot/sdk --filter @managed-copilot/github-theme --filter @managed-copilot/demo-assistant --filter @managed-copilot/azure \
 && pnpm --filter @managed-copilot/protocol --filter @managed-copilot/demo-log --filter @managed-copilot/sdk --filter @managed-copilot/demo-assistant --filter @managed-copilot/azure run build
# The single-writer lease supervisor (no dependencies): one replica at a time owns the app's data directory.
RUN mkdir -p /out-azure \
 && cp deployments/azure/package.json /out-azure/ && cp -r deployments/azure/dist /out-azure/ \
 && find /out-azure -name '*.map' -delete
# A production-only install in its own workspace root (/out) with only the target platform's native packages.
# Install scripts are skipped because they would probe the build platform; the final stage checks native packages.
# @github/copilot-sdk is hoisted so @managed-copilot/sdk resolves its peer dependency without dev links.
RUN cpu="$(case "${TARGETARCH}" in amd64) echo x64;; *) echo "${TARGETARCH}";; esac)" \
 && mkdir -p /out/libraries/protocol /out/libraries/demo-log /out/libraries/sdk /out/demos/assistant \
 && cp package.json pnpm-lock.yaml /out/ \
 && sed '/^supportedArchitectures:/,$d' pnpm-workspace.yaml > /out/pnpm-workspace.yaml \
 && printf 'supportedArchitectures:\n  os: [linux]\n  cpu: [%s]\n  libc: [glibc]\npublicHoistPattern:\n  - "@github/copilot-sdk"\n' "${cpu}" >> /out/pnpm-workspace.yaml \
 && for pkg in libraries/protocol libraries/demo-log libraries/sdk demos/assistant; do cp "${pkg}/package.json" "/out/${pkg}/" && cp -r "${pkg}/dist" "/out/${pkg}/"; done \
 && cd /out \
 && pnpm install --prod --offline --frozen-lockfile --ignore-scripts --filter @managed-copilot/protocol --filter @managed-copilot/demo-log --filter @managed-copilot/sdk --filter @managed-copilot/demo-assistant \
 && find /out -name '*.map' -delete

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Managed Copilot assistant demo" \
      org.opencontainers.image.description="Long-running assistant with reminders, Gmail, and Google Calendar"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /opt/managed-copilot/app
COPY --from=build /out-azure /opt/managed-copilot/azure
WORKDIR /opt/managed-copilot/app/demos/assistant
RUN node --input-type=module -e "import { createRequire } from 'node:module'; await import('@managed-copilot/sdk'); createRequire(import.meta.resolve('@github/copilot-sdk'))('koffi'); console.log('packages ok')"
ENV NODE_ENV=production \
    PORT=7490 \
    ASSISTANT_HOSTS=0.0.0.0 \
    ASSISTANT_DATA_DIR=/data
EXPOSE 7490
# Container Apps can briefly run an old and a new revision together; only the lease holder runs the app (the other
# answers 503 on PORT until it takes over), so its SQLite state on the shared volume has one writer.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/azure/dist/lease/main.js", "--"]
CMD ["node", "dist/server/main.js"]
