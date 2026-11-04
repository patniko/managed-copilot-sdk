/**
 * AppHost fragment for the long-running assistant demo (a data descriptor; no Aspire imports).
 *
 * The root `apphost.mts` merges `assistantCopilotOptions(...)` into its
 * `addManagedCopilot(builder, "copilot", ...)` call and starts the server described by `ASSISTANT_DEMO`. The root AppHost
 * owns the parameters: `assistant-webhook-secret` → `ASSISTANT_WEBHOOK_SECRET`, `assistant-sealing-key` →
 * `ASSISTANT_SEALING_KEY`, and the optional `google-client-id` / `google-client-secret` → `GOOGLE_CLIENT_ID` /
 * `GOOGLE_CLIENT_SECRET` (unset or empty means demo data only). It also injects `PORT` and `MANAGED_COPILOT_URL`.
 *
 * Erasable TypeScript only, so it runs under Node's type stripping.
 */
import { fileURLToPath } from "node:url";

/** Environment the assistant's conversation lives in: an orchestrator that can start sandboxes (spec section 17). */
export const ASSISTANT_ENVIRONMENT = "assistant";
/** Sandboxes the assistant can start, each a worker session in its own sandbox. The first is the default. */
export const ASSISTANT_SANDBOXES = {
  /** Calculations, data analysis, and charts from data the assistant passes in the task. No network. */
  python: "assistant-python",
  /** Research on the web, limited to the hosts below. */
  web: "assistant-web",
} as const;
/** Hosts the web research sandbox can reach. Anything else is blocked. */
export const ASSISTANT_WEB_HOSTS = ["github.com", "api.github.com"] as const;
/** Webhook that answers tool calls while no client is attached (spec section 12). */
export const ASSISTANT_WEBHOOK = "assistant";
/** Fixed and not proxied, so the Google OAuth redirect URI stays http://localhost:7490/api/google/callback. */
export const ASSISTANT_PORT = 7490;
export const ASSISTANT_URL = `http://localhost:${ASSISTANT_PORT}`;

/** Events the assistant server handles on its webhook. */
export const ASSISTANT_WEBHOOK_EVENTS = [
  "session.action_required",
  "session.idle",
  "session.failed",
  "schedule.run_started",
  "schedule.run_completed",
] as const;

/**
 * Environment and webhook declarations to merge into `addManagedCopilot(builder, "copilot", { ... })`.
 * `webhookSecret` is the `assistant-webhook-secret` parameter; the server receives the same value as
 * `ASSISTANT_WEBHOOK_SECRET`.
 */
export function assistantCopilotOptions<T>({ webhookSecret }: { webhookSecret: T }) {
  return {
    environments: {
      [ASSISTANT_ENVIRONMENT]: {
        // A coordinator on the shared runtime: it chats and uses the app's tools itself, and starts a sandbox (a worker
        // in its own isolated environment) only for hands-on work. Starting one always asks the person first.
        type: "orchestrator" as const,
        description: "Long-running personal assistant: reminders, recurring briefings, Gmail, Google Calendar, and sandboxes for hands-on work",
        // Operator approval for the agent scheduling tools (schedule_task, list_schedules, cancel_schedule).
        scheduling: true,
        // The agent itself needs no Internet access: the Gmail and Calendar tools run in the assistant server.
        network: false,
        workers: [ASSISTANT_SANDBOXES.python, ASSISTANT_SANDBOXES.web],
        // Sandboxes one conversation can have at once; idle ones count until the assistant stops them.
        maxWorkers: 3,
      },
      [ASSISTANT_SANDBOXES.python]: {
        type: "isolated" as const,
        description: "Python sandbox: calculations, data analysis, and SVG charts from data passed in its task. Python standard library only, no network.",
        size: "medium" as const,
        network: false,
      },
      [ASSISTANT_SANDBOXES.web]: {
        type: "isolated" as const,
        description: `Web research sandbox: reads public pages and APIs on ${ASSISTANT_WEB_HOSTS.join(" and ")} only.`,
        size: "small" as const,
        network: [...ASSISTANT_WEB_HOSTS],
      },
    },
    webhooks: {
      [ASSISTANT_WEBHOOK]: {
        url: `${ASSISTANT_URL}/api/copilot-events`,
        environments: [ASSISTANT_ENVIRONMENT],
        events: [...ASSISTANT_WEBHOOK_EVENTS],
        secret: webhookSecret,
      },
    },
  };
}

/** The assistant server: `node <workingDirectory>/<script>` after `pnpm build`. */
export const ASSISTANT_DEMO = {
  name: "assistant",
  workingDirectory: fileURLToPath(new URL(".", import.meta.url)),
  script: "dist/server/main.js",
  port: ASSISTANT_PORT,
  healthPath: "/healthz",
  env: {
    ASSISTANT_PUBLIC_URL: ASSISTANT_URL,
    ASSISTANT_ENVIRONMENT,
    ASSISTANT_WEBHOOK,
  },
} as const;
