# syntax=docker/dockerfile:1
# The demo gallery as a container, for `aspire deploy` (locally, `pnpm gallery` runs it on this machine instead).
#
# Build from the repository root (the build stage runs natively, so ARM64 hosts cross-build amd64 quickly):
#   docker buildx build -f demos/gallery/Dockerfile --platform linux/amd64 \
#     --build-arg NPM_REGISTRY="$(npm config get registry)" -t managed-copilot-gallery .
#
# Hosted mode (GALLERY_HOSTED=1): the deployment in MANAGED_COPILOT_URL only, answering the names in
# GALLERY_ALLOWED_HOSTS. It holds no GitHub token and never mints console sign-in links. The entrypoint is the lease
# supervisor from deployments/azure, like the other published apps (MANAGED_COPILOT_DATA_DIR, MANAGED_COPILOT_LEASE_STAMP).
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
COPY libraries/cli/ libraries/cli/
COPY libraries/github-theme/ libraries/github-theme/
COPY demos/gallery/ demos/gallery/
COPY deployments/azure/ deployments/azure/
RUN pnpm install --offline --frozen-lockfile --filter @managed-copilot/protocol --filter @managed-copilot/sdk --filter @managed-copilot/cli --filter @managed-copilot/github-theme --filter @managed-copilot/demo-gallery --filter @managed-copilot/azure \
 && pnpm --filter @managed-copilot/protocol --filter @managed-copilot/sdk --filter @managed-copilot/cli --filter @managed-copilot/demo-gallery --filter @managed-copilot/azure run build
# The single-writer lease supervisor (no dependencies).
RUN mkdir -p /out-azure \
 && cp deployments/azure/package.json /out-azure/ && cp -r deployments/azure/dist /out-azure/ \
 && find /out-azure -name '*.map' -delete
# A production-only install in its own workspace root (/out) with only the target platform's native packages.
# Install scripts are skipped because they would probe the build platform. @github/copilot-sdk is hoisted so
# @managed-copilot/sdk resolves its peer dependency without dev links.
RUN cpu="$(case "${TARGETARCH}" in amd64) echo x64;; *) echo "${TARGETARCH}";; esac)" \
 && mkdir -p /out/libraries/protocol /out/libraries/sdk /out/libraries/cli /out/demos/gallery \
 && cp package.json pnpm-lock.yaml /out/ \
 && sed '/^supportedArchitectures:/,$d' pnpm-workspace.yaml > /out/pnpm-workspace.yaml \
 && printf 'supportedArchitectures:\n  os: [linux]\n  cpu: [%s]\n  libc: [glibc]\npublicHoistPattern:\n  - "@github/copilot-sdk"\n' "${cpu}" >> /out/pnpm-workspace.yaml \
 && for pkg in libraries/protocol libraries/sdk libraries/cli demos/gallery; do cp "${pkg}/package.json" "/out/${pkg}/" && cp -r "${pkg}/dist" "/out/${pkg}/"; done \
 && cp -r libraries/cli/bin /out/libraries/cli/ \
 && cp -r demos/gallery/shots /out/demos/gallery/ \
 && cd /out \
 && pnpm install --prod --offline --frozen-lockfile --ignore-scripts --filter @managed-copilot/protocol --filter @managed-copilot/sdk --filter @managed-copilot/cli --filter @managed-copilot/demo-gallery \
 && find /out -name '*.map' -delete

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Managed Copilot demo gallery" \
      org.opencontainers.image.description="Every demo and walkthrough of a Managed Copilot deployment on one page"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /opt/managed-copilot/app
COPY --from=build /out-azure /opt/managed-copilot/azure
WORKDIR /opt/managed-copilot/app/demos/gallery
RUN node --input-type=module -e "await import('@managed-copilot/cli'); console.log('packages ok')" \
 && test -f dist/web/index.html && test -d shots
ENV NODE_ENV=production \
    GALLERY_HOSTED=1 \
    HOST=0.0.0.0 \
    PORT=7460
EXPOSE 7460
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/azure/dist/lease/main.js", "--"]
CMD ["node", "dist/server/main.js"]
