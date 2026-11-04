import {
  accountLabel,
  CONSOLE_PATH,
  CONSOLE_TICKET_TTL_SECONDS,
  isManagedCopilotError,
  OPERATOR_ROUTES,
  type ComponentHealth,
  type ConsoleTicket,
  type OperatorEnvironments,
  type OperatorIdentity,
  type OperatorInfrastructure,
  type OperatorOverview,
  type OperatorSandbox,
  type OperatorSchedule,
  type OperatorSessionSummary,
  type OperatorWebhooks,
} from "@managed-copilot/protocol";
import type { Context, Deployment } from "../context.js";
import { CommandError, UsageError } from "../errors.js";
import { relativeTime, shortId, table, truncate, type Style } from "../output.js";

export const OPERATOR_VIEWS = ["overview", "infra", "environments", "sessions", "sandboxes", "schedules", "webhooks"] as const;
type OperatorView = (typeof OPERATOR_VIEWS)[number];

const OPERATOR_HINT = 'Operators are named in the AppHost: addManagedCopilot(builder, "copilot", { operators: { githubUsers: ["<login>"] } }).';

/** Operator API errors with actionable hints (an older gateway, or an account that is not an operator). */
function operatorError(error: unknown): unknown {
  if (isManagedCopilotError(error, "not_found") && /^No route for \/v1\/operator/.test(error.message)) {
    return new CommandError("This deployment has no operator console yet.", { code: "capability_unavailable", hint: "Update the platform to a version with the operator console." });
  }
  if (isManagedCopilotError(error, "forbidden")) return new CommandError(error.message, { code: "forbidden", hint: OPERATOR_HINT });
  return error;
}

async function get<T>(deployment: Deployment, path: string): Promise<T> {
  try {
    return await deployment.http.get<T>(path);
  } catch (error) {
    throw operatorError(error);
  }
}

/** `managed-copilot console`: signs this browser in to the operator console with the caller's GitHub sign-in. */
export async function consoleCommand(ctx: Context): Promise<void> {
  const { style } = ctx;
  const deployment = await ctx.deployment();
  const me = await get<OperatorIdentity>(deployment, OPERATOR_ROUTES.me);
  let ticket: ConsoleTicket;
  try {
    ticket = await deployment.http.post<ConsoleTicket>(OPERATOR_ROUTES.consoleTickets, {});
  } catch (error) {
    throw operatorError(error);
  }
  // The deployment URL this machine reaches; the ticket travels in the fragment, which browsers never send.
  const home = new URL(`${CONSOLE_PATH}/`, deployment.url).toString();
  const link = new URL(`${CONSOLE_PATH}/signin`, deployment.url);
  link.hash = `ticket=${encodeURIComponent(ticket.ticket)}`;
  if (ctx.json) return ctx.out(JSON.stringify({ url: link.toString(), console: home, account: me.account, grant: me.grant, expiresAt: ticket.expiresAt }, null, 2));

  const who = `${style.bold(`@${me.account.login}`)} ${style.dim(me.grant === "local" ? "(local operator)" : "(operator)")}`;
  let opened = false;
  if (ctx.options["no-open"] !== true && ctx.interactive) {
    try {
      await ctx.openUrl(link.toString());
      opened = true;
    } catch {
      opened = false;
    }
  }
  if (opened) {
    ctx.out(`${style.green(style.ok)} Opened the operator console for ${who} ${style.dim(`· ${home}`)}`);
    ctx.out(style.dim(`  The sign-in link works once, within ${CONSOLE_TICKET_TTL_SECONDS} seconds. Run this again for another window.`));
    return;
  }
  ctx.out(`${style.green(style.ok)} Operator console for ${who}. Open this link to sign in (it works once, within ${CONSOLE_TICKET_TTL_SECONDS} seconds):`);
  ctx.out(`  ${link.toString()}`);
}

const STATUS_MARK: Readonly<Record<ComponentHealth["status"], (style: Style) => string>> = {
  healthy: (style) => style.green(style.dot),
  degraded: (style) => style.yellow(style.warn),
  unavailable: (style) => style.red(style.fail),
  disabled: (style) => style.dim("-"),
  unknown: (style) => style.dim("?"),
};

function paintStatus(status: ComponentHealth["status"], style: Style): string {
  if (status === "healthy") return style.green(status);
  if (status === "degraded") return style.yellow(status);
  if (status === "unavailable") return style.red(status);
  return style.dim(status);
}

function counts(record: Readonly<Partial<Record<string, number>>>): string {
  return Object.entries(record)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([state, count]) => `${state} ${count}`)
    .join(" · ");
}

/** `managed-copilot operator [view]`: the operator API's views in the terminal (or as JSON). */
export async function operatorCommand(ctx: Context): Promise<void> {
  const view = (ctx.args[0] ?? "overview") as OperatorView;
  if (!(OPERATOR_VIEWS as readonly string[]).includes(view)) throw new UsageError(`Unknown view "${view}".`, `Use one of: ${OPERATOR_VIEWS.join(", ")}.`);
  const deployment = await ctx.deployment();
  switch (view) {
    case "overview":
      return overview(ctx, await get<OperatorOverview>(deployment, OPERATOR_ROUTES.overview));
    case "infra":
      return infrastructure(ctx, await get<OperatorInfrastructure>(deployment, OPERATOR_ROUTES.infrastructure));
    case "environments":
      return environments(ctx, await get<OperatorEnvironments>(deployment, OPERATOR_ROUTES.environments));
    case "sessions": {
      const query = new URLSearchParams();
      for (const name of ["environment", "state", "owner", "limit"] as const) {
        const value = ctx.options[name];
        if (typeof value === "string" && value) query.set(name, value);
      }
      return sessions(ctx, await get<OperatorSessionSummary[]>(deployment, `${OPERATOR_ROUTES.sessions}${query.size > 0 ? `?${query}` : ""}`));
    }
    case "sandboxes":
      return sandboxes(ctx, await get<OperatorSandbox[]>(deployment, `${OPERATOR_ROUTES.sandboxes}${typeof ctx.options.state === "string" ? `?state=${encodeURIComponent(ctx.options.state)}` : ""}`));
    case "schedules":
      return schedules(ctx, await get<OperatorSchedule[]>(deployment, OPERATOR_ROUTES.schedules));
    case "webhooks":
      return webhooks(ctx, await get<OperatorWebhooks>(deployment, `${OPERATOR_ROUTES.webhooks}${typeof ctx.options.state === "string" ? `?state=${encodeURIComponent(ctx.options.state)}` : ""}`));
  }
}

function json(ctx: Context, value: unknown): boolean {
  if (!ctx.json) return false;
  ctx.out(JSON.stringify(value, null, 2));
  return true;
}

function overview(ctx: Context, data: OperatorOverview): void {
  if (json(ctx, data)) return;
  const { style } = ctx;
  const { deployment, counts: totals } = data;
  ctx.out(`${style.bold(deployment.name)} ${style.dim(`· ${deployment.mode} · v${deployment.version} · ${deployment.publicUrl}`)}`);
  ctx.out();
  const width = Math.max(...data.health.map((component) => component.name.length));
  for (const component of data.health) {
    ctx.out(`  ${STATUS_MARK[component.status](style)} ${component.name.padEnd(width)}  ${paintStatus(component.status, style).padEnd(style.green("healthy").length + 4)}${style.dim(component.summary)}`);
  }
  if (data.attention.length > 0) {
    ctx.out();
    ctx.out(style.bold("Needs attention"));
    for (const item of data.attention) {
      const mark = item.severity === "error" ? style.red(style.fail) : item.severity === "warning" ? style.yellow(style.warn) : style.cyan(style.dot);
      ctx.out(`  ${mark} ${item.title}${item.detail ? style.dim(` · ${truncate(item.detail, 120, style.ellipsis)}`) : ""}`);
    }
  }
  ctx.out();
  const rows: [string, string][] = [
    ["Sessions", `${totals.sessions.total} total · ${totals.sessions.live} live${counts(totals.sessions.byState) ? style.dim(` · ${counts(totals.sessions.byState)}`) : ""}`],
    ["Connections", `${totals.connections.sdk} SDK · ${totals.connections.cli} Copilot CLI`],
    ["Sandboxes", counts(totals.sandboxes.byState) || style.dim("none")],
    ["Schedules", `${totals.schedules.active} active · ${totals.schedules.paused} paused`],
    ["Actions", `${totals.actions.open} open${totals.actions.needsReconciliation > 0 ? style.yellow(` · ${totals.actions.needsReconciliation} need reconciliation`) : ""}`],
    ["Webhooks", `${totals.webhooks.pending} pending${totals.webhooks.failed > 0 ? style.red(` · ${totals.webhooks.failed} failed`) : ""}`],
    ["Accounts", String(totals.accounts)],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) ctx.out(`${style.dim(label.padEnd(labelWidth))}  ${value}`);
  ctx.out();
  // The console is opened the same way this command reached the deployment.
  const url = typeof ctx.options["url"] === "string" ? ` --url ${ctx.options["url"]}` : "";
  ctx.out(style.dim(`  Open the console: npx managed-copilot console${url}`));
}

function infrastructure(ctx: Context, data: OperatorInfrastructure): void {
  if (json(ctx, data)) return;
  const { style } = ctx;
  const section = (title: string, health: ComponentHealth | undefined, facts: [string, string | undefined][]) => {
    ctx.out(`${health ? `${STATUS_MARK[health.status](style)} ` : ""}${style.bold(title)}${health ? style.dim(` · ${health.summary}`) : ""}`);
    if (health?.detail) ctx.out(`  ${style.yellow(health.detail)}`);
    const shown = facts.filter((fact): fact is [string, string] => Boolean(fact[1]));
    const width = Math.max(0, ...shown.map(([label]) => label.length));
    for (const [label, value] of shown) ctx.out(`  ${style.dim(label.padEnd(width))}  ${value}`);
    ctx.out();
  };
  const health = (id: ComponentHealth["id"]) => data.health.find((component) => component.id === id);
  const { gateway, runtime, sandboxes: backend, egress, scheduler, webhooks: worker, storage } = data;
  section("Gateway", health("gateway"), [
    ["Public URL", gateway.publicUrl],
    ["Listening", gateway.listen],
    ["Process", `pid ${gateway.pid} · Node ${gateway.node} · ${gateway.platform}`],
    ["Memory", `${Math.round(gateway.memory.rssBytes / 1048576)} MB resident`],
    ["Event loop", `p99 ${gateway.eventLoopDelayMs.p99} ms`],
    ["Access", gateway.access.open ? "any GitHub account" : [...gateway.access.githubUsers.map((user) => `@${user}`), ...gateway.access.githubOrgs].join(", ")],
    ["Operators", gateway.operators.localDefault ? "every account that can use this local gateway" : [...gateway.operators.githubUsers.map((user) => `@${user}`), ...gateway.operators.githubOrgs].join(", ") || "none (console off)"],
    ...gateway.facts.map((fact): [string, string] => [fact.label, fact.value]),
  ]);
  section("Shared runtime", health("runtime"), [
    ["State", runtime.state],
    ["Version", runtime.version],
    ["Process", runtime.pid ? `pid ${runtime.pid}` : runtime.external ? "external" : undefined],
    ["Restarts", String(runtime.restarts)],
    ["Last error", runtime.lastError],
  ]);
  section("Sandbox backend", health("sandboxes"), [
    ["Provider", backend.provider],
    ["Checked", backend.checkedAt ? relativeTime(backend.checkedAt, ctx.now()) : undefined],
    ["Last error", backend.lastError],
    ...backend.facts.map((fact): [string, string] => [fact.label, fact.value]),
  ]);
  if (egress) section("Egress proxy", health("egress"), [["Mode", egress.mode], ["CA fingerprint", egress.caFingerprint], ["Registrations", String(egress.registrations)], ["Blocked (24 h)", String(egress.blockedLastDay)]]);
  if (scheduler) section("Scheduler", health("scheduler"), [["Next due", scheduler.nextDueAt ? relativeTime(scheduler.nextDueAt, ctx.now()) : undefined], ["Last error", scheduler.lastTickError]]);
  if (worker) section("Webhooks", health("webhooks"), [["Deliveries", counts(worker.counts) || "none"]]);
  section("Storage", health("storage"), [["Data directory", storage.dataDir]]);
}

function environments(ctx: Context, data: OperatorEnvironments): void {
  if (json(ctx, data)) return;
  const { style } = ctx;
  const rows = data.environments.map((environment) => {
    const customizations = environment.customizations;
    return [
      style.bold(environment.name),
      environment.type,
      environment.models ? truncate(environment.models.join(", "), 32, style.ellipsis) : style.dim("entitlement"),
      environment.network.access === "restricted" ? `${environment.network.allowedDomains.length} hosts` : environment.network.access,
      environment.size ?? style.dim("-"),
      customizations
        ? customizations.problem
          ? style.red("rejected")
          : `${customizations.agents.length} agents · ${customizations.skills.length} skills · ${customizations.instructions.length} instructions`
        : style.dim("-"),
      `${environment.sessions.total}${environment.sessions.live > 0 ? style.dim(` (${environment.sessions.live} live)`) : ""}`,
    ];
  });
  ctx.out(table(["NAME", "TYPE", "MODELS", "NETWORK", "SIZE", "CUSTOMIZATIONS", "SESSIONS"], rows, style));
}

function sessions(ctx: Context, list: readonly OperatorSessionSummary[]): void {
  if (json(ctx, list)) return;
  const { style } = ctx;
  if (list.length === 0) return ctx.out("No sessions match.");
  const rows = list.map((session) => [
    style.bold(shortId(session.id)),
    accountLabel(session.owner),
    session.environment,
    session.placement,
    session.state === "failed" ? style.red(session.state) : session.state,
    session.live ? style.green(`live${session.attached > 0 ? ` · ${session.attached} attached` : ""}`) : style.dim("-"),
    style.dim(relativeTime(session.updatedAt, ctx.now())),
  ]);
  ctx.out(table(["ID", "OWNER", "ENVIRONMENT", "PLACEMENT", "STATE", "LIVE", "UPDATED"], rows, style));
}

function sandboxes(ctx: Context, list: readonly OperatorSandbox[]): void {
  if (json(ctx, list)) return;
  const { style } = ctx;
  if (list.length === 0) return ctx.out("No sandboxes.");
  const rows = list.map((sandbox) => [
    style.bold(sandbox.id),
    shortId(sandbox.sessionId),
    accountLabel(sandbox.owner),
    sandbox.environment,
    sandbox.size,
    sandbox.state === "failed" ? style.red(sandbox.state) : sandbox.state === "running" ? style.green(sandbox.state) : sandbox.state,
    style.dim(relativeTime(sandbox.updatedAt, ctx.now())),
  ]);
  ctx.out(table(["SANDBOX", "SESSION", "OWNER", "ENVIRONMENT", "SIZE", "STATE", "UPDATED"], rows, style));
}

function schedules(ctx: Context, list: readonly OperatorSchedule[]): void {
  if (json(ctx, list)) return;
  const { style } = ctx;
  if (list.length === 0) return ctx.out("No schedules.");
  const rows = list.map((schedule) => [
    style.bold(schedule.name),
    accountLabel(schedule.owner),
    schedule.cron ? `${schedule.cron} ${style.dim(schedule.timeZone)}` : (schedule.runAt ?? "-"),
    schedule.state === "paused" ? style.yellow(`paused${schedule.pausedReason ? style.dim(` · ${truncate(schedule.pausedReason.replace(/^Paused: /, ""), 40, style.ellipsis)}`) : ""}`) : "active",
    schedule.nextRunAt ? relativeTime(schedule.nextRunAt, ctx.now()) : style.dim("-"),
    schedule.lastRun ? (schedule.lastRun.status === "failed" ? style.red(schedule.lastRun.status) : schedule.lastRun.status) : style.dim("-"),
  ]);
  ctx.out(table(["NAME", "OWNER", "WHEN", "STATE", "NEXT RUN", "LAST RUN"], rows, style));
}

function webhooks(ctx: Context, data: OperatorWebhooks): void {
  if (json(ctx, data)) return;
  const { style } = ctx;
  if (data.subscriptions.length === 0) return ctx.out("No webhook subscriptions.");
  for (const subscription of data.subscriptions) {
    ctx.out(`${subscription.signed ? style.green(style.ok) : style.red(style.fail)} ${style.bold(subscription.name)} ${style.dim(`${subscription.url} · ${subscription.events.join(", ")} · ${subscription.environments.join(", ")}`)}${subscription.signed ? "" : style.red(" · no signing secret")}`);
  }
  ctx.out();
  if (data.deliveries.length === 0) return ctx.out("No deliveries.");
  const rows = data.deliveries.slice(0, 50).map((delivery) => [
    delivery.webhook,
    delivery.eventType,
    delivery.state === "failed" ? style.red(delivery.state) : delivery.state === "delivered" ? style.green(delivery.state) : delivery.state,
    String(delivery.attempts),
    truncate(delivery.lastError ?? "", 48, style.ellipsis),
    style.dim(relativeTime(delivery.createdAt, ctx.now())),
  ]);
  ctx.out(table(["WEBHOOK", "EVENT", "STATE", "ATTEMPTS", "LAST ERROR", "CREATED"], rows, style));
}
