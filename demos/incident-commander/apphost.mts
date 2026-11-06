/**
 * AppHost fragment for Incident Commander (plain data; no Aspire imports): a mixed orchestrator that triages in its own
 * sandbox and hands the repro and the fix to workers, the environments those sandboxes come from, and the webhook that
 * tells the app what happens while it isn't attached to an incident.
 *
 * | Environment                 | Type                 | Size   | Network           | What it's for                                      |
 * | --------------------------- | -------------------- | ------ | ----------------- | -------------------------------------------------- |
 * | `incident-commander`        | orchestrator (mixed) | n/a    | off               | the on-call agent: triage itself, workers for the rest |
 * | `incident-commander-triage` | isolated             | small  | off               | its own sandbox: the service's code, logs, and deploys |
 * | `incident-commander-node`   | isolated             | medium | npm registry only | workers: a failing test, a fix, the test suite     |
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { incidentCommander } from "./demos/incident-commander/apphost.mts";
 *
 * const demo = incidentCommander({ webhookSecret: await generatedSecret("incident-commander-webhook-secret") });
 * await addManagedCopilot(builder, "copilot", { environments: { ...demo.environments }, webhooks: { ...demo.webhooks } });
 * // Run `node <demo.app.script>` in demo.app.workingDirectory (after `pnpm build`) with PORT, MANAGED_COPILOT_URL,
 * // INCIDENT_WEBHOOK_SECRET (the webhook's secret), and INCIDENT_ALERT_SECRET (the bearer token alerts must carry).
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The orchestrator environment every incident's coordinator session runs in. */
export const INCIDENT_ENVIRONMENT = "incident-commander";

/** Its sandboxes: the first is the coordinator's own (mixed execution), the second its workers'. */
export const INCIDENT_SANDBOXES = {
  triage: "incident-commander-triage",
  node: "incident-commander-node",
} as const;

/** Webhook the platform calls with the coordinator's events while the app isn't attached (spec section 12). */
export const INCIDENT_WEBHOOK = "incident-commander";

/** Events the server handles on its webhook. */
export const INCIDENT_WEBHOOK_EVENTS = [
  "session.action_required",
  "session.idle",
  "session.failed",
  "worker.started",
  "worker.idle",
  "worker.failed",
  "worker.stopped",
] as const;

export const INCIDENT_DEFAULT_PORT = 7445;

export interface IncidentCommanderOptions<Secret> {
  /** The webhook's signing secret: an Aspire secret parameter. The server receives the same value as `INCIDENT_WEBHOOK_SECRET`. */
  readonly webhookSecret: Secret;
  /** Port for the UI, the API, and the webhooks. Defaults to 7445. */
  readonly port?: number;
  /**
   * npm registry the Node workers may install packages from. Defaults to `INCIDENT_NPM_REGISTRY`, then the host's
   * `npm config get registry`. Only its host is used: it is the Node sandboxes' only network destination.
   */
  readonly npmRegistry?: string;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

function detectNpmRegistry(): string | undefined {
  const fromEnv = process.env.INCIDENT_NPM_REGISTRY ?? process.env.npm_config_registry;
  if (fromEnv) return fromEnv;
  try {
    const value = execSync("npm config get registry", { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function registryHost(registry: string | undefined): string | undefined {
  if (!registry) return undefined;
  try {
    return new URL(registry).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Incident Commander's environments, its webhook, and its app resource. */
export function incidentCommander<Secret>(options: IncidentCommanderOptions<Secret>) {
  const port = options.port ?? INCIDENT_DEFAULT_PORT;
  const npmHost = registryHost(options.npmRegistry ?? detectNpmRegistry()) ?? "registry.npmjs.org";
  // Keeps tool output plain for the incident page.
  const sandboxEnv = { CI: "1", NO_COLOR: "1" };
  const environments: Record<string, EnvironmentConfig> = {
    [INCIDENT_ENVIRONMENT]: {
      type: "orchestrator",
      description: "Incident Commander: an on-call agent that triages in its own sandbox and hands the repro and the fix to workers",
      execution: "mixed",
      workers: [INCIDENT_SANDBOXES.triage, INCIDENT_SANDBOXES.node],
      // Its own sandbox, the repro and fix workers, and room for one replacement.
      maxWorkers: 4,
      // Alerts are data from monitoring systems; the coordinator itself never needs the Internet.
      network: false,
    },
    [INCIDENT_SANDBOXES.triage]: {
      type: "isolated",
      size: "small",
      network: false,
      env: sandboxEnv,
      description: "Triage box: the service's code, logs, and deploy history, with grep, ripgrep, Node.js, and Python. No network.",
    },
    [INCIDENT_SANDBOXES.node]: {
      type: "isolated",
      size: "medium",
      network: [npmHost],
      env: sandboxEnv,
      description: "Node.js lab: Node 24 and npm for reproducing a bug with a failing test, fixing it, and running the test suite. The npm registry only.",
    },
  };
  return {
    environments,
    webhooks: {
      [INCIDENT_WEBHOOK]: {
        url: `http://localhost:${port}/api/copilot-events`,
        environments: [INCIDENT_ENVIRONMENT],
        events: [...INCIDENT_WEBHOOK_EVENTS],
        secret: options.webhookSecret,
      },
    },
    app: {
      name: "incident-commander",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port,
      healthPath: "/api/health",
    },
  };
}
