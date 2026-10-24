#!/usr/bin/env node
// Usage: managed-copilot-lease -- <command...>
//
// Runs the command (the gateway, or an app that keeps state on the shared volume) only while this instance holds the
// single-writer lease on MANAGED_COPILOT_DATA_DIR (default /data). MANAGED_COPILOT_LEASE_STAMP identifies the deployment
// (set at publish time; newer stamps take over from older ones). PORT is the command's port, answered with 503 while
// this instance waits.
import { hostname } from "node:os";
import { Supervisor } from "./supervisor.js";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
if (command.length === 0) {
  process.stderr.write("Usage: managed-copilot-lease -- <gateway command...>\n");
  process.exit(64);
}

const env = process.env;
const port = Number(env.PORT ?? 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write(`PORT must be a TCP port (got "${env.PORT}")\n`);
  process.exit(64);
}
// In Container Apps the gateway's public address is <app>.<environment's default domain>, both known only at runtime.
if (env.MANAGED_COPILOT_MODE === "azure" && !env.MANAGED_COPILOT_PUBLIC_URL && env.CONTAINER_APP_NAME && env.CONTAINER_APP_ENV_DNS_SUFFIX) {
  env.MANAGED_COPILOT_PUBLIC_URL = `https://${env.CONTAINER_APP_NAME}.${env.CONTAINER_APP_ENV_DNS_SUFFIX}`;
}
const holder = [env.CONTAINER_APP_REVISION, env.CONTAINER_APP_REPLICA_NAME ?? env.HOSTNAME ?? hostname()].filter(Boolean).join("/");

const supervisor = new Supervisor({
  dataDir: env.MANAGED_COPILOT_DATA_DIR ?? "/data",
  identity: { holder, stamp: env.MANAGED_COPILOT_LEASE_STAMP ?? "0" },
  command,
  port,
  subject: env.MANAGED_COPILOT_MODE === "azure" ? "gateway" : "app",
  ...(env.HOST ? { host: env.HOST } : {}),
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void supervisor.stop(`received ${signal}`));
}

process.exit(await supervisor.run());
