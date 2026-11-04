/**
 * Dev-only fixture server: replaces `fetch` for `/v1/operator/*` with in-memory sample data, including a simulated
 * server-sent event stream, so the real API client, polling, streaming, and views run unchanged. Loaded only from
 * `vite dev` with `?fixtures[=variant]`; production builds never include it.
 *
 * Variants: `default`, `empty`, `signed-out`, `forbidden`, `github-down`, `flaky`, `expire` (401 after a few
 * requests), `revoked` (403 after a few requests).
 */
import { CONSOLE_REQUEST_HEADER, OPERATOR_ROUTES, type OperatorActionResult, type OperatorAuditAction, type OperatorIdentity } from "@managed-copilot/protocol/operator";
import { setSampleData } from "../lib/sample.js";
import {
  ACCOUNT_ROWS,
  ACCOUNTS,
  ACTIONS,
  AUDIT,
  CONNECTIONS,
  customizationFile,
  ENVIRONMENTS,
  EVENTS,
  INFRASTRUCTURE,
  LOGS,
  makeEvent,
  makeLog,
  overview,
  SANDBOXES,
  scheduleRuns,
  SCHEDULES,
  sessionDetail,
  SESSIONS,
  WEBHOOKS,
} from "./fixtures.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function failure(status: number, code: string, message: string, extra: { readonly details?: Record<string, unknown>; readonly headers?: Record<string, string> } = {}): Response {
  return json({ error: { code, message, ...(extra.details ? { details: extra.details } : {}) } }, status, extra.headers);
}

const IDENTITY: OperatorIdentity = { account: ACCOUNTS.octocat, grant: "configured", via: "console", sessionExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString() };

class FixtureServer {
  #signedIn: boolean;
  #requests = 0;
  #githubFailures = 0;
  #auditId = 100;
  #eventIndex = 1000;
  #logSeq = LOGS.length + 1;

  constructor(private readonly variant: string) {
    this.#signedIn = variant !== "signed-out";
  }

  async handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (headers.get(CONSOLE_REQUEST_HEADER) !== "1") return failure(403, "forbidden", "Console requests must carry the console header.");
    const path = url.pathname;

    if (path === OPERATOR_ROUTES.consoleSession && method === "POST") {
      await delay(500);
      const body = JSON.parse(String(init?.body ?? "{}")) as { ticket?: string };
      if (!body.ticket || body.ticket === "expired") return failure(401, "authentication_required", "This sign-in ticket has expired or was already used.");
      this.#signedIn = true;
      return json(IDENTITY);
    }
    if (path === OPERATOR_ROUTES.consoleSession && method === "DELETE") {
      this.#signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (path === OPERATOR_ROUTES.me) {
      await delay(250);
      if (!this.#signedIn) return failure(401, "authentication_required", "Sign in with a console link from `npx managed-copilot console`.");
      if (this.variant === "forbidden") {
        return failure(403, "forbidden", "Only @octocat and members of the contoso-platform organization may operate this deployment.", { details: { login: "monalisa" } });
      }
      if (this.variant === "github-down" && this.#githubFailures < 2) {
        this.#githubFailures += 1;
        return failure(503, "upstream_unavailable", "GitHub didn't answer the operator check in time.", { headers: { "retry-after": "6" } });
      }
      return json(IDENTITY);
    }
    if (!this.#signedIn) return failure(401, "authentication_required", "Your console session expired.");
    if (this.variant === "expire" && this.#requests >= 8) {
      this.#signedIn = false;
      return failure(401, "authentication_required", "Your console session ended. Run `npx managed-copilot console` to sign in again.");
    }
    if (this.variant === "revoked" && this.#requests >= 8) {
      return failure(403, "forbidden", "Your console session ended: @octocat is no longer an operator of this deployment. Run `npx managed-copilot console` to sign in again.");
    }
    if (path === OPERATOR_ROUTES.stream) return this.#stream(init?.signal ?? undefined);

    await delay(120 + Math.random() * 280);
    this.#requests += 1;
    if (this.variant === "flaky" && method === "GET" && this.#requests % 4 === 0) return failure(500, "internal", "The gateway hit an unexpected error. Its logs have the details.");
    if (method === "POST") return this.#action(path);
    return this.#get(url);
  }

  #get(url: URL): Response {
    const path = url.pathname;
    const params = url.searchParams;
    const empty = this.variant === "empty";
    const limit = Number(params.get("limit") ?? "100");
    if (path === OPERATOR_ROUTES.overview) return json(overview(empty));
    if (path === OPERATOR_ROUTES.infrastructure) return json({ ...INFRASTRUCTURE, generatedAt: new Date().toISOString() });
    if (path === OPERATOR_ROUTES.environments) return json(empty ? { ...ENVIRONMENTS, environments: [], inline: undefined } : ENVIRONMENTS);
    const fileMatch = /^\/v1\/operator\/environments\/([^/]+)\/file$/.exec(path);
    if (fileMatch) {
      const file = customizationFile(decodeURIComponent(fileMatch[1] ?? ""), params.get("path") ?? "");
      return file ? json(file) : failure(404, "not_found", "No such file in this environment's customizations.");
    }
    const envMatch = /^\/v1\/operator\/environments\/([^/]+)$/.exec(path);
    if (envMatch) {
      const environment = ENVIRONMENTS.environments.find((candidate) => candidate.name === decodeURIComponent(envMatch[1] ?? ""));
      return environment ? json(environment) : failure(404, "environment_not_found", "No such environment.");
    }
    if (path === OPERATOR_ROUTES.sessions) {
      if (empty) return json([]);
      const owner = params.get("owner")?.toLowerCase();
      const rows = SESSIONS.filter(
        (session) =>
          (!owner || session.owner.login.toLowerCase() === owner || String(session.owner.id) === owner) &&
          (!params.get("environment") || session.environment === params.get("environment")) &&
          (!params.get("state") || session.state === params.get("state")) &&
          (!params.get("placement") || session.placement === params.get("placement")) &&
          (!params.get("q") || session.id.startsWith(params.get("q") ?? "")),
      );
      return json(rows.slice(0, limit));
    }
    const sessionMatch = /^\/v1\/operator\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch) {
      const detail = sessionDetail(decodeURIComponent(sessionMatch[1] ?? ""));
      return detail ? json(detail) : failure(404, "not_found", "No such session.");
    }
    if (path === OPERATOR_ROUTES.connections) return json(empty ? { connections: [], upstreams: [], generatedAt: new Date().toISOString() } : CONNECTIONS);
    if (path === OPERATOR_ROUTES.sandboxes) return json(empty ? [] : SANDBOXES.filter((sandbox) => !params.get("state") || sandbox.state === params.get("state")));
    if (path === OPERATOR_ROUTES.schedules) return json(empty ? [] : SCHEDULES);
    const runsMatch = /^\/v1\/operator\/schedules\/([^/]+)\/runs$/.exec(path);
    if (runsMatch) {
      const schedule = SCHEDULES.find((candidate) => candidate.id === decodeURIComponent(runsMatch[1] ?? ""));
      return schedule ? json({ schedule, runs: scheduleRuns(schedule.id) }) : failure(404, "not_found", "No such schedule.");
    }
    if (path === OPERATOR_ROUTES.webhooks) {
      if (empty) return json({ subscriptions: [], deliveries: [], counts: {} });
      return json({ ...WEBHOOKS, deliveries: WEBHOOKS.deliveries.filter((delivery) => !params.get("state") || delivery.state === params.get("state")) });
    }
    if (path === OPERATOR_ROUTES.actions) {
      if (empty) return json([]);
      const state = params.get("state") || "open";
      const open = new Set(["pending", "claimed", "executing", "needs_reconciliation"]);
      return json(ACTIONS.filter((action) => state === "all" || (state === "open" ? open.has(action.state) : state === "attention" ? action.state === "needs_reconciliation" : action.state === state)));
    }
    if (path === OPERATOR_ROUTES.accounts) return json(empty ? [ACCOUNT_ROWS[0]] : ACCOUNT_ROWS);
    if (path === OPERATOR_ROUTES.events) return json(empty ? [] : EVENTS.filter((event) => !params.get("type") || event.type === params.get("type")).slice(-limit));
    if (path === OPERATOR_ROUTES.logs) {
      const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
      const minimum = rank[(params.get("level") ?? "debug") as keyof typeof rank] ?? 0;
      return json(LOGS.filter((entry) => rank[entry.level] >= minimum).slice(-limit));
    }
    if (path === OPERATOR_ROUTES.audit) return json(AUDIT);
    return failure(404, "not_found", `No fixture for ${path}.`);
  }

  #result(action: OperatorAuditAction, message: string, target?: string): Response {
    const audit = { id: this.#auditId++, at: new Date().toISOString(), actor: ACCOUNTS.octocat, action, target, outcome: "succeeded" as const };
    AUDIT.unshift(audit);
    return json({ ok: true, message, audit } satisfies OperatorActionResult);
  }

  #action(path: string): Response {
    if (this.variant === "flaky" && Math.random() < 0.5) return failure(409, "conflict", "Another operator action on this resource is in progress. Try again in a moment.");
    if (path === OPERATOR_ROUTES.sandboxesProbe) return this.#result("sandboxes.probe", "Docker 27.3.1 is available (checked just now).");
    const stop = /^\/v1\/operator\/sandboxes\/([^/]+)\/stop$/.exec(path);
    if (stop) {
      const sessionId = decodeURIComponent(stop[1] ?? "");
      const index = SANDBOXES.findIndex((sandbox) => sandbox.sessionId === sessionId);
      const sandbox = SANDBOXES[index];
      if (!sandbox) return failure(404, "not_found", "That session has no sandbox.");
      if (sandbox.state !== "running") return failure(409, "conflict", "The sandbox isn't running.");
      SANDBOXES[index] = { ...sandbox, state: "stopping", activity: undefined };
      setTimeout(() => {
        const current = SANDBOXES[index];
        if (current) SANDBOXES[index] = { ...current, state: "stopped", stoppedAt: new Date().toISOString() };
      }, 4000);
      return this.#result("sandbox.stop", `Sandbox ${sandbox.id.slice(0, 12)} stops after its current work drains.`, sessionId);
    }
    const pause = /^\/v1\/operator\/schedules\/([^/]+)\/(pause|resume)$/.exec(path);
    if (pause) {
      const scheduleId = decodeURIComponent(pause[1] ?? "");
      const index = SCHEDULES.findIndex((schedule) => schedule.id === scheduleId);
      const schedule = SCHEDULES[index];
      if (!schedule) return failure(404, "not_found", "No such schedule.");
      const pausing = pause[2] === "pause";
      SCHEDULES[index] = { ...schedule, state: pausing ? "paused" : "active", pausedReason: pausing ? "Paused by an operator (@octocat)." : undefined };
      return this.#result(pausing ? "schedule.pause" : "schedule.resume", pausing ? `“${schedule.name}” is paused.` : `“${schedule.name}” is active again.`, scheduleId);
    }
    const retry = /^\/v1\/operator\/webhooks\/deliveries\/([^/]+)\/retry$/.exec(path);
    if (retry) {
      const deliveryId = decodeURIComponent(retry[1] ?? "");
      const deliveries = WEBHOOKS.deliveries as (typeof WEBHOOKS.deliveries)[number][];
      const index = deliveries.findIndex((delivery) => delivery.id === deliveryId);
      const delivery = deliveries[index];
      if (!delivery) return failure(404, "not_found", "No such delivery.");
      deliveries[index] = { ...delivery, state: "pending", nextAttemptAt: new Date(Date.now() + 5000).toISOString() };
      return this.#result("webhook.retry", `Delivery ${deliveryId.slice(0, 12)} is queued for another attempt.`, deliveryId);
    }
    return failure(404, "not_found", `No fixture for POST ${path}.`);
  }

  #stream(signal: AbortSignal | undefined): Response {
    const encoder = new TextEncoder();
    const timers: ReturnType<typeof setInterval>[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const send = (text: string): void => {
          if (closed) return;
          // Split writes at a random point to exercise the client's chunk-boundary handling.
          const cut = Math.floor(Math.random() * text.length);
          controller.enqueue(encoder.encode(text.slice(0, cut)));
          controller.enqueue(encoder.encode(text.slice(cut)));
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          for (const timer of timers) clearInterval(timer);
          try {
            controller.close();
          } catch {
            // Already errored by the abort.
          }
        };
        signal?.addEventListener("abort", () => {
          for (const timer of timers) clearInterval(timer);
          closed = true;
          try {
            controller.error(new DOMException("The stream was aborted.", "AbortError"));
          } catch {
            // Already closed.
          }
        });
        send(": connected\r\n\r\n");
        timers.push(setInterval(() => send(": ping\n\n"), 15_000));
        timers.push(
          setInterval(() => {
            const event = makeEvent(this.#eventIndex++, new Date().toISOString());
            send(`event: platform\r\nid: ${event.id}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
          }, 2600),
        );
        timers.push(
          setInterval(() => {
            const entry = makeLog(this.#logSeq++, new Date().toISOString());
            send(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
          }, 700),
        );
        if (this.variant === "flaky") timers.push(setInterval(close, 20_000));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
}

export function installFixtures(variant: string): void {
  const server = new FixtureServer(variant);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/v1/operator/")) return realFetch(input, init);
    if (init?.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    return server.handle(url, init);
  };
  setSampleData(true);
  console.info(`[console] Sample data (${variant}) from src/dev/fixtures.ts. Remove ?fixtures or add ?fixtures=off to use the gateway.`);
}
