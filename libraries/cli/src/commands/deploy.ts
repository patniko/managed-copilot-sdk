import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Context } from "../context.js";
import { CommandError, UsageError } from "../errors.js";
import type { HostTools } from "../host.js";

/** Deploy-time settings `access` edits, as `@managed-copilot/aspire` reads them from the AppHost's user secrets. */
const LISTS = {
  users: { key: (name: string) => `Parameters:${name}-github-users`, label: "Platform users", kind: "login" },
  orgs: { key: (name: string) => `Parameters:${name}-github-orgs`, label: "Platform orgs", kind: "org" },
  operators: { key: (name: string) => `Parameters:${name}-operator-users`, label: "Operators", kind: "login" },
  "operator-orgs": { key: (name: string) => `Parameters:${name}-operator-orgs`, label: "Operator orgs", kind: "org" },
  ips: { key: (_name: string) => "Parameters:app-allowed-ips", label: "Apps open to", kind: "cidr" },
} as const;
type ListName = keyof typeof LISTS;
const ACTIONS = ["add", "remove", "set"] as const;
type Action = (typeof ACTIONS)[number];

export const ACCESS_LISTS = Object.keys(LISTS) as ListName[];

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const SUBSCRIPTION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_GROUP = /^[-\w.()]{1,89}[-\w()]$/;
const LOCATION = /^[a-z0-9]{2,40}$/;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

const DEFAULT_LOCATION = "westus2";
const DEFAULT_RESOURCE_GROUP = "managed-copilot-dev";
const TOKEN_PARAMETER_ENV = "Parameters__app-github-token";
/** Keys `@managed-copilot/aspire` generates for a deployment (`Parameters:<name>-<suffix>`); local values must never replace them. */
const GENERATED_KEYS = ["platform-key", "durable-key", "vault-key", "egress-key"];

const split = (value: string | undefined) => (value ?? "").split(/[\s,]+/).filter(Boolean);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function normalizeCidr(value: string): string {
  const match = IPV4.exec(value);
  if (!match || match.slice(1, 5).some((octet) => Number(octet) > 255) || (match[5] !== undefined && Number(match[5]) > 32)) {
    throw new UsageError(`"${value}" is not an IPv4 address or range.`, 'Use an address (203.0.113.7), a range (203.0.113.0/24), "me" for this machine, or "*" for any address.');
  }
  return match[5] === undefined ? `${value}/32` : value;
}

/** The AppHost `aspire` commands target: --apphost, else apphost.mts / apphost.ts in this directory. */
function locateAppHost(ctx: Context): string {
  const explicit = ctx.options.apphost;
  if (typeof explicit === "string") {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new UsageError(`No AppHost at ${explicit}.`);
    return path;
  }
  for (const candidate of ["apphost.mts", "apphost.ts"]) {
    const path = resolve(candidate);
    if (existsSync(path)) return path;
  }
  throw new UsageError("No AppHost here.", "Run this from the directory with your apphost.mts, or pass --apphost <path>.");
}

function resourceName(ctx: Context): string {
  const name = typeof ctx.options.name === "string" ? ctx.options.name : "copilot";
  if (!RESOURCE_NAME.test(name)) throw new UsageError(`"${name}" is not a Managed Copilot resource name.`, "Pass the name you gave addManagedCopilot, for example --name copilot.");
  return name;
}

function requireTool(host: HostTools, command: string, install: string): void {
  if (!host.has(command)) throw new CommandError(`${command} is not installed.`, { hint: install });
}

const INSTALL = {
  aspire: "Install the Aspire CLI 13.6: https://aspire.dev/get-started/install-cli/",
  az: "Install the Azure CLI (winget install Microsoft.AzureCLI), then run `az login`.",
  docker: "Install Docker Desktop, start it, then try again.",
};

/** The AppHost's user secrets, read and written with the Aspire CLI. Values are kept in memory, never printed. */
class AppHostSettings {
  private values: Record<string, string> = {};
  constructor(
    private readonly host: HostTools,
    readonly path: string,
  ) {}

  private args(...command: string[]): string[] {
    return ["secret", ...command, "--apphost", this.path, "--nologo", "--non-interactive"];
  }

  async load(): Promise<this> {
    const result = await this.host.capture("aspire", this.args("list", "--format", "Json"));
    if (result.code !== 0) throw new CommandError(`Could not read the AppHost's settings (aspire secret list exited with ${result.code}).`, { hint: lastLine(result.stderr || result.stdout) });
    try {
      const parsed = JSON.parse(result.stdout.trim() || "{}") as Record<string, unknown>;
      this.values = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      throw new CommandError("Could not read the AppHost's settings: aspire secret list did not print JSON.", { hint: "Update the Aspire CLI to 13.6 or later." });
    }
    return this;
  }

  get(key: string): string | undefined {
    const value = this.values[key]?.trim();
    return value ? value : undefined;
  }

  /** Every non-empty setting, for passing the AppHost's own parameters on to `aspire deploy`. */
  entries(): [string, string][] {
    return Object.entries(this.values).filter(([, value]) => value.trim() !== "");
  }

  async set(key: string, value: string | undefined): Promise<void> {
    if ((value ?? "") === (this.get(key) ?? "")) return;
    const result = value ? await this.host.capture("aspire", this.args("set", key, value)) : await this.host.capture("aspire", this.args("delete", key));
    if (result.code !== 0) throw new CommandError(`Could not save ${key} (aspire exited with ${result.code}).`, { hint: lastLine(result.stderr || result.stdout) });
    if (value) this.values[key] = value;
    else delete this.values[key];
  }
}

function lastLine(text: string): string | undefined {
  return text.trim().split(/\r?\n/).filter(Boolean).at(-1);
}

interface ContainerApp {
  readonly name: string;
  /** `managed-copilot-access: public` marks an app published with `publishApp({ public: true })`. */
  readonly tags?: Readonly<Record<string, string>> | null;
  readonly properties?: { readonly managedEnvironmentId?: string; readonly configuration?: { readonly ingress?: { readonly external?: boolean; readonly fqdn?: string; readonly ipSecurityRestrictions?: readonly IpRule[] | null } | null } };
}
interface IpRule {
  readonly name: string;
  readonly ipAddressRange: string;
  readonly action: string;
}

class Azure {
  constructor(
    private readonly host: HostTools,
    readonly subscription: string,
    readonly resourceGroup: string,
  ) {}

  private scope(): string[] {
    return ["--subscription", this.subscription, "-g", this.resourceGroup];
  }

  async json<T>(args: readonly string[]): Promise<T | undefined> {
    const result = await this.host.capture("az", [...args, "-o", "json"]);
    if (result.code !== 0) return undefined;
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      return undefined;
    }
  }

  apps(): Promise<ContainerApp[] | undefined> {
    return this.json<ContainerApp[]>(["containerapp", "list", ...this.scope()]);
  }

  async gatewayUrl(name: string): Promise<string | undefined> {
    const app = await this.json<ContainerApp>(["containerapp", "show", "-n", name, ...this.scope()]);
    const fqdn = app?.properties?.configuration?.ingress?.fqdn;
    return fqdn ? `https://${fqdn}` : undefined;
  }

  /** Apps beside the gateway in its environment with external ingress (the internal egress environment is not one). */
  static siblingApps(apps: readonly ContainerApp[], gateway: string): ContainerApp[] {
    // Only the gateway's own environment: without it, nothing is in scope (never every app in the resource group).
    const environment = apps.find((app) => app.name === gateway)?.properties?.managedEnvironmentId?.toLowerCase();
    if (!environment) return [];
    return apps.filter((app) => app.name !== gateway && app.properties?.configuration?.ingress?.external && app.properties?.managedEnvironmentId?.toLowerCase() === environment);
  }

  /** Published apps: external ingress restricted to an allowlist that keeps the platform subnet (rule "platform"). */
  static publishedApps(apps: readonly ContainerApp[], gateway: string): ContainerApp[] {
    return Azure.siblingApps(apps, gateway).filter((app) => !isPublic(app) && rules(app).some((rule) => rule.name === "platform"));
  }

  /** Public apps (`publishApp({ public: true })`): open to any address, so the allowlist never applies to them. */
  static publicApps(apps: readonly ContainerApp[], gateway: string): ContainerApp[] {
    return Azure.siblingApps(apps, gateway).filter(isPublic);
  }

  /**
   * Brings one app's allowlist to `cidrs`, adding before removing so the app never opens up. Only the `allow-<n>` rules
   * `publishApp` creates are managed; "platform" and any rule added by hand stay.
   */
  async applyAllowlist(app: ContainerApp, cidrs: readonly string[]): Promise<boolean> {
    const existing = rules(app);
    const wanted = cidrs.map((cidr, index) => ({ name: `allow-${index + 1}`, cidr }));
    const base = ["containerapp", "ingress", "access-restriction"];
    for (const rule of wanted) {
      if (existing.some((current) => current.name === rule.name && current.ipAddressRange === rule.cidr)) continue;
      const result = await this.host.capture("az", [...base, "set", "-n", app.name, ...this.scope(), "--rule-name", rule.name, "--ip-address", rule.cidr, "--action", "Allow", "-o", "none"]);
      if (result.code !== 0) return false;
    }
    for (const rule of existing) {
      if (!ALLOW_RULE.test(rule.name) || wanted.some((target) => target.name === rule.name)) continue;
      const result = await this.host.capture("az", [...base, "remove", "-n", app.name, ...this.scope(), "--rule-name", rule.name, "-o", "none"]);
      if (result.code !== 0) return false;
    }
    return true;
  }
}

const ALLOW_RULE = /^allow-\d+$/;
/** The tag the Azure integration (`PublishAsManagedCopilotPublicApp`) puts on public apps. */
const ACCESS_TAG = "managed-copilot-access";

function rules(app: ContainerApp): readonly IpRule[] {
  return app.properties?.configuration?.ingress?.ipSecurityRestrictions ?? [];
}

function isPublic(app: ContainerApp): boolean {
  return app.tags?.[ACCESS_TAG] === "public";
}

function azureFor(ctx: Context, settings: AppHostSettings): Azure | undefined {
  const subscription = settings.get("Azure:SubscriptionId");
  const resourceGroup = settings.get("Azure:ResourceGroup");
  if (!subscription || !resourceGroup || !ctx.host.has("az")) return undefined;
  return new Azure(ctx.host, subscription, resourceGroup);
}

async function resolveEntries(ctx: Context, list: ListName, values: readonly string[]): Promise<string[]> {
  const kind = LISTS[list].kind;
  const entries: string[] = [];
  for (const raw of values.flatMap((value) => split(value))) {
    if (kind === "cidr") {
      if (raw === "*") entries.push("*");
      else if (raw.toLowerCase() === "me") {
        const address = await ctx.host.publicAddress();
        if (!address) throw new CommandError("Could not detect this machine's public address.", { hint: "Name the address instead, for example 203.0.113.7." });
        entries.push(`${address}/32`);
      } else entries.push(normalizeCidr(raw));
    } else if (kind === "login" && raw.toLowerCase() === "me") {
      entries.push(await ctx.host.githubLogin(await ctx.host.githubToken()));
    } else {
      const login = raw.replace(/^@/, "");
      if (!LOGIN.test(login)) throw new UsageError(`"${raw}" is not a GitHub ${kind === "org" ? "organization" : "login"}.`);
      entries.push(login);
    }
  }
  return entries;
}

function dedupe(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeList(ctx: Context, list: ListName, entries: readonly string[]): string {
  const { style } = ctx;
  if (list === "ips") {
    if (entries.length === 0) return style.dim("this machine's public address at deploy time (default)");
    if (entries.includes("*")) return style.yellow("any address");
    return entries.join(", ");
  }
  if (entries.length === 0) return style.dim("none");
  return entries.map((entry) => (LISTS[list].kind === "login" ? `@${entry}` : entry)).join(", ");
}

/** `access [<list> add|remove|set <entries...>]`: who may use a deployment, operate it, and open its apps. */
export async function access(ctx: Context): Promise<number | void> {
  const [list, action, ...values] = ctx.args;
  requireTool(ctx.host, "aspire", INSTALL.aspire);
  const name = resourceName(ctx);
  const settings = await new AppHostSettings(ctx.host, locateAppHost(ctx)).load();
  if (!list) return showAccess(ctx, settings, name);
  if (!(list in LISTS)) throw new UsageError(`Unknown list "${list}".`, `Use one of: ${ACCESS_LISTS.join(", ")}.`);
  const which = list as ListName;
  if (!action || !ACTIONS.includes(action as Action)) throw new UsageError(`Say what to do with ${list}: ${ACTIONS.join(", ")}.`, `Example: npx managed-copilot access ${list} add ${which === "ips" ? "me" : "me"}`);
  if (values.length === 0 && action !== "set") throw new UsageError(`Name what to ${action}.`, which === "ips" ? 'For example "me", 203.0.113.7, or 203.0.113.0/24.' : 'For example "me" or a GitHub login.');

  const key = LISTS[which].key(name);
  const current = split(settings.get(key));
  const entries = await resolveEntries(ctx, which, values);
  let next: string[];
  if (action === "set") next = dedupe(entries);
  else if (action === "add") {
    // Unset means "the deploying machine's address"; keep it when adding others, so nobody locks themselves out.
    let base = current;
    if (which === "ips" && current.length === 0 && !entries.includes("*")) {
      const address = await ctx.host.publicAddress();
      if (address) base = [`${address}/32`];
    }
    next = dedupe([...base, ...entries]);
  } else {
    const removing = new Set(entries.map((entry) => entry.toLowerCase()));
    next = current.filter((entry) => !removing.has(entry.toLowerCase()));
  }
  if (which === "ips" && next.includes("*") && next.length > 1) next = ["*"];

  if (which === "ips" && next.includes("*") && !current.includes("*")) {
    ctx.err(`${ctx.errStyle.yellow(ctx.errStyle.warn)} The deployed apps that aren't public act as one GitHub account, so "*" lets anyone on the Internet use them as that account.`);
    ctx.err(ctx.errStyle.dim("  To open an app that signs in its own users, publish it with public: true instead."));
    if (!ctx.yes && !(ctx.interactive && (await ctx.confirm("Open the apps to any address?")))) return 1;
  }
  if ((which === "users" || which === "orgs") && next.length === 0) {
    const other = which === "users" ? "orgs" : "users";
    if (split(settings.get(LISTS[other].key(name))).length === 0) {
      ctx.err(`${ctx.errStyle.yellow(ctx.errStyle.warn)} No platform users or orgs remain; \`aspire deploy\` refuses to deploy a platform nobody may use.`);
    }
  }

  await settings.set(key, next.join(","));
  const live = which === "ips" ? await applyLive(ctx, settings, name, next) : undefined;
  const failed = live?.status === "failed";
  if (ctx.json) {
    ctx.out(JSON.stringify({ list: which, key, entries: next, ...(live ? { live } : {}) }, null, 2));
    return failed ? 1 : 0;
  }
  const { style } = ctx;
  ctx.out(`${style.green(style.ok)} ${LISTS[which].label}: ${describeList(ctx, which, next)}${failed ? style.dim(" (saved)") : ""}`);
  if (live?.applied.length) ctx.out(style.dim(`  Applied now to ${live.applied.join(", ")}.`));
  if (live?.public?.length) ctx.out(style.dim(`  ${live.public.join(", ")} ${live.public.length === 1 ? "is" : "are"} public: open to any address, whatever this list says.`));
  if (failed) {
    ctx.err(`${ctx.errStyle.red(ctx.errStyle.fail)} ${live.reason}`);
    ctx.err(ctx.errStyle.dim("  The running apps may still admit the old addresses. Run the command again, or `npx managed-copilot deploy`."));
    return 1;
  }
  if (live?.status === "deferred" && live.reason) ctx.out(style.dim(`  ${live.reason}`));
  if (!live?.applied.length) ctx.out(style.dim("  Takes effect on the next `npx managed-copilot deploy`."));
}

interface LiveResult {
  /** applied: every published app updated; deferred: nothing to update now (the next deploy applies it); failed: an update or lookup failed. */
  readonly status: "applied" | "deferred" | "failed";
  readonly applied: string[];
  readonly failed: string[];
  readonly reason?: string;
  /** Public apps in the deployment, which the list never applies to. */
  readonly public?: string[];
}

async function applyLive(ctx: Context, settings: AppHostSettings, name: string, cidrs: readonly string[]): Promise<LiveResult | undefined> {
  const azure = azureFor(ctx, settings);
  if (!azure) return undefined;
  const deferred = (reason?: string): LiveResult => ({ status: "deferred", applied: [], failed: [], ...(reason ? { reason } : {}) });
  // "*" removes the allowlist, which only a deploy can do safely (it also drops the platform rule).
  if (cidrs.includes("*")) return deferred();
  const allowlist = cidrs.length > 0 ? cidrs : await ctx.host.publicAddress().then((address) => (address ? [`${address}/32`] : undefined));
  if (!allowlist) return deferred("Could not detect this machine's public address to apply the default now.");
  const apps = await azure.apps();
  if (!apps) return { status: "failed", applied: [], failed: [], reason: `Could not list the apps in ${azure.resourceGroup} (check \`az login\` and your access).` };
  if (!apps.some((app) => app.name === name)) return deferred(`No gateway named "${name}" in ${azure.resourceGroup} yet.`);
  const publicApps = Azure.publicApps(apps, name).map((app) => app.name);
  const open = publicApps.length > 0 ? { public: publicApps } : {};
  const published = Azure.publishedApps(apps, name);
  if (published.length === 0) return { ...deferred(`No running apps with an allowlist in ${azure.resourceGroup}.`), ...open };
  if (!ctx.json) ctx.err(ctx.errStyle.dim(`Updating ${plural(published.length, "running app")} in ${azure.resourceGroup}${ctx.errStyle.ellipsis}`));
  const applied: string[] = [];
  const failed: string[] = [];
  for (const app of published) ((await azure.applyAllowlist(app, allowlist)) ? applied : failed).push(app.name);
  if (failed.length) return { status: "failed", applied, failed, reason: `Could not update ${failed.join(", ")} now.`, ...open };
  return { status: "applied", applied, failed, ...open };
}

async function showAccess(ctx: Context, settings: AppHostSettings, name: string): Promise<void> {
  const lists = Object.fromEntries(ACCESS_LISTS.map((list) => [list, split(settings.get(LISTS[list].key(name)))])) as Record<ListName, string[]>;
  const azure = azureFor(ctx, settings);
  const apps = azure ? await azure.apps() : undefined;
  const running = apps ? Azure.publishedApps(apps, name).map((app) => ({ name: app.name, allowed: rules(app).filter((rule) => ALLOW_RULE.test(rule.name)).map((rule) => rule.ipAddressRange) })) : [];
  const openApps = apps ? Azure.siblingApps(apps, name).filter((app) => !isPublic(app) && rules(app).length === 0).map((app) => app.name) : [];
  // A public app has no rules unless someone added them by hand; show them if so.
  const publicApps = apps ? Azure.publicApps(apps, name).map((app) => ({ name: app.name, allowed: rules(app).map((rule) => rule.ipAddressRange) })) : [];
  const login = await ctx.host
    .githubToken()
    .then((token) => ctx.host.githubLogin(token))
    .catch(() => undefined);
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        { name, apphost: settings.path, ...lists, appsActAs: login ?? null, deployment: azure ? { subscription: azure.subscription, resourceGroup: azure.resourceGroup } : null, runningApps: running, openApps, publicApps },
        null,
        2,
      ),
    );
    return;
  }
  const { style } = ctx;
  const rows: [string, string, string][] = [
    ...ACCESS_LISTS.filter((list) => list !== "ips").map((list): [string, string, string] => [LISTS[list].label, describeList(ctx, list, lists[list]), list]),
    ["Apps act as", login ? `@${login} ${style.dim("(your GitHub sign-in when you deploy)")}` : style.dim("your GitHub sign-in when you deploy"), ""],
    [LISTS.ips.label, describeList(ctx, "ips", lists.ips), "ips"],
  ];
  const publicLabel = "Public apps";
  const width = Math.max(...rows.map(([label]) => label.length), publicApps.length ? publicLabel.length : 0);
  ctx.out(`${style.bold(name)} ${style.dim(`· ${basename(settings.path)}${azure ? ` · ${azure.resourceGroup}` : ""}`)}`);
  for (const [label, value] of rows) ctx.out(`${style.dim(label.padEnd(width))}  ${value}`);
  for (const app of running) ctx.out(`${style.dim("".padEnd(width))}  ${style.dim(`${app.name} now: ${app.allowed.join(", ") || "platform only"}`)}`);
  for (const app of openApps) ctx.out(`${style.dim("".padEnd(width))}  ${style.dim(`${app} now: any address`)}`);
  publicApps.forEach((app, index) => {
    ctx.out(`${style.dim((index === 0 ? publicLabel : "").padEnd(width))}  ${app.name} ${style.dim(`now: ${app.allowed.join(", ") || "any address"}`)}`);
  });
  ctx.out();
  ctx.out(style.dim("Change with: npx managed-copilot access <users|orgs|operators|operator-orgs|ips> <add|remove|set> <entries>  (\"me\" is you, or this machine for ips)"));
  if (publicApps.length) ctx.out(style.dim("Public apps sign in their own users and hold no GitHub token; the AppHost makes an app public (publishApp's public: true), not ips."));
}

interface DeploymentRecord {
  readonly directory: string;
  readonly subscription?: string;
  readonly resourceGroup?: string;
  readonly modified: number;
  /** The parameters the deployment keeps (`parameters:<name>`, lowercase); their values are never read out. */
  readonly parameters: ReadonlySet<string>;
}

/** Aspire keeps an AppHost's deployment state in `~/.aspire/deployments/<SHA-256 of its lowercased path>/<environment>.json`. */
function recordDirectory(host: HostTools, appHost: string): string {
  return join(host.deploymentsDirectory(), createHash("sha256").update(appHost.toLowerCase()).digest("hex").toUpperCase());
}

/**
 * Reads only the target and parameter names of a deployment record; the files also hold secrets, which are never read
 * out. Aspire 13.6 keeps its current state beside `production.json`, in `production.json.migration`, whose
 * `ClaimedSections` name the parameters it holds.
 */
function readRecord(directory: string): DeploymentRecord | undefined {
  const file = join(directory, "production.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { Azure?: Record<string, unknown>; Parameters?: unknown };
    const value = (key: string) => {
      const found = parsed[`Azure:${key}`] ?? parsed.Azure?.[key];
      return typeof found === "string" ? found : undefined;
    };
    const parameters = new Set(Object.keys(parsed).filter((key) => /^parameters:/i.test(key)).map((key) => key.toLowerCase()));
    if (parsed.Parameters && typeof parsed.Parameters === "object") for (const key of Object.keys(parsed.Parameters)) parameters.add(`parameters:${key}`.toLowerCase());
    for (const section of claimedSections(join(directory, "production.json.migration"))) if (/^parameters:/i.test(section)) parameters.add(section.toLowerCase());
    return { directory, subscription: value("SubscriptionId"), resourceGroup: value("ResourceGroup"), modified: statSync(file).mtimeMs, parameters };
  } catch {
    return undefined;
  }
}

function claimedSections(file: string): string[] {
  try {
    // Aspire serializes the list as a JSON string inside the JSON document.
    const { ClaimedSections: raw } = JSON.parse(readFileSync(file, "utf8")) as { ClaimedSections?: unknown };
    const sections: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(sections) ? sections.filter((section): section is string => typeof section === "string") : [];
  } catch {
    return [];
  }
}

const targets = (record: DeploymentRecord | undefined, subscription: string, resourceGroup: string) =>
  Boolean(record && record.subscription?.toLowerCase() === subscription.toLowerCase() && record.resourceGroup?.toLowerCase() === resourceGroup.toLowerCase());

/**
 * The AppHost's own parameters from its user secrets (OAuth clients and the like), as environment variables for
 * `aspire deploy`, which doesn't load user secrets. Left out: the settings this command passes itself, the apps' token,
 * the keys the platform generates for a deployment, and every parameter the deployment's record already keeps (Aspire's
 * saved deployment state wins over the environment, so it keeps its value either way). A value the caller already set in
 * this process's environment, under any spelling Aspire reads the same, wins over the user secret.
 */
function appHostParameters(ctx: Context, settings: AppHostSettings, name: string, kept: ReadonlySet<string>, own: readonly string[]): Record<string, string> {
  const skip = new Set([...own, "Parameters:app-github-token", ...GENERATED_KEYS.map((suffix) => `Parameters:${name}-${suffix}`), ...kept].map(configKey));
  // An app's key (`<name>-app-<app>-key`, from addManagedCopilot's `apps`) is generated too: each deployment makes its own.
  const appKey = new RegExp(`^parameters:${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-app-.+-key$`);
  const caller = new Set(
    Object.entries(ctx.env)
      .filter(([, value]) => value !== undefined)
      .map(([variable]) => configKey(variable)),
  );
  const parameters: Record<string, string> = {};
  for (const [key, value] of settings.entries()) {
    if (!/^Parameters:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key) || skip.has(configKey(key)) || caller.has(configKey(key)) || appKey.test(configKey(key))) continue;
    parameters[key.replace(":", "__")] = value;
  }
  return parameters;
}

/** How Aspire matches a setting: case-insensitively, `__` for `:`, and `_` for `-` in a parameter's name. */
function configKey(key: string): string {
  return key.replace(/__/g, ":").toLowerCase().replace(/_/g, "-");
}

interface AspireManifest {
  readonly resources?: Readonly<Record<string, { readonly type?: string; readonly inputs?: { readonly value?: { readonly default?: { readonly generate?: unknown } } } }>>;
}

/** The parameters an AppHost generates, as `configKey`s, or why they couldn't be read. */
type GeneratedParameters = { readonly generated: ReadonlySet<string> } | { readonly failure: string };

/**
 * The parameters the AppHost generates (`addParameterWithGeneratedValue`), from the manifest Aspire writes for it
 * (`aspire do publish-manifest`, which needs no Azure and writes no values). It runs with the environment the deployment
 * gets, minus the apps' token, so the AppHost declares the same parameters.
 *
 * Aspire's parameter step saves every value it resolves into the deployment record, so if a version ever ran it for the
 * manifest, the local values in that environment would become the deployment's. Whatever the check changes in this
 * AppHost's record (Aspire 13.6 only makes its empty directory) is put back as it was.
 */
async function generatedParameters(ctx: Context, appHost: string, env: Readonly<Record<string, string>>): Promise<GeneratedParameters> {
  const record = recordDirectory(ctx.host, appHost);
  let before: RecordSnapshot;
  try {
    before = snapshotRecord(record);
  } catch {
    return { failure: `Couldn't read this AppHost's Aspire deployment record (${record}).` };
  }
  const result = await manifestGeneratedParameters(ctx, appHost, env);
  let changed: boolean;
  try {
    changed = restoreRecord(record, before);
  } catch {
    throw new CommandError("Couldn't put this AppHost's Aspire deployment record back as it was after reading its manifest, so nothing was deployed.", {
      hint: `Check ${record}, then run \`npx managed-copilot deploy\` again.`,
    });
  }
  if (changed) ctx.err(`${ctx.errStyle.yellow(ctx.errStyle.warn)} \`aspire do publish-manifest\` changed this AppHost's Aspire deployment record; it's back as it was.`);
  return result;
}

async function manifestGeneratedParameters(ctx: Context, appHost: string, env: Readonly<Record<string, string>>): Promise<GeneratedParameters> {
  const directory = mkdtempSync(join(tmpdir(), "managed-copilot-manifest-"));
  try {
    const result = await ctx.host.capture("aspire", ["do", "publish-manifest", "--apphost", appHost, "--non-interactive", "--nologo", "-o", directory], { env });
    if (result.code !== 0) return { failure: lastLine(result.stderr || result.stdout) ?? `It exited with ${result.code}.` };
    let manifest: AspireManifest;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "aspire-manifest.json"), "utf8")) as AspireManifest;
    } catch {
      return { failure: "It didn't write a manifest that could be read." };
    }
    if (!manifest.resources || typeof manifest.resources !== "object") return { failure: "Its manifest lists no resources." };
    const generated = new Set<string>();
    for (const [name, resource] of Object.entries(manifest.resources)) {
      if (resource?.type?.startsWith("parameter.") && resource.inputs?.value?.default?.generate !== undefined) generated.add(configKey(`Parameters:${name}`));
    }
    return { generated };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A deployment record's files by relative path (they hold secrets: compared and written back, never read out), or undefined when it has no directory. */
type RecordSnapshot = ReadonlyMap<string, Buffer> | undefined;

function recordFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

function snapshotRecord(directory: string): RecordSnapshot {
  if (!existsSync(directory)) return undefined;
  return new Map(recordFiles(directory).map((file) => [file, readFileSync(join(directory, file))]));
}

/** Puts a deployment record back as the snapshot had it, and says whether anything besides an empty directory had changed. */
function restoreRecord(directory: string, before: RecordSnapshot): boolean {
  if (!existsSync(directory)) return before !== undefined && before.size > 0 ? writeRecordFiles(directory, before) : false;
  if (!before) {
    const changed = readdirSync(directory).length > 0;
    rmSync(directory, { recursive: true, force: true });
    return changed;
  }
  let changed = false;
  for (const file of recordFiles(directory)) {
    if (!before.has(file)) {
      rmSync(join(directory, file), { force: true });
      changed = true;
    }
  }
  return writeRecordFiles(directory, before) || changed;
}

function writeRecordFiles(directory: string, files: ReadonlyMap<string, Buffer>): boolean {
  let changed = false;
  for (const [file, contents] of files) {
    const path = join(directory, file);
    if (existsSync(path) && readFileSync(path).equals(contents)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { mode: 0o600 });
    changed = true;
  }
  return changed;
}

/** `az account show` output; the account's name is compared, never printed. */
interface AzAccount {
  readonly id: string;
  readonly name?: string;
  readonly tenantId?: string;
  readonly user?: { readonly name?: string };
}

function parseAccount(text: string): AzAccount | undefined {
  try {
    return JSON.parse(text) as AzAccount;
  } catch {
    return undefined;
  }
}

/**
 * When the resource group already has a deployment, deploys only if this AppHost's record made it, or, in a terminal,
 * after adopting another checkout's record for it or an explicit "deploy over it".
 */
async function guardExistingDeployment(ctx: Context, appHost: string, subscription: string, resourceGroup: string): Promise<boolean> {
  const ownDirectory = recordDirectory(ctx.host, appHost);
  const own = readRecord(ownDirectory);
  if (targets(own, subscription, resourceGroup)) return true;
  const { errStyle } = ctx;
  ctx.err(`${errStyle.yellow(errStyle.warn)} ${resourceGroup} already has a Managed Copilot deployment that this AppHost didn't make.`);
  ctx.err(errStyle.dim("  Its generated keys are in the deployment record of the checkout that deployed it. Deploying without them replaces"));
  ctx.err(errStyle.dim("  them, and the gateway can refuse to start."));
  let others: DeploymentRecord[] = [];
  try {
    const root = ctx.host.deploymentsDirectory();
    others = readdirSync(root)
      .map((name) => readRecord(join(root, name)))
      .filter((record): record is DeploymentRecord => record !== undefined && record.directory !== ownDirectory && targets(record, subscription, resourceGroup))
      .sort((a, b) => b.modified - a.modified);
  } catch {
    // No records on this machine.
  }
  const other = others[0];
  if (other && !own && existsSync(other.directory)) {
    ctx.err(errStyle.dim(`  This machine has its record from another checkout (last used ${new Date(other.modified).toLocaleString()}):`));
    ctx.err(errStyle.dim(`  ${other.directory}`));
    if (ctx.interactive && (await ctx.confirm("Use that record for this AppHost, so the deployment keeps its keys?"))) {
      cpSync(other.directory, ownDirectory, { recursive: true, errorOnExist: true, force: false });
      ctx.err(`${errStyle.green(errStyle.ok)} This AppHost now deploys with that record.`);
      return true;
    }
  } else {
    ctx.err(errStyle.dim("  Deploy from the checkout that made it, or choose another --resource-group."));
  }
  if (ctx.interactive && (await ctx.confirm("Deploy over it with new keys anyway?"))) return true;
  ctx.err(errStyle.dim("  Nothing was changed."));
  return false;
}

/** `deploy`: checks the tools, fills in missing settings, and runs `aspire deploy` with the apps' token kept out of argv. */
export async function deploy(ctx: Context): Promise<number | void> {
  const { host, style } = ctx;
  requireTool(host, "aspire", INSTALL.aspire);
  requireTool(host, "az", INSTALL.az);
  requireTool(host, "docker", INSTALL.docker);
  const name = resourceName(ctx);
  const settings = await new AppHostSettings(host, locateAppHost(ctx)).load();
  if (!ctx.yes && !ctx.interactive) throw new UsageError("deploy asks before it changes anything. Pass --yes to deploy without asking.");

  const docker = await host.capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.code !== 0) throw new CommandError("Docker isn't running.", { hint: "Start Docker Desktop, then deploy again." });
  const account = await host.capture("az", ["account", "show", "-o", "json"]);
  if (account.code !== 0) throw new CommandError("The Azure CLI isn't signed in.", { hint: "Run `az login`, then deploy again." });
  const azAccount = JSON.parse(account.stdout) as AzAccount;

  const option = (key: string) => (typeof ctx.options[key] === "string" ? (ctx.options[key] as string) : undefined);
  const subscription = option("subscription") ?? settings.get("Azure:SubscriptionId") ?? azAccount.id;
  const location = option("location") ?? settings.get("Azure:Location") ?? DEFAULT_LOCATION;
  const resourceGroup = option("resource-group") ?? settings.get("Azure:ResourceGroup") ?? DEFAULT_RESOURCE_GROUP;
  if (!SUBSCRIPTION.test(subscription)) throw new UsageError(`"${subscription}" is not an Azure subscription ID.`);
  if (!LOCATION.test(location)) throw new UsageError(`"${location}" is not an Azure region name, such as westus2.`);
  if (!RESOURCE_GROUP.test(resourceGroup)) throw new UsageError(`"${resourceGroup}" is not a valid resource group name.`);
  // `aspire deploy` signs in as the Azure CLI's current account, to the tenant of its default subscription unless told
  // otherwise (Azure:TenantId). Another subscription of that account can be in another tenant; another account's can't
  // be used without switching the Azure CLI to it, which is the caller's choice, so a configured tenant doesn't skip this.
  let tenant = settings.get("Azure:TenantId");
  if (subscription.toLowerCase() !== azAccount.id.toLowerCase()) {
    const target = await host.capture("az", ["account", "show", "--subscription", subscription, "-o", "json"]);
    const found = target.code === 0 ? parseAccount(target.stdout) : undefined;
    if (!found?.tenantId) {
      throw new CommandError(`The Azure CLI can't use subscription ${subscription}.`, {
        hint: "Check the ID with `az account list`. If it's in another tenant, sign in to that tenant too (`az login --tenant <tenant-id>`).",
      });
    }
    if (found.user?.name && azAccount.user?.name && found.user.name.toLowerCase() !== azAccount.user.name.toLowerCase()) {
      throw new CommandError(`Subscription ${subscription} belongs to another account than the Azure CLI's current one, and aspire deploy signs in as the current account.`, {
        hint: `Switch the Azure CLI to it with \`az account set --subscription ${subscription}\`, then deploy again.`,
      });
    }
    tenant ??= found.tenantId;
  }

  const token = await host.githubToken();
  const login = await host.githubLogin(token);
  const usersKey = LISTS.users.key(name);
  const operatorsKey = LISTS.operators.key(name);
  let users = split(settings.get(usersKey));
  const orgs = split(settings.get(LISTS.orgs.key(name)));
  let operators = split(settings.get(operatorsKey));
  const addedYou: string[] = [];
  if (users.length === 0 && orgs.length === 0) {
    users = [login];
    addedYou.push("platform users");
  }
  if (operators.length === 0 && split(settings.get(LISTS["operator-orgs"].key(name))).length === 0) {
    operators = [login];
    addedYou.push("operators");
  }
  const ips = split(settings.get(LISTS.ips.key(name)));
  const address = ips.length === 0 ? await host.publicAddress() : undefined;

  const azure = new Azure(host, subscription, resourceGroup);
  const existing = await azure.gatewayUrl(name);
  const subscriptionLabel = subscription === azAccount.id && azAccount.name ? `${azAccount.name} ${style.dim(`(${subscription})`)}` : subscription;
  const rows: [string, string][] = [
    ["Subscription", subscriptionLabel],
    ["Resource group", `${resourceGroup} ${style.dim(`· ${location}${existing ? " · updates the deployment there" : " · new deployment"}`)}`],
    ["Platform users", `${describeList(ctx, "users", users)}${orgs.length ? `, orgs ${orgs.join(", ")}` : ""}`],
    ["Operators", describeList(ctx, "operators", operators)],
    ["Apps act as", `@${login} ${style.dim("(your GitHub sign-in)")}`],
    [
      "Apps open to",
      `${ips.length ? describeList(ctx, "ips", ips) : address ? `${address}/32 ${style.dim("(this machine)")}` : style.dim("this machine's public address")}${style.dim("; public apps: any address")}`,
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  ctx.out(`${style.bold(`Deploying ${basename(settings.path)} to Azure`)}`);
  for (const [label, value] of rows) ctx.out(`  ${style.dim(label.padEnd(width))}  ${value}`);
  if (addedYou.length) ctx.out(style.dim(`  Added you (@${login}) to ${addedYou.join(" and ")}. Change with \`npx managed-copilot access\`.`));
  ctx.out();

  // Generated keys (sealing, platform, egress) live in Aspire's deployment record for this AppHost. A deployment made
  // from another checkout has them in that checkout's record, and a gateway given new sealing keys refuses to start.
  if (existing && !(await guardExistingDeployment(ctx, settings.path, subscription, resourceGroup))) return 1;

  // `aspire deploy` runs the AppHost as Production, where user secrets aren't loaded, so the settings this command
  // manages and the AppHost's own parameters go in as environment variables (`Parameters:x` is `Parameters__x`).
  const managed = ["Azure:SubscriptionId", "Azure:Location", "Azure:ResourceGroup", ...ACCESS_LISTS.map((list) => LISTS[list].key(name))];
  const chosen: Record<string, string | undefined> = {
    "Azure:SubscriptionId": subscription,
    "Azure:Location": location,
    "Azure:ResourceGroup": resourceGroup,
    [usersKey]: users.join(","),
    [operatorsKey]: operators.join(","),
  };
  const settingsEnv: Record<string, string> = {};
  for (const key of managed) {
    const value = (key in chosen ? chosen[key] : settings.get(key))?.trim();
    if (value) settingsEnv[key.replaceAll(":", "__")] = value;
  }
  if (tenant) settingsEnv.Azure__TenantId = tenant;

  let parameters = appHostParameters(ctx, settings, name, readRecord(recordDirectory(host, settings.path))?.parameters ?? new Set(), managed);
  if (Object.keys(parameters).length > 0) {
    // Values `aspire run` generated and kept in the user secrets (keys, webhook secrets) must never stand in for the
    // deployment's own, so ask the AppHost which parameters it generates.
    if (!ctx.json) ctx.err(ctx.errStyle.dim(`Checking which parameters the AppHost generates${ctx.errStyle.ellipsis}`));
    const generated = await generatedParameters(ctx, settings.path, { ...parameters, ...settingsEnv });
    if ("failure" in generated) {
      ctx.err(`${ctx.errStyle.yellow(ctx.errStyle.warn)} Couldn't tell which parameters the AppHost generates (\`aspire do publish-manifest\` failed), so none are passed from its user secrets.`);
      ctx.err(ctx.errStyle.dim(`  ${generated.failure}`));
      ctx.err(ctx.errStyle.dim("  Set the ones the deployment needs as Parameters__<name> in the environment, or fix the AppHost and deploy again."));
      parameters = {};
    } else {
      const own = Object.keys(parameters).filter((variable) => generated.generated.has(configKey(variable)));
      for (const variable of own) delete parameters[variable];
      if (own.length) ctx.out(style.dim(`  Generated by the AppHost, so the deployment makes its own: ${own.map((variable) => variable.slice("Parameters__".length)).join(", ")}`));
    }
  }
  const passed = Object.keys(parameters).map((variable) => variable.slice("Parameters__".length));
  if (passed.length) ctx.out(style.dim(`  Passing ${plural(passed.length, "parameter")} from the AppHost's user secrets: ${passed.join(", ")}`));
  if (!ctx.yes && !(await ctx.confirm("Deploy?"))) return 1;

  await settings.set("Azure:SubscriptionId", subscription);
  await settings.set("Azure:Location", location);
  await settings.set("Azure:ResourceGroup", resourceGroup);
  await settings.set(usersKey, users.join(","));
  await settings.set(operatorsKey, operators.join(","));

  const env: Record<string, string> = { ...parameters, ...settingsEnv, [TOKEN_PARAMETER_ENV]: token };

  const code = await host.stream("aspire", ["deploy", "--apphost", settings.path, ...(ctx.interactive ? [] : ["--non-interactive"])], { env });
  if (code !== 0) throw new CommandError(`aspire deploy failed (exit ${code}).`, { hint: "Its output above says why. Fix that, then run `npx managed-copilot deploy` again." });

  const url = (await azure.gatewayUrl(name)) ?? existing;
  const gallery = await azure.gatewayUrl("gallery");
  const deployed = await azure.apps();
  const publicUrls = (deployed ? Azure.publicApps(deployed, name) : []).flatMap((app) => {
    const fqdn = app.properties?.configuration?.ingress?.fqdn;
    return fqdn ? [`https://${fqdn}`] : [];
  });
  ctx.out();
  ctx.out(`${style.green(style.ok)} Deployed${url ? `: ${style.bold(url)}` : ""}`);
  if (gallery) ctx.out(`  Demo gallery: ${style.bold(gallery)}`);
  if (publicUrls.length) ctx.out(`  Public apps: ${publicUrls.map((publicUrl) => style.bold(publicUrl)).join(", ")} ${style.dim("(any address)")}`);
  if (url) {
    ctx.out(style.dim(`  $env:MANAGED_COPILOT_URL = "${url}"`));
    ctx.out(style.dim("  npx managed-copilot status      # check it, then `npx managed-copilot login` once for background work"));
    ctx.out(style.dim(`  npx managed-copilot console     # the operator console`));
    ctx.out(style.dim(`  npx managed-copilot access      # who may use it, operate it, and open its apps`));
  }
}
