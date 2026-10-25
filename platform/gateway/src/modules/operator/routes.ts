// The operator API (spec section 16): `/v1/operator/*`. Every route authenticates an operator, with a GitHub bearer
// token (CLI, scripts) or the console's session cookie plus its request header. Guarded actions are audited, and
// none of them deletes anything.
import {
  CONSOLE_PATH,
  isManagedCopilotError,
  ManagedCopilotError,
  OPERATOR_ROUTES,
  type AccountInfo,
  type ConsoleTicket,
  type OperatorActionResult,
  type OperatorAuditAction,
  type OperatorGrant,
  type OperatorIdentity,
  type OperatorLogLevel,
  type Placement,
  type SandboxState,
  type SessionState,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { bearerToken, toManagedError, type RequestContext } from "../../http.js";
import type { Principal } from "../../http.js";
import { logRing, type Logger } from "../../log.js";
import { redactLogRecord } from "../../redaction.js";
import { accountInfo } from "../core/auth.js";
import { CONSOLE_SESSION_MS, type ConsoleSession, type OperatorAccess, type OperatorAuthPort } from "./access.js";
import type { OperatorAudit } from "./audit.js";
import { operatorPorts } from "./contract.js";
import type { OperatorViews } from "./views.js";

interface Operator {
  readonly principal: Principal;
  readonly account: AccountInfo;
  readonly grant: OperatorGrant;
  readonly via: "token" | "console";
  readonly session?: ConsoleSession;
}

const SESSION_STATES: readonly Exclude<SessionState, "deleted">[] = ["creating", "ready", "running", "waiting", "idle", "stopped", "promoting", "deleting", "failed"];
const PLACEMENTS: readonly Placement[] = ["shared", "sandbox"];
const SANDBOX_STATES: readonly SandboxState[] = ["provisioning", "setting_up", "running", "stopping", "stopped", "deleting", "deleted", "failed"];
const ACTION_FILTERS = ["open", "attention", "all", "pending", "claimed", "executing", "completed", "failed", "needs_reconciliation", "expired", "cancelled"] as const;
const DELIVERY_STATES = ["pending", "delivering", "delivered", "failed"] as const;
const LOG_LEVELS: readonly OperatorLogLevel[] = ["debug", "info", "warn", "error"];
/** A stream client that stops reading is dropped (it reconnects) instead of buffering without bound. */
const STREAM_BUFFER_LIMIT = 1_000_000;

function oneOf<T extends string>(ctx: RequestContext, name: string, allowed: readonly T[]): T | undefined {
  const value = ctx.query.get(name);
  if (value === null || value === "") return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new ManagedCopilotError("invalid_request", `${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function limit(ctx: RequestContext, fallback: number, max = 1000): number {
  const value = ctx.query.get("limit");
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ManagedCopilotError("invalid_request", "limit must be a positive integer");
  return Math.min(parsed, max);
}

export function registerOperatorRoutes(app: GatewayApp, options: { readonly access: OperatorAccess; readonly audit: OperatorAudit; readonly views: OperatorViews; readonly log: Logger }): void {
  const { access, audit, views } = options;
  const auth = () => app.service("auth") as unknown as OperatorAuthPort;
  const core = () => app.service("coreOperator");
  const ports = () => operatorPorts(app.services);

  /** The operator behind a request: a GitHub bearer token, or a console session (re-verified every time). */
  const authenticate = async (ctx: RequestContext): Promise<Operator> => {
    const token = bearerToken(ctx.req);
    if (token) {
      const principal = await auth().authenticate(token);
      const grant = await access.authorize(principal);
      return { principal, account: accountInfo(principal), grant, via: "token" };
    }
    const cookie = access.cookieFrom(ctx.req);
    const session = access.session(cookie);
    if (!session) {
      throw new ManagedCopilotError(
        "authentication_required",
        cookie ? "Your console session ended. Run `npx managed-copilot console` to sign in again." : "Sign in with `npx managed-copilot console`, or send a GitHub token (Authorization: Bearer).",
        { reason: cookie ? "session_ended" : "signed_out" },
      );
    }
    access.assertConsoleRequest(ctx.req);
    try {
      const principal = await auth().authenticate(session.principal.token);
      if (principal.accountId !== session.principal.accountId) throw new ManagedCopilotError("authentication_required", "its credential now belongs to another GitHub account.");
      const grant = await access.authorize(principal);
      access.touch(session);
      return { principal, account: accountInfo(principal), grant, via: "console", session };
    } catch (error) {
      if (isManagedCopilotError(error, "authentication_required") || isManagedCopilotError(error, "forbidden")) {
        access.endSession(cookie);
        if (!ctx.res.headersSent) ctx.res.setHeader("set-cookie", access.clearCookie());
        throw new ManagedCopilotError(error.code, `Your console session ended: ${error.message} Run \`npx managed-copilot console\` to sign in again.`, {
          ...error.details,
          ...(error.code === "authentication_required" ? { reason: "credential_rejected" } : {}),
        });
      }
      throw error;
    }
  };

  const route = (method: "GET" | "POST", path: string, handler: (ctx: RequestContext, operator: Operator) => unknown) => {
    app.routes.add(
      method,
      path,
      async (ctx) => {
        ctx.res.setHeader("cache-control", "no-store");
        const operator = await authenticate(ctx);
        return handler(ctx, operator);
      },
      { auth: "none" },
    );
  };

  /** Runs a guarded action and records it (succeeded or failed) in the audit log. */
  const act = async (operator: Operator, action: OperatorAuditAction, target: string | undefined, run: () => Promise<string> | string): Promise<OperatorActionResult> => {
    try {
      const message = await run();
      const entry = audit.record({ actor: operator.account, action, ...(target ? { target } : {}), outcome: "succeeded", detail: message });
      return { ok: true, message, audit: entry };
    } catch (error) {
      audit.record({ actor: operator.account, action, ...(target ? { target } : {}), outcome: "failed", detail: toManagedError(error).message });
      throw error;
    }
  };

  const identity = (operator: Operator): OperatorIdentity => ({
    account: operator.account,
    grant: operator.grant,
    via: operator.via,
    ...(operator.session ? { sessionExpiresAt: new Date(operator.session.expiresAt).toISOString() } : {}),
  });

  // --- Identity and console sign-in -----------------------------------------------------------------------------

  route("GET", OPERATOR_ROUTES.me, (_ctx, operator) => identity(operator));

  // Minted with the operator's GitHub token (the CLI); a browser session cannot mint tickets.
  app.routes.post(
    OPERATOR_ROUTES.consoleTickets,
    async (ctx) => {
      ctx.res.setHeader("cache-control", "no-store");
      const principal = ctx.principal!;
      const grant = await access.authorize(principal);
      const { ticket, expiresAt } = access.mintTicket(principal, grant);
      return { ticket, expiresAt, url: `${app.config.publicUrl}${CONSOLE_PATH}/signin#ticket=${encodeURIComponent(ticket)}` } satisfies ConsoleTicket;
    },
    { auth: "user" },
  );

  app.routes.post(
    OPERATOR_ROUTES.consoleSession,
    async (ctx) => {
      ctx.res.setHeader("cache-control", "no-store");
      access.assertConsoleRequest(ctx.req);
      const body = await ctx.json<{ ticket?: unknown }>();
      const redeemed = access.redeemTicket(body.ticket);
      // The ticket may have waited up to a minute: the account must still be valid and still an operator.
      const principal = await auth().authenticate(redeemed.principal.token);
      if (principal.accountId !== redeemed.principal.accountId) throw new ManagedCopilotError("authentication_required", "The sign-in link's credential now belongs to another GitHub account.");
      const grant = await access.authorize(principal);
      access.endSession(access.cookieFrom(ctx.req));
      const { cookie, session } = access.createSession(principal, grant);
      ctx.res.setHeader("set-cookie", access.setCookie(cookie, CONSOLE_SESSION_MS / 1000));
      audit.record({ actor: accountInfo(principal), action: "console.signin", outcome: "succeeded", detail: grant === "local" ? "Local operator (no operators named)" : "AppHost operator" });
      return identity({ principal, account: accountInfo(principal), grant, via: "console", session });
    },
    { auth: "none" },
  );

  app.routes.delete(
    OPERATOR_ROUTES.consoleSession,
    (ctx) => {
      ctx.res.setHeader("cache-control", "no-store");
      access.assertConsoleRequest(ctx.req);
      const session = access.endSession(access.cookieFrom(ctx.req));
      ctx.res.setHeader("set-cookie", access.clearCookie());
      if (session) audit.record({ actor: accountInfo(session.principal), action: "console.signout", outcome: "succeeded" });
      return undefined;
    },
    { auth: "none" },
  );

  // --- Control plane: deployment, infrastructure, environments ----------------------------------------------------

  route("GET", OPERATOR_ROUTES.overview, () => views.overview());
  route("GET", OPERATOR_ROUTES.infrastructure, () => views.infrastructure());
  route("GET", OPERATOR_ROUTES.environments, () => core().environments());
  route("GET", "/v1/operator/environments/:name", (ctx) => {
    const name = ctx.params["name"]!;
    const environment = core().environments().environments.find((candidate) => candidate.name === name);
    if (!environment) throw new ManagedCopilotError("environment_not_found", `Environment "${name}" is not declared in this deployment`, { environment: name });
    return environment;
  });
  route("GET", "/v1/operator/environments/:name/file", (ctx) => {
    const path = ctx.query.get("path");
    if (!path) throw new ManagedCopilotError("invalid_request", "path is required, for example agents/planner.agent.md");
    return core().customizationFile(ctx.params["name"]!, path);
  });

  // --- Data plane: sessions, connections, sandboxes -----------------------------------------------------------------

  route("GET", OPERATOR_ROUTES.sessions, (ctx) => {
    const state = oneOf(ctx, "state", SESSION_STATES);
    const placement = oneOf(ctx, "placement", PLACEMENTS);
    const owner = ctx.query.get("owner") || undefined;
    const environment = ctx.query.get("environment") || undefined;
    const q = ctx.query.get("q")?.trim() || undefined;
    return core().sessions({ ...(owner ? { owner } : {}), ...(environment ? { environment } : {}), ...(state ? { state } : {}), ...(placement ? { placement } : {}), ...(q ? { q } : {}), limit: limit(ctx, 200) });
  });
  route("GET", "/v1/operator/sessions/:id", (ctx) => views.session(ctx.params["id"]!));
  route("GET", OPERATOR_ROUTES.connections, () => views.connections());
  route("GET", OPERATOR_ROUTES.sandboxes, (ctx) => {
    const state = oneOf(ctx, "state", SANDBOX_STATES);
    return views.sandboxes({ ...(state ? { state } : {}), limit: limit(ctx, 200) });
  });
  route("POST", OPERATOR_ROUTES.sandboxesProbe, (_ctx, operator) =>
    act(operator, "sandboxes.probe", undefined, async () => {
      const sandboxes = ports().sandboxes;
      if (!sandboxes?.probe) throw new ManagedCopilotError("capability_unavailable", "This gateway has no sandbox backend.");
      const available = await sandboxes.probe();
      const status = await sandboxes.operatorStatus?.();
      return available ? "The sandbox backend answered: isolated sessions are available." : `The sandbox backend did not answer: ${status?.lastError ?? "isolated sessions are unavailable"}.`;
    }),
  );
  route("POST", "/v1/operator/sandboxes/:sessionId/stop", (ctx, operator) => {
    const sessionId = ctx.params["sessionId"]!;
    return act(operator, "sandbox.stop", sessionId, async () => {
      const stop = ports().sandboxes?.operatorStop;
      if (!stop) throw new ManagedCopilotError("capability_unavailable", "This gateway has no sandbox backend.");
      const result = await stop.call(ports().sandboxes, sessionId, `operator @${operator.account.login}`);
      return `Stopped sandbox ${result.sandboxId}. Its files and state are kept; the session starts it again on next use.`;
    });
  });

  // --- Durable work ----------------------------------------------------------------------------------------------

  route("GET", OPERATOR_ROUTES.schedules, () => views.schedules());
  route("GET", "/v1/operator/schedules/:id/runs", (ctx) => views.scheduleRuns(ctx.params["id"]!));
  route("POST", "/v1/operator/schedules/:id/pause", async (ctx, operator) => {
    const id = ctx.params["id"]!;
    const body = await ctx.json<{ reason?: unknown }>();
    if (body.reason !== undefined && typeof body.reason !== "string") throw new ManagedCopilotError("invalid_request", "reason must be a string");
    return act(operator, "schedule.pause", id, () => {
      const pause = ports().schedules?.operatorPause;
      if (!pause) throw new ManagedCopilotError("capability_unavailable", "Schedules are not available on this gateway.");
      const schedule = pause.call(ports().schedules, id, operator.account.login, body.reason as string | undefined);
      return `Paused schedule ${schedule.name} (@${schedule.ownerLogin}). It runs again once resumed.`;
    });
  });
  route("POST", "/v1/operator/schedules/:id/resume", (ctx, operator) => {
    const id = ctx.params["id"]!;
    return act(operator, "schedule.resume", id, () => {
      const resume = ports().schedules?.operatorResume;
      if (!resume) throw new ManagedCopilotError("capability_unavailable", "Schedules are not available on this gateway.");
      const schedule = resume.call(ports().schedules, id);
      if (schedule.state === "paused") return `Lifted the operator pause on schedule ${schedule.name} (@${schedule.ownerLogin}); it stays paused by its owner.`;
      return `Resumed schedule ${schedule.name} (@${schedule.ownerLogin})${schedule.nextRunAt ? `; next run ${schedule.nextRunAt}` : ""}.`;
    });
  });
  route("GET", OPERATOR_ROUTES.webhooks, (ctx) => {
    const state = oneOf(ctx, "state", DELIVERY_STATES);
    return views.webhooks({ ...(state ? { state } : {}), limit: limit(ctx, 200) });
  });
  route("POST", "/v1/operator/webhooks/deliveries/:id/retry", (ctx, operator) => {
    const id = ctx.params["id"]!;
    return act(operator, "webhook.retry", id, () => {
      const retry = ports().webhooks?.retry;
      if (!retry) throw new ManagedCopilotError("capability_unavailable", "Webhooks are not available on this gateway.");
      const delivery = retry.call(ports().webhooks, id);
      return `Delivery ${delivery.id} of ${delivery.eventType} to ${delivery.webhook} is queued for another attempt.`;
    });
  });
  route("GET", OPERATOR_ROUTES.actions, (ctx) => {
    const state = oneOf(ctx, "state", ACTION_FILTERS) ?? "open";
    const sessionId = ctx.query.get("session") || undefined;
    return views.actions({ state, ...(sessionId ? { sessionId } : {}), limit: limit(ctx, 200) });
  });
  route("GET", OPERATOR_ROUTES.accounts, () => views.accounts());

  // --- Events, logs, audit -----------------------------------------------------------------------------------------

  route("GET", OPERATOR_ROUTES.events, (ctx) => {
    const type = ctx.query.get("type") || undefined;
    return core().events({ limit: limit(ctx, 100), ...(type ? { type } : {}) });
  });
  route("GET", OPERATOR_ROUTES.logs, (ctx) => {
    const level = oneOf(ctx, "level", LOG_LEVELS);
    return logRing.recent({ ...(level ? { level } : {}), limit: limit(ctx, 200) }).map(redactLogRecord);
  });
  route("GET", OPERATOR_ROUTES.audit, (ctx) => audit.list(limit(ctx, 100), core().accountDirectory()));

  route("GET", OPERATOR_ROUTES.stream, (ctx) => {
    const { req, res } = ctx;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed) return;
      if (res.writableLength > STREAM_BUFFER_LIMIT) {
        res.end();
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const offEvents = app.service("events").subscribe((event, meta) => send("platform", core().toOperatorEvent(event, core().accountDirectory()(meta.ownerId))));
    const offLogs = logRing.subscribe((entry) => send("log", redactLogRecord(entry)));
    let beats = 0;
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(": ping\n\n");
      // A revoked credential, a removed operator, or an ended console session ends the stream (checked each minute).
      if (++beats % 4 === 0) void authenticate(ctx).catch(() => res.end());
    }, 15_000);
    heartbeat.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      offEvents();
      offLogs();
    };
    req.on("close", close);
    res.on("close", close);
    return undefined;
  });
}
