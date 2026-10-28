import type { PermissionHandler } from "@github/copilot-sdk";
import type { EnvironmentInfo, SessionInfo, SessionState, WorkerState } from "@managed-copilot/protocol";
import { resolveSession, type Context, type Deployment } from "../context.js";
import { CommandError, describeError, UsageError } from "../errors.js";
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
    ctx.out(style.dim("  Start one in Copilot CLI with: npx managed-copilot new <environment>"));
    ctx.out(style.dim('  Or from code: await managed.createSession({ environment: "chat", onPermissionRequest: approveAll })'));
    return;
  }
  const rows = list.map((session) => [
    style.bold(shortId(session.id)),
    session.parentSessionId
      ? `${session.environment} ${style.dim(`(${session.kind === "workspace" ? "sandbox" : "worker"} of ${shortId(session.parentSessionId)})`)}`
      : session.kind === "workspace"
        ? `${session.environment} ${style.dim("(sandbox)")}`
        : session.environment,
    session.placement === "sandbox" && session.sandbox ? `sandbox ${style.dim(session.sandbox.state)}` : session.placement,
    describeSession(session, style),
    truncate(session.title ?? style.dim("untitled"), 40, style.ellipsis),
    style.dim(relativeTime(session.updatedAt, ctx.now())),
  ]);
  ctx.out(table(["ID", "ENVIRONMENT", "PLACEMENT", "STATE", "TITLE", "UPDATED"], rows, style));
  ctx.out();
  ctx.out(style.dim(`  ${list.length} session${list.length === 1 ? "" : "s"} · attach Copilot CLI with: npx managed-copilot attach <ID>`));
}

function paintWorker(state: WorkerState, style: Style): string {
  switch (state) {
    case "starting":
      return style.yellow(state);
    case "working":
      return style.cyan(state);
    case "idle":
      return style.green(state);
    case "failed":
      return style.red(state);
    default:
      return style.dim(state);
  }
}

/** `workers <session>`: an orchestrator session's workers, their state, and their latest report. */
export async function workers(ctx: Context): Promise<void> {
  const { style } = ctx;
  const managed = await (await ctx.deployment()).managed();
  const session = await resolveSession(managed, ctx.args[0]);
  if (session.type !== "orchestrator") {
    throw new UsageError(`Session ${shortId(session.id)} is ${session.type}; only orchestrator sessions have workers.`, "List sessions with: npx managed-copilot sessions");
  }
  const list = await managed.workers(session.id);
  const found = await list.list();
  if (ctx.json) return ctx.out(JSON.stringify(found, null, 2));
  if (found.length === 0) {
    ctx.out(`Session ${shortId(session.id)} has not started any workers yet.`);
    return;
  }
  const rows = found.map((worker) => [
    worker.role === "hands" ? `${style.bold(worker.name)} ${style.dim("(own sandbox)")}` : style.bold(worker.name),
    shortId(worker.id),
    worker.environment,
    paintWorker(worker.state, style),
    truncate((worker.state === "idle" ? worker.result : worker.error)?.replace(/\s+/g, " ").trim() || style.dim("-"), 60, style.ellipsis),
    style.dim(relativeTime(worker.updatedAt, ctx.now())),
  ]);
  ctx.out(table(["NAME", "ID", "ENVIRONMENT", "STATE", "LATEST", "UPDATED"], rows, style));
  ctx.out();
  const hands = found.filter((worker) => worker.role === "hands").length;
  const agents = found.length - hands;
  ctx.out(
    style.dim(
      `  ${agents} worker${agents === 1 ? "" : "s"}${agents > 0 ? " · each is a session with its own sandbox: npx managed-copilot attach <ID>" : ""}${
        hands > 0 ? `${agents > 0 ? "\n  " : " · "}${hands} sandbox${hands === 1 ? "" : "es"} the coordinator works in itself (no agent): npx managed-copilot exec <ID> -- <command>` : ""
      }`,
    ),
  );
}

/** Fails before anything is created or resolved when there is no Copilot CLI to open. */
function requireCopilotCli(deployment: Deployment, rerun: string): void {
  try {
    deployment.requireCopilot();
  } catch {
    throw new CommandError("Copilot CLI is not installed.", {
      code: "capability_unavailable",
      hint: `Install it with \`winget install GitHub.Copilot\` or \`npm install -g @github/copilot\`, then run \`${rerun}\` again.`,
    });
  }
}

/** Runs Copilot CLI on the session in this terminal, then says how it ended and how to come back. */
async function openInCopilotCli(ctx: Context, deployment: Deployment, sessionId: string): Promise<number> {
  const style = ctx.errStyle;
  const id = shortId(sessionId);
  const result = await deployment.attach(sessionId);
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

export async function attach(ctx: Context): Promise<number> {
  const style = ctx.errStyle;
  if (!ctx.interactive) throw new UsageError("Copilot CLI needs an interactive terminal.", "Run `npx managed-copilot attach <session>` from a terminal window.");
  const deployment = await ctx.deployment();
  requireCopilotCli(deployment, "npx managed-copilot attach");
  const session = await resolveSession(await deployment.managed(), ctx.args[0]);
  const id = shortId(session.id);
  ctx.err(`${style.cyan(style.dot)} Attaching Copilot CLI to ${style.bold(id)} ${style.dim(`· ${session.environment} · ${session.placement}${session.title ? ` · ${truncate(session.title, 40, style.ellipsis)}` : ""}`)}`);
  ctx.err(style.dim("  The session keeps running when you exit Copilot CLI."));
  return openInCopilotCli(ctx, deployment, session.id);
}

const NEW_USAGE = "npx managed-copilot new <environment> [--model <id>]";

/**
 * Registers the new session for permission prompts without answering any. The creating client leaves before Copilot
 * CLI attaches, and the platform keeps the registration, so the attached CLI is the one that asks you.
 */
const leaveToCopilotCli: PermissionHandler = () => ({ kind: "no-result" });

function listEnvironments(environments: readonly EnvironmentInfo[]): string {
  return environments.map((environment) => `${environment.name} (${environment.type})`).join(", ");
}

function chooseEnvironment(environments: readonly EnvironmentInfo[], name: string | undefined): EnvironmentInfo {
  if (environments.length === 0) throw new CommandError("This deployment declares no environments to start a session in.", { hint: "Declare environments in the AppHost's addManagedCopilot options." });
  const offered = `This deployment offers: ${listEnvironments(environments)}.`;
  if (!name) throw new UsageError("Name the environment for the new session.", `${offered} For example: npx managed-copilot new ${environments[0]!.name}`);
  const environment = environments.find((candidate) => candidate.name === name);
  if (!environment) throw new UsageError(`No environment is named "${name}".`, offered);
  return environment;
}

/** `new <environment>`: creates a session through the platform's normal admission, then opens it in Copilot CLI. */
export async function newSession(ctx: Context): Promise<number> {
  const style = ctx.errStyle;
  const [name, extra] = ctx.args;
  if (extra !== undefined) throw new UsageError(`Name one environment ("${extra}" is extra).`, `Usage: ${NEW_USAGE}`);
  if (!ctx.interactive) throw new UsageError("Copilot CLI needs an interactive terminal.", "Run `npx managed-copilot new <environment>` from a terminal window.");
  const model = ctx.options.model as string | undefined;
  if (model !== undefined && model.trim() === "") throw new UsageError("--model needs a model ID.", `Usage: ${NEW_USAGE}`);

  const deployment = await ctx.deployment();
  const managed = await deployment.managed();
  const environment = chooseEnvironment(managed.info.environments, name);
  const allowed = environment.models ?? [];
  if (model !== undefined && allowed.length > 0 && !allowed.includes(model)) {
    throw new UsageError(`${environment.name} does not allow the model "${model}".`, `Use one of: ${allowed.join(", ")}.`);
  }
  if (!managed.info.capabilities.includes("attach.cli")) {
    throw new CommandError("This deployment does not offer Copilot CLI attach, so a new session could not be opened in it.", {
      code: "capability_unavailable",
      hint: "Update the platform; `npx managed-copilot status` shows what it offers.",
    });
  }
  requireCopilotCli(deployment, `npx managed-copilot new ${environment.name}`);

  const shownModel = model ?? allowed[0];
  const placement =
    environment.type === "isolated"
      ? "its own sandbox"
      : environment.type === "promotable"
        ? "shared, promotable"
        : environment.type === "orchestrator"
          ? environment.execution === "direct"
            ? "shared, works in a sandbox itself"
            : environment.execution === "mixed"
              ? "shared, works in a sandbox itself and starts workers"
              : "shared, starts workers in sandboxes"
          : "shared";
  ctx.err(`${style.cyan(style.dot)} Starting a new ${style.bold(environment.name)} session ${style.dim(`· ${placement}${shownModel ? ` · ${shownModel}` : ""}`)}`);
  if (environment.type === "isolated") ctx.err(style.dim(`  Setting up its sandbox${style.ellipsis}`));
  let sessionId: string;
  try {
    ({ sessionId } = await managed.createSession({ environment: environment.name, ...(model ? { model } : {}), onPermissionRequest: leaveToCopilotCli }));
  } finally {
    // Leave before Copilot CLI attaches (sessions outlive their clients), so the CLI answers the session's prompts.
    await managed.close();
  }
  const id = shortId(sessionId);
  ctx.err(`${style.green(style.ok)} Session ${style.bold(id)} is ready. Opening Copilot CLI${style.ellipsis}`);
  ctx.err(style.dim("  The session keeps running when you exit Copilot CLI."));
  try {
    return await openInCopilotCli(ctx, deployment, sessionId);
  } catch (error) {
    const described = describeError(error);
    throw new CommandError(described.message, {
      ...(described.code ? { code: described.code } : {}),
      hint: `${described.hint ? `${described.hint} ` : ""}Session ${id} was created and keeps running: npx managed-copilot attach ${id}`,
    });
  }
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
