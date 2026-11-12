import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_NAME } from "./services.js";

/** A service that publishes its folder over HTTP (`INCIDENT_SERVICE_URLS`). */
export interface RemoteService {
  /** The service's name, as alerts name it. */
  readonly name: string;
  /** `GET` answers `{ name, version, files: [{ path, content }] }`: its code, tests, logs, and deploy history. */
  readonly url: string;
}

/** A setting Incident Commander can't start with. The message says what to fix, in plain words. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface DeployTarget {
  /** Your deploy pipeline's webhook: approved fixes for your own services are POSTed here. */
  readonly url: string;
  /** Signs each request (`x-incident-commander-signature`), like the platform signs its webhooks. */
  readonly secret?: string;
}

export interface FactoryTarget {
  /** Where this server calls Software Factory's API (`SOFTWARE_FACTORY_URL`). */
  readonly url: string;
  /** Its address for people, for links to work orders (`SOFTWARE_FACTORY_PUBLIC_URL`; defaults to `url`). */
  readonly publicUrl: string;
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
  /** Services that publish their folder over HTTP (`INCIDENT_SERVICE_URLS`). */
  readonly remoteServices?: readonly RemoteService[];
  readonly deploy?: DeployTarget;
  /** Software Factory, when it's connected: incidents can route their fix to it as a work order. */
  readonly factory?: FactoryTarget;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
  /** How often a working incident's sandboxes are read. */
  readonly pollIntervalMs: number;
  /** How often an active work order is read from Software Factory. */
  readonly factoryPollMs: number;
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

const SERVICE_URLS_EXAMPLE = "downhill-shop=http://localhost:7455/api/incident/service";

/**
 * `INCIDENT_SERVICE_URLS`: comma-separated `name=url` pairs. Throws `ConfigError` for anything else. Messages never
 * repeat a URL: one that doesn't parse may hold a secret.
 */
export function parseServiceUrls(value: string | undefined): RemoteService[] {
  const services: RemoteService[] = [];
  const entries = (value ?? "").split(",").map((entry) => entry.trim());
  for (const [index, entry] of entries.entries()) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    const raw = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!name || !raw) {
      throw new ConfigError(`INCIDENT_SERVICE_URLS: entry ${index + 1} isn't name=url. List each service as name=url, separated by commas, for example ${SERVICE_URLS_EXAMPLE}.`);
    }
    if (!SERVICE_NAME.test(name)) {
      // Only a name that can't be part of a URL is repeated: a misplaced URL may carry a secret.
      const shown = /^[\w .-]{1,80}$/.test(name) ? `"${name}"` : `The name of entry ${index + 1}`;
      throw new ConfigError(
        `INCIDENT_SERVICE_URLS: ${shown} isn't a service name. Use up to 60 lowercase letters, digits, dots, dashes, and underscores, starting with a letter or a digit.`,
      );
    }
    let url: URL | undefined;
    try {
      url = new URL(raw);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new ConfigError(`INCIDENT_SERVICE_URLS: the URL for ${name} isn't an http:// or https:// URL.`);
    }
    if (url.username || url.password) {
      throw new ConfigError(`INCIDENT_SERVICE_URLS: the URL for ${name} has a user name or password in it. Remove them: Incident Commander calls the URL without credentials.`);
    }
    if (services.some((service) => service.name === name)) throw new ConfigError(`INCIDENT_SERVICE_URLS: ${name} is listed twice.`);
    services.push({ name, url: url.toString() });
  }
  return services;
}

/** The app's settings, from its environment. Throws `ConfigError` for a setting it can't start with. */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const port = Number(env.PORT ?? env.INCIDENT_PORT ?? 7445);
  const deployUrl = nonEmpty(env.INCIDENT_DEPLOY_URL);
  const deploySecret = nonEmpty(env.INCIDENT_DEPLOY_SECRET);
  const alertSecret = nonEmpty(env.INCIDENT_ALERT_SECRET);
  const webhookSecret = nonEmpty(env.INCIDENT_WEBHOOK_SECRET);
  const servicesDir = nonEmpty(env.INCIDENT_SERVICES_DIR);
  const remoteServices = parseServiceUrls(env.INCIDENT_SERVICE_URLS);
  const factoryUrl = nonEmpty(env.SOFTWARE_FACTORY_URL)?.replace(/\/+$/, "");
  const factoryPublicUrl = nonEmpty(env.SOFTWARE_FACTORY_PUBLIC_URL)?.replace(/\/+$/, "") || factoryUrl;
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
    ...(remoteServices.length ? { remoteServices } : {}),
    ...(deployUrl ? { deploy: { url: deployUrl, ...(deploySecret ? { secret: deploySecret } : {}) } } : {}),
    ...(factoryUrl ? { factory: { url: factoryUrl, publicUrl: factoryPublicUrl ?? factoryUrl } } : {}),
    healthIntervalMs: 15_000,
    pollIntervalMs: 4_000,
    factoryPollMs: 5_000,
  };
}
