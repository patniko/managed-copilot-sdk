# syntax=docker/dockerfile:1
# Azure layer for a Managed Copilot sandbox image (Azure Container Apps Sandboxes backend).
#
# Built at deploy time on top of each isolated environment's image (the base sandbox image or a customer image FROM it):
#   docker buildx build -f deploy/azure/sandbox/Dockerfile --platform linux/amd64 \
#     --build-arg BASE_IMAGE=<environment image> deploy/azure/sandbox
#
# Locally the Docker provider starts sandboxd as root and pre-populates named volumes from the image. On Azure the
# image's own user is what runs, and each sandbox's /workspace, /home/agent, and /var/lib/managed-copilot are fresh
# data disks that hide the image's contents. So this layer runs the entrypoint as root, keeps a copy of those three
# trees, and seeds an empty disk from it before starting sandboxd. sandboxd still starts every workload process as uid
# 10001 with no_new_privs and no capabilities.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN test -f /opt/managed-copilot/sandboxd/dist/sandboxd/main.js \
 || { echo "BASE_IMAGE must be a Managed Copilot sandbox image (FROM ghcr.io/patniko/managed-copilot-sandbox)." >&2; exit 1; } \
 && mkdir -p /opt/managed-copilot/skeleton \
 && cp -a /workspace /opt/managed-copilot/skeleton/workspace \
 && cp -a /home/agent /opt/managed-copilot/skeleton/home \
 && cp -a /var/lib/managed-copilot /opt/managed-copilot/skeleton/state \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
COPY entrypoint.sh /opt/managed-copilot/azure/entrypoint.sh
RUN sed -i 's/\r$//' /opt/managed-copilot/azure/entrypoint.sh && chmod 0755 /opt/managed-copilot/azure/entrypoint.sh
LABEL managed-copilot.azure-layer="1"
WORKDIR /workspace
ENTRYPOINT ["/opt/managed-copilot/azure/entrypoint.sh"]
