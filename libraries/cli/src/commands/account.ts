import { accountKindLabel, accountLabel, isManagedCopilotError, type EnvironmentInfo } from "@managed-copilot/protocol";
import { background, type Context } from "../context.js";
import { relativeTime } from "../output.js";

function describeEnvironment(environment: EnvironmentInfo, arrow: string): string {
  const details: string[] = [environment.type];
  if (environment.size) details.push(environment.size);
  if (environment.promoteTo) details.push(`${arrow} ${environment.promoteTo}`);
  if (environment.inference?.foundry) details.push(`Azure AI Foundry ${environment.inference.foundry}`);
  if (environment.network.access === "disabled") details.push("no network");
  if (environment.network.access === "restricted") details.push(`network: ${environment.network.allowedDomains.join(", ")}`);
  return `${environment.name} (${details.join(", ")})`;
}

export async function status(ctx: Context): Promise<void> {
  const deployment = await ctx.deployment();
  const managed = await deployment.managed();
  const credential = await background(deployment.http)
    .status()
    .catch((error: unknown) =>
      isManagedCopilotError(error, "not_found") || isManagedCopilotError(error, "capability_unavailable") ? undefined : Promise.reject(error),
    );
  if (ctx.json) {
    ctx.out(JSON.stringify({ url: deployment.url, deployment: managed.info, account: managed.account, background: credential ?? null }, null, 2));
    return;
  }
  const { style } = ctx;
  const info = managed.info;
  const rows: [string, string][] = [
    ["Deployment", `${style.bold(info.name)} ${style.dim(`· ${info.mode} · v${info.version} · ${deployment.url}`)}`],
    ["Signed in", `${accountLabel(managed.account)}${accountKindLabel(managed.account) ? style.dim(` (${accountKindLabel(managed.account)})`) : ""}`],
    [
      "Background",
      credential === undefined
        ? style.dim("not available on this deployment")
        : credential.active
          ? `${style.green("on")}${credential.createdAt ? style.dim(` since ${relativeTime(credential.createdAt, ctx.now())}`) : ""}`
          : `${style.yellow("off")}${style.dim(` · ${credential.reason ?? "run npx managed-copilot login to turn it on"}`)}`,
    ],
    ["Environments", info.environments.map((environment) => describeEnvironment(environment, style.arrow)).join(", ") || style.dim("none")],
    ["Capabilities", info.capabilities.join(", ") || style.dim("none")],
    ["Runtime", style.dim(`Copilot SDK ${info.sdk.copilotSdk}, runtime ${info.sdk.copilotRuntime}`)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) ctx.out(`${style.dim(label.padEnd(width))}  ${value}`);
}

export async function login(ctx: Context): Promise<void> {
  const deployment = await ctx.deployment();
  const credential = await background(deployment.http).enable();
  if (ctx.json) return ctx.out(JSON.stringify(credential, null, 2));
  const { style } = ctx;
  ctx.out(`${style.green(style.ok)} Background sign-in is on for ${style.bold(`@${credential.account.login}`)} at ${deployment.url}`);
  ctx.out(style.dim("  Scheduled runs and work that continues while you're away now run as you."));
  ctx.out(style.dim("  Turn it off any time with: npx managed-copilot logout"));
}

export async function logout(ctx: Context): Promise<void> {
  const deployment = await ctx.deployment();
  const credential = await background(deployment.http).disable();
  const managed = await deployment.managed();
  const paused = await managed.schedules
    .list()
    .then((schedules) => schedules.filter((schedule) => schedule.state === "paused" && (schedule as { pausedReason?: string }).pausedReason))
    .catch(() => []);
  if (ctx.json) return ctx.out(JSON.stringify({ ...credential, pausedSchedules: paused.map((schedule) => schedule.id) }, null, 2));
  const { style } = ctx;
  ctx.out(`${style.green(style.ok)} Background sign-in is off for ${style.bold(`@${credential.account.login}`)}.`);
  if (paused.length > 0) ctx.out(style.dim(`  Paused ${paused.length} schedule${paused.length === 1 ? "" : "s"}: ${paused.map((schedule) => schedule.name).join(", ")}`));
  ctx.out(style.dim("  Turn it back on with: npx managed-copilot login"));
}
