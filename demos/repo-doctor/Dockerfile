# syntax=docker/dockerfile:1
# Repo Doctor demo as a container, for `aspire deploy` (`aspire run` runs it as a Node process instead).
#
# Build from the repository root (the build stage runs natively, so ARM64 hosts cross-build amd64 quickly):
#   docker buildx build -f demos/repo-doctor/Dockerfile --platform linux/amd64 \
#     --build-arg NPM_REGISTRY="$(npm config get registry)" -t managed-copilot-repo-doctor .
#
# The deployment supplies MANAGED_COPILOT_URL, the GitHub identity Repo Doctor acts as, and a persistent data
# directory (REPO_DOCTOR_DATA_DIR, default /data) for its run history: each run's steps, logs, tests, and patch.
# Sandboxes live in Managed Copilot, one per run, deleted when the run ends. The entrypoint is the lease supervisor from
# deployments/azure: only one replica at a time runs the server against /data (MANAGED_COPILOT_DATA_DIR;
# MANAGED_COPILOT_LEASE_STAMP orders deployments).
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
COPY libraries/sdk/ libraries/sdk/
COPY libraries/github-theme/ libraries/github-theme/
COPY demos/repo-doctor/ demos/repo-doctor/
COPY deployments/azure/ deployments/azure/
RUN pnpm install --offline --frozen-lockfile --filter @managed-copilot/protocol --filter @managed-copilot/sdk --filter @managed-copilot/github-theme --filter @managed-copilot/demo-repo-doctor --filter @managed-copilot/azure \
 && pnpm --filter @managed-copilot/protocol --filter @managed-copilot/sdk --filter @managed-copilot/demo-repo-doctor --filter @managed-copilot/azure run build
# The single-writer lease supervisor (no dependencies): one replica at a time owns the app's data directory.
RUN mkdir -p /out-azure \
 && cp deployments/azure/package.json /out-azure/ && cp -r deployments/azure/dist /out-azure/ \
 && find /out-azure -name '*.map' -delete
# A production-only install in its own workspace root (/out) with only the target platform's native packages.
# Install scripts are skipped because they would probe the build platform; the final stage checks native packages.
# @github/copilot-sdk is hoisted so @managed-copilot/sdk resolves its peer dependency without dev links.
# The server locates its package root by apphost.mts and package.json, so both are kept, and the sample project it
# uploads into sandboxes.
RUN cpu="$(case "${TARGETARCH}" in amd64) echo x64;; *) echo "${TARGETARCH}";; esac)" \
 && mkdir -p /out/libraries/protocol /out/libraries/sdk /out/demos/repo-doctor \
 && cp package.json pnpm-lock.yaml /out/ \
 && sed '/^supportedArchitectures:/,$d' pnpm-workspace.yaml > /out/pnpm-workspace.yaml \
 && printf 'supportedArchitectures:\n  os: [linux]\n  cpu: [%s]\n  libc: [glibc]\npublicHoistPattern:\n  - "@github/copilot-sdk"\n' "${cpu}" >> /out/pnpm-workspace.yaml \
 && for pkg in libraries/protocol libraries/sdk demos/repo-doctor; do cp "${pkg}/package.json" "/out/${pkg}/" && cp -r "${pkg}/dist" "/out/${pkg}/"; done \
 && cp demos/repo-doctor/apphost.mts /out/demos/repo-doctor/ \
 && cp -r demos/repo-doctor/sample /out/demos/repo-doctor/ \
 && cd /out \
 && pnpm install --prod --offline --frozen-lockfile --ignore-scripts --filter @managed-copilot/protocol --filter @managed-copilot/sdk --filter @managed-copilot/demo-repo-doctor \
 && find /out -name '*.map' -delete

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Managed Copilot Repo Doctor demo" \
      org.opencontainers.image.description="Repo Doctor: one isolated sandbox per run clones a repository, reproduces its failing tests, fixes them, and returns a verified patch"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /opt/managed-copilot/app
COPY --from=build /out-azure /opt/managed-copilot/azure
WORKDIR /opt/managed-copilot/app/demos/repo-doctor
RUN node --input-type=module -e "import { createRequire } from 'node:module'; await import('@managed-copilot/sdk'); createRequire(import.meta.resolve('@github/copilot-sdk'))('koffi'); console.log('packages ok')" \
 && test -f sample/package.json
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7435 \
    REPO_DOCTOR_DATA_DIR=/data
EXPOSE 7435
# Container Apps can briefly run an old and a new revision together; only the lease holder runs the app (the other
# answers 503 on PORT until it takes over), so its records on the shared volume have one writer.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/azure/dist/lease/main.js", "--"]
CMD ["node", "dist/server/main.js"]
