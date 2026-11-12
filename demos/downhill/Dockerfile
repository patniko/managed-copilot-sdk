# syntax=docker/dockerfile:1
# Downhill demo as a container, for `aspire deploy` (`aspire run` runs it as a Node process instead).
#
# Build from the repository root (the build stage runs natively, so ARM64 hosts cross-build amd64 quickly):
#   docker buildx build -f demos/downhill/Dockerfile --platform linux/amd64 \
#     --build-arg NPM_REGISTRY="$(npm config get registry)" -t managed-copilot-downhill .
#
# The game is static files and a small Node server with no dependencies. The server serves the game; passes players'
# support tickets to Help Desk (HELP_DESK_URL, and HELP_DESK_PUBLIC_URL for the player's browser); keeps the shop's
# sales ledger for Data Desk; alerts Incident Commander (INCIDENT_URL, INCIDENT_ALERT_SECRET); and takes its approved
# deploys (DOWNHILL_DEPLOY_SECRET). The shop's checkout imports Contoso Outdoors' storefront code at runtime: the server
# serves the original files from demos/help-desk/storefront (copied into the image) and deployed fixes from its data
# directory (DOWNHILL_DATA_DIR, default /data), and never runs either. The entrypoint is the lease supervisor from
# deployments/azure, like the other published apps: only one replica at a time runs the server against /data
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
COPY demos/downhill/ demos/downhill/
COPY demos/help-desk/storefront/ demos/help-desk/storefront/
COPY deployments/azure/ deployments/azure/
RUN pnpm install --offline --frozen-lockfile --filter @managed-copilot/demo-downhill --filter @managed-copilot/azure \
 && pnpm --filter @managed-copilot/demo-downhill --filter @managed-copilot/azure run build
# The single-writer lease supervisor (no dependencies).
RUN mkdir -p /out-azure \
 && cp deployments/azure/package.json /out-azure/ && cp -r deployments/azure/dist /out-azure/ \
 && find /out-azure -name '*.map' -delete
# The server has no runtime dependencies: the built server and game, the files it locates its package root by, and the
# storefront as it shipped (its package.json, README, code, and tests), which checkout imports and Incident Commander reads.
RUN mkdir -p /out/demos/downhill /out/demos/help-desk/storefront \
 && cp demos/downhill/package.json demos/downhill/apphost.mts /out/demos/downhill/ \
 && cp -r demos/downhill/dist /out/demos/downhill/ \
 && cp -r demos/help-desk/storefront/package.json demos/help-desk/storefront/README.md demos/help-desk/storefront/src demos/help-desk/storefront/test /out/demos/help-desk/storefront/ \
 && find /out -name '*.map' -delete

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Managed Copilot Downhill demo" \
      org.opencontainers.image.description="Downhill: a painterly mountain-biking game with a shop, support from Help Desk's AI agent, and fixes deployed from Incident Commander"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /opt/managed-copilot/app
COPY --from=build /out-azure /opt/managed-copilot/azure
WORKDIR /opt/managed-copilot/app/demos/downhill
RUN test -f dist/server/main.js && test -f dist/web/index.html && test -f dist/web/thumbs/citadel.jpg \
 && test -f ../help-desk/storefront/package.json && test -f ../help-desk/storefront/src/promotions.js \
 && test -f ../help-desk/storefront/src/cart.js && test -f ../help-desk/storefront/test/promotions.test.js
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7455 \
    DOWNHILL_DATA_DIR=/data
EXPOSE 7455
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/managed-copilot/azure/dist/lease/main.js", "--"]
CMD ["node", "dist/server/main.js"]
