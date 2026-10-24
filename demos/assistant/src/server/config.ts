import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The demo's root directory (`demos/assistant`), whether running from `src/server` (tsx) or `dist/server` (built). */
export const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface GoogleClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AssistantConfig {
  readonly port: number;
  /** Loopback interfaces to listen on. The server acts as you, so it never listens on a public interface by default. */
  readonly hosts: readonly string[];
  /** Base URL people and the platform use to reach this server (OAuth redirect and webhook URLs derive from it). */
  readonly publicUrl: string;
  readonly dataDir: string;
  /** Built web UI (`vite build` output). */
  readonly webDir: string;
  /** AppHost environment the conversation lives in; must declare `scheduling: true`. */
  readonly environment: string;
  /** AppHost webhook that answers tool calls while no client is attached. */
  readonly webhookName: string;
  readonly webhookSecret: string | undefined;
  /** Secret that seals OAuth tokens at rest. Generated into the data directory when unset (local development only). */
  readonly sealingKey: string | undefined;
  readonly google: GoogleClientConfig | undefined;
  readonly model: string;
  /** Detach the live session this long after the last browser tab closes, so scheduled work runs on the platform. */
  readonly detachAfterMs: number;
  /** While detached, poll for pending tool calls this often (a safety net for missed webhooks). */
  readonly pollIntervalMs: number;
  /** Extra origins allowed to call the API (the Vite dev server). */
  readonly devOrigins: readonly string[];
  /**
   * Extra host names this server answers to, besides loopback and `ASSISTANT_PUBLIC_URL`'s host (DNS-rebinding
   * protection), e.g. the in-environment name the platform delivers webhooks to in a cloud deployment.
   */
  readonly allowedHosts: readonly string[];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer (got "${value}")`);
  return parsed;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AssistantConfig {
  const port = positiveInt(env.PORT ?? env.ASSISTANT_PORT, 7490, "PORT");
  const publicUrl = (nonEmpty(env.ASSISTANT_PUBLIC_URL) ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const clientId = nonEmpty(env.GOOGLE_CLIENT_ID);
  const clientSecret = nonEmpty(env.GOOGLE_CLIENT_SECRET);
  const webPort = positiveInt(env.ASSISTANT_WEB_PORT, 7491, "ASSISTANT_WEB_PORT");
  return {
    port,
    hosts: (nonEmpty(env.ASSISTANT_HOSTS) ?? "127.0.0.1,::1").split(",").map((host) => host.trim()).filter(Boolean),
    publicUrl,
    dataDir: resolve(nonEmpty(env.ASSISTANT_DATA_DIR) ?? resolve(DEMO_ROOT, ".data")),
    webDir: resolve(nonEmpty(env.ASSISTANT_WEB_DIR) ?? resolve(DEMO_ROOT, "dist", "web")),
    environment: nonEmpty(env.ASSISTANT_ENVIRONMENT) ?? "assistant",
    webhookName: nonEmpty(env.ASSISTANT_WEBHOOK) ?? "assistant",
    webhookSecret: nonEmpty(env.ASSISTANT_WEBHOOK_SECRET),
    sealingKey: nonEmpty(env.ASSISTANT_SEALING_KEY),
    google: clientId && clientSecret ? { clientId, clientSecret } : undefined,
    model: nonEmpty(env.ASSISTANT_MODEL) ?? "claude-sonnet-5",
    detachAfterMs: positiveInt(env.ASSISTANT_DETACH_AFTER_MS, 30_000, "ASSISTANT_DETACH_AFTER_MS"),
    pollIntervalMs: positiveInt(env.ASSISTANT_POLL_INTERVAL_MS, 60_000, "ASSISTANT_POLL_INTERVAL_MS"),
    devOrigins: [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`],
    allowedHosts: (env.ASSISTANT_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}
