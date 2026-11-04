# Managed Copilot egress proxy. Build `pnpm --filter @managed-copilot/egress build` first; the image only copies
# the bundled dist/egress.mjs, so building it needs no package registry access.
FROM node:24-alpine
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=32 \
    EGRESS_DATA_DIR=/var/lib/managed-copilot-egress
WORKDIR /opt/managed-copilot-egress
COPY dist/egress.mjs ./egress.mjs
RUN mkdir -p /var/lib/managed-copilot-egress && chown node:node /var/lib/managed-copilot-egress
USER node
EXPOSE 3128
VOLUME ["/var/lib/managed-copilot-egress"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:3128/healthz >/dev/null || exit 1
CMD ["node", "egress.mjs"]
