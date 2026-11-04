#!/bin/sh
# Entrypoint for Managed Copilot sandboxes on Azure Container Apps Sandboxes. Runs as root.
#
# Each persistent directory is a data disk. A new disk is empty apart from ext4's lost+found, so it is seeded from the
# copy of the image's tree kept in /opt/managed-copilot/skeleton. A disk that already holds data (a resumed or
# recreated sandbox) is never touched beyond its top-level ownership and mode.
set -eu

seed() {
  target="$1"
  skeleton="$2"
  owner="$3"
  mode="$4"
  mkdir -p "$target"
  # ext4 creates lost+found on a fresh disk; it is not workload data, so drop it while it is empty.
  rmdir "$target/lost+found" 2>/dev/null || true
  if [ -z "$(ls -A "$target")" ]; then
    cp -a "$skeleton/." "$target/"
    echo "managed-copilot: seeded $target"
  fi
  chown "$owner" "$target"
  chmod "$mode" "$target"
}

seed /workspace /opt/managed-copilot/skeleton/workspace 10001:10001 0755
seed /home/agent /opt/managed-copilot/skeleton/home 10001:10001 0755
seed /var/lib/managed-copilot /opt/managed-copilot/skeleton/state 0:0 0755

exec /usr/bin/tini -- node /opt/managed-copilot/sandboxd/dist/sandboxd/main.js
