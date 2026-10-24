# Logging forward proxy for sandbox egress qualification (deploy/azure/qualify). No dependencies.
#   docker buildx build --platform linux/amd64 -t <registry>/probe-proxy:1 --push deploy/azure/qualify/probe-proxy
FROM node:24-alpine
WORKDIR /app
COPY proxy.mjs .
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
