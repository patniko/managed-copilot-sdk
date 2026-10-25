# syntax=docker/dockerfile:1
# Managed Copilot gateway image: the gateway plus the stock headless Copilot runtime it supervises for shared sessions.
# Used by `aspire deploy` (Azure Container Apps); `aspire run` runs the gateway as a Node process instead.
#
# Build from the repository root (the build stage runs natively, so ARM64 hosts cross-build amd64 quickly):
#   docker buildx build -f platform/gateway/Dockerfile --platform linux/amd64 \
#     --build-arg NPM_REGISTRY="$(npm config get registry)" -t managed-copilot-gateway .
#
# The image holds no configuration or secrets. The deployment supplies MANAGED_COPILOT_CONFIG, the keys, and a
# persistent data directory (MANAGED_COPILOT_DATA_DIR, default /data).
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
# Install the target platform's native packages (the stock runtime binary) as well as the build platform's.
RUN cpu="$(case "${TARGETARCH}" in amd64) echo x64;; *) echo "${TARGETARCH}";; esac)" \
 && printf '\nsupportedArchitectures:\n  os: [current, linux]\n  cpu: [current, %s]\n  libc: [current, glibc]\n' "${cpu}" >> pnpm-workspace.yaml \
 && pnpm fetch
COPY packages/protocol/ packages/protocol/
COPY platform/gateway/ platform/gateway/
COPY platform/console/ platform/console/
COPY packages/github-theme/ packages/github-theme/
COPY deploy/azure/ deploy/azure/
# The gateway's tests use the SDK (a dev dependency); pnpm only needs its manifest to resolve the workspace.
COPY packages/sdk/package.json packages/sdk/
# The operator console is static files the gateway serves at /console (built here, never installed in the image).
RUN pnpm install --offline --frozen-lockfile --filter @managed-copilot/protocol --filter @managed-copilot/gateway --filter @managed-copilot/azure --filter @managed-copilot/github-theme --filter @managed-copilot/console \
 && pnpm --filter @managed-copilot/protocol --filter @managed-copilot/gateway --filter @managed-copilot/azure --filter @managed-copilot/console run build \
 && mkdir -p /out-azure \
 && cp deploy/azure/package.json /out-azure/ && cp -r deploy/azure/dist /out-azure/ \
 && find /out-azure -name '*.map' -delete
# A production-only install of the built gateway in its own workspace root (/out), with only the target platform's
# native packages. It reuses the fetched store and the lockfile, so nothing is resolved again. Install scripts are
# skipped because they would probe the build platform; native packages ship as per-platform prebuilt packages, and
# the final stage checks that they load.
RUN cpu="$(case "${TARGETARCH}" in amd64) echo x64;; *) echo "${TARGETARCH}";; esac)" \
 && mkdir -p /out/packages/protocol /out/packages/sdk /out/platform/gateway /out/platform/console \
 && cp package.json pnpm-lock.yaml /out/ \
 && sed '/^supportedArchitectures:/,$d' pnpm-workspace.yaml > /out/pnpm-workspace.yaml \
 && printf 'supportedArchitectures:\n  os: [linux]\n  cpu: [%s]\n  libc: [glibc]\n' "${cpu}" >> /out/pnpm-workspace.yaml \
 && cp packages/protocol/package.json /out/packages/protocol/ && cp -r packages/protocol/dist /out/packages/protocol/ \
 && cp packages/sdk/package.json /out/packages/sdk/ \
 && cp platform/gateway/package.json /out/platform/gateway/ && cp -r platform/gateway/dist /out/platform/gateway/ \
 && cp -r platform/console/dist /out/platform/console/ \
 && cd /out \
 && pnpm install --prod --offline --frozen-lockfile --ignore-scripts --filter @managed-copilot/protocol --filter @managed-copilot/gateway \
 && find /out -name '*.map' -delete

FROM ${NODE_IMAGE} AS gateway
LABEL org.opencontainers.image.title="Managed Copilot gateway" \
      org.opencontainers.image.description="Managed Copilot gateway with the stock headless Copilot runtime"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /opt/managed-copilot/app
WORKDIR /opt/managed-copilot/app/platform/gateway
# Fail the build if the stock runtime or a native package does not load on the target platform.
RUN node --input-type=module -e "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; import { accessSync, constants } from 'node:fs'; const require = createRequire(join(process.cwd(), 'package.json')); const sdk = createRequire(require.resolve('@github/copilot-sdk')); const platform = 'linux-' + process.arch; const runtime = join(dirname(sdk.resolve('@github/copilot-sdk-' + platform + '/package.json')), 'prebuilds', platform, 'copilot-runtime'); accessSync(runtime, constants.X_OK); sdk('koffi'); console.log('runtime ok:', runtime);"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    MANAGED_COPILOT_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# Azure Container Apps: the gateway's data directory is an NFS share that two replicas can briefly share (revision
# swaps, platform maintenance), so the lease supervisor runs the gateway only while this replica holds the share's
# single-writer lease. The storage probe qualifies the mount (`node /opt/managed-copilot/azure/dist/probe/main.js`).
FROM gateway AS azure
COPY --from=build /out-azure /opt/managed-copilot/azure
# /data is the deployment's persistent volume; the lease supervisor and the gateway both use it.
ENV MANAGED_COPILOT_MODE=azure \
    MANAGED_COPILOT_DATA_DIR=/data
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/azure/dist/lease/main.js", "--"]
CMD ["node", "dist/main.js"]
