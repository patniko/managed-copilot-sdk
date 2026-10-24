import type { SessionInfo, SessionState } from "@managed-copilot/protocol";
import { resolveSession, type Context } from "../context.js";
import { UsageError } from "../errors.js";
import { relativeTime, shortId, table, truncate, type Style } from "../output.js";

const STATES: readonly SessionState[] = ["creating", "ready", "running", "waiting", "idle", "stopped", "promoting", "deleting", "deleted", "failed"];

function paintState(state: SessionState, style: Style): string {
  switch (state) {
    case "running":
    case "waiting":
      return style.cyan(state);
    case "ready":
    case "idle":
      return style.green(state);
    case "creating":
    case "promoting":
      return style.yellow(state);
    case "failed":
      return style.red(state);
    default:
      return style.dim(state);
  }
}

function describeSession(session: SessionInfo, style: Style): string {
  const pending = session.pendingActions.length;
  return `${paintState(session.state, style)}${pending > 0 ? style.yellow(` ${style.warn} ${pending} waiting`) : ""}`;
}

export async function sessions(ctx: Context): Promise<void> {
  const { style, options } = ctx;
  const environment = options.environment as string | undefined;
  const state = options.state as string | undefined;
  if (state !== undefined && !STATES.includes(state as SessionState)) throw new UsageError(`Unknown state "${state}".`, `Use one of: ${STATES.join(", ")}.`);
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new UsageError("--limit must be a positive whole number.");

  const managed = await (await ctx.deployment()).managed();
  const list = await managed.sessions.list({ ...(environment ? { environment } : {}), ...(state ? { state: state as SessionState } : {}), ...(limit ? { limit } : {}) });
  if (ctx.json) return ctx.out(JSON.stringify(list, null, 2));
  if (list.length === 0) {
    ctx.out(environment || state ? "No sessions match." : "No sessions yet.");
    ctx.out(style.dim('  Create one from code: await managed.createSession({ environment: "chat", onPermissionRequest: approveAll })'));
    return;
  }
  const rows = list.map((session) => [
    style.bold(shortId(session.id)),
    session.environment,
    session.placement === "sandbox" && session.sandbox ? `sandbox ${style.dim(session.sandbox.state)}` : session.placement,
    describeSession(session, style),
    truncate(session.title ?? style.dim("untitled"), 40, style.ellipsis),
    style.dim(relativeTime(session.updatedAt, ctx.now())),
  ]);
  ctx.out(table(["ID", "ENVIRONMENT", "PLACEMENT", "STATE", "TITLE", "UPDATED"], rows, style));
  ctx.out();
  ctx.out(style.dim(`  ${list.length} session${list.length === 1 ? "" : "s"} · attach Copilot CLI with: npx managed-copilot attach <ID>`));
}

export async function attach(ctx: Context): Promise<number> {
  const style = ctx.errStyle;
  if (!ctx.interactive) throw new UsageError("Copilot CLI needs an interactive terminal.", "Run `npx managed-copilot attach <session>` from a terminal window.");
  const deployment = await ctx.deployment();
  const session = await resolveSession(await deployment.managed(), ctx.args[0]);
  const id = shortId(session.id);
  ctx.err(`${style.cyan(style.dot)} Attaching Copilot CLI to ${style.bold(id)} ${style.dim(`· ${session.environment} · ${session.placement}${session.title ? ` · ${truncate(session.title, 40, style.ellipsis)}` : ""}`)}`);
  ctx.err(style.dim("  The session keeps running when you exit Copilot CLI."));
  const result = await deployment.attach(session.id);
  const outcome = result.outcome;
  if (outcome && outcome.code !== "session_gone" && outcome.code !== "expired") {
    ctx.err(`${style.red(style.fail)} ${outcome.message}`);
    return 1;
  }
  if (outcome) ctx.err(`${style.yellow(style.warn)} ${outcome.message}`);
  else ctx.err(`${style.green(style.ok)} Detached from ${style.bold(id)}. The session keeps running.`);
  if (outcome?.code !== "session_gone" || /Attach again/.test(outcome.message)) ctx.err(style.dim(`  Attach again: npx managed-copilot attach ${id}`));
  return result.exitCode;
}

export async function promote(ctx: Context): Promise<void> {
  const { style } = ctx;
  const managed = await (await ctx.deployment()).managed();
  const session = await resolveSession(managed, ctx.args[0]);
  const result = await managed.promote(session.id);
  if (ctx.json) return ctx.out(JSON.stringify(result, null, 2));
  ctx.out(`${style.green(style.ok)} Session ${style.bold(shortId(session.id))} now runs in its own sandbox ${style.bold(result.sandboxId)}.`);
  ctx.out(style.dim("  Same session and history; the sandbox adds the environment's shell and file tools."));
}
