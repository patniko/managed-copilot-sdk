import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeployTarget {
  /** Your deploy pipeline's webhook: approved fixes for your own services are POSTed here. */
  readonly url: string;
  /** Signs each request (`x-incident-commander-signature`), like the platform signs its webhooks. */
  readonly secret?: string;
}

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  /** Incident Commander's own records. Sessions and sandboxes live in the platform. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** The orchestrator environment incidents run in. */
  readonly environment: string;
  /** The coordinator's model. */
  readonly model: string;
  /** This app's public address, for the alert URL monitoring tools post to. */
  readonly publicUrl: string;
  /** Bearer secret `/api/alerts` requires. Without it, only the labeled demo can open incidents. */
  readonly alertSecret?: string;
  /** The platform webhook's signing secret. */
  readonly webhookSecret?: string;
  /** The bundled demo service (with generated logs) lives here. */
  readonly demoServicesDir: string;
  /** Your own services' folders (code, tests, exported logs), one per service name. */
  readonly servicesDir?: string;
  readonly deploy?: DeployTarget;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
  /** How often a working incident's sandboxes are read. */
  readonly pollIntervalMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Incident Commander package directory");
}

const nonEmpty = (value: string | undefined): string | undefined => (value && value.trim() ? value.trim() : undefined);

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const port = Number(env.PORT ?? env.INCIDENT_PORT ?? 7445);
  const deployUrl = nonEmpty(env.INCIDENT_DEPLOY_URL);
  const deploySecret = nonEmpty(env.INCIDENT_DEPLOY_SECRET);
  const alertSecret = nonEmpty(env.INCIDENT_ALERT_SECRET);
  const webhookSecret = nonEmpty(env.INCIDENT_WEBHOOK_SECRET);
  const servicesDir = nonEmpty(env.INCIDENT_SERVICES_DIR);
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.INCIDENT_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.INCIDENT_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    environment: nonEmpty(env.INCIDENT_ENVIRONMENT) ?? "incident-commander",
    model: nonEmpty(env.INCIDENT_MODEL) ?? "claude-sonnet-5",
    publicUrl: (nonEmpty(env.INCIDENT_PUBLIC_URL) ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    ...(alertSecret ? { alertSecret } : {}),
    ...(webhookSecret ? { webhookSecret } : {}),
    demoServicesDir: join(packageRoot, "demo-services"),
    ...(servicesDir ? { servicesDir: resolve(servicesDir) } : {}),
    ...(deployUrl ? { deploy: { url: deployUrl, ...(deploySecret ? { secret: deploySecret } : {}) } } : {}),
    healthIntervalMs: 15_000,
    pollIntervalMs: 4_000,
  };
}
