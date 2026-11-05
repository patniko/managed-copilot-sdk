/**
 * `pnpm qa`: runs the canonical QA checks (catalog.ts) and reports one outcome per check. docs/qa.md explains the tiers
 * and maps every flow to its checks.
 *
 *   pnpm qa                                   # the ci tier: exactly what CI runs
 *   pnpm qa e2e                               # opt-in end-to-end tests (Docker and a GitHub sign-in)
 *   pnpm qa local                             # against `aspire run`: spec snippets, walkthroughs, demo scripts
 *   pnpm qa all                               # ci, e2e, and local
 *   pnpm qa azure --url https://copilot.<domain> [--apps-domain <domain>] [--isolated-env <environment>]
 *   pnpm qa --only local.snippet-07,local.demo   # checks by ID or ID prefix, from any tier
 *   pnpm qa local --skip local.demo-software-factory
 *   pnpm qa local --list                      # what would run, and what each check needs
 *   pnpm qa --update-docs                     # rewrite the generated catalog section of docs/qa.md
 *
 * A check whose needs aren't met is skipped with the reason; --strict counts skipped checks as failures. Manual checks
 * are listed at the end for you to do by hand. The run's results go to tests/qa/.output/last-run.json.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS, TIERS, type AutomatedCheck, type Check, type Outcome, type RunContext, type Tier } from "./catalog.js";
import { need, withCatalog } from "./docs.js";
import { Probes, resolveGateway } from "./probes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const output = join(root, "tests", "qa", ".output");

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const style = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

type ResultOutcome = Outcome | "manual";
interface Result {
  readonly id: string;
  readonly tier: Tier;
  readonly title: string;
  readonly outcome: ResultOutcome;
  readonly durationMs: number;
  readonly detail?: string;
}

const SYMBOL: Record<ResultOutcome, string> = { pass: "✓", fail: "✗", skipped: "-", manual: "☐" };
const PAINT: Record<ResultOutcome, (text: string) => string> = { pass: style.green, fail: style.red, skipped: style.yellow, manual: style.cyan };

function usage(message?: string): never {
  if (message) console.error(`${style.red("✗")} ${message}\n`);
  console.error(
    [
      "Usage: pnpm qa [ci|e2e|local|azure|all ...] [options]",
      "",
      "  --only <ids>          Run only these checks (IDs or ID prefixes, comma-separated)",
      "  --skip <ids>          Leave these checks out",
      "  --list                List the selected checks and what they need, without running them",
      "  --strict              Count skipped checks as failures",
      "  --url <gateway>       The gateway for local and azure checks (default: MANAGED_COPILOT_URL, then aspire run)",
      "  --apps-domain <d>     Azure: the environment domain the demo apps answer under",
      "  --isolated-env <e>    Azure: an isolated environment for the idle-replacement qualification",
      "  --port-offset <n>     Local: the AppHost's MANAGED_COPILOT_PORT_OFFSET (default: the environment's)",
      "  --update-docs         Rewrite the generated catalog section of docs/qa.md",
      "",
      "Tiers and every check: docs/qa.md",
    ].join("\n"),
  );
  process.exit(2);
}

interface Options {
  readonly tiers: readonly Tier[];
  readonly only: readonly string[];
  readonly skip: readonly string[];
  readonly list: boolean;
  readonly strict: boolean;
  readonly updateDocs: boolean;
  readonly url: string | undefined;
  readonly appsDomain: string | undefined;
  readonly isolatedEnvironment: string | undefined;
  readonly portOffset: number;
}

function parse(argv: readonly string[]): Options {
  const tiers: Tier[] = [];
  const only: string[] = [];
  const skip: string[] = [];
  const values: Record<string, string | undefined> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") usage();
    if (["--list", "--strict", "--update-docs"].includes(arg)) {
      flags.add(arg);
      continue;
    }
    if (["--only", "--skip", "--url", "--apps-domain", "--isolated-env", "--port-offset"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) usage(`${arg} needs a value.`);
      // Commas or spaces: PowerShell passes an unquoted `a,b` as "a b".
      if (arg === "--only" || arg === "--skip") (arg === "--only" ? only : skip).push(...value.split(/[\s,]+/).filter(Boolean));
      else values[arg] = value;
      continue;
    }
    if (arg.startsWith("-")) usage(`Unknown option ${arg}.`);
    if (arg === "all") tiers.push("ci", "e2e", "local");
    else if ((TIERS as readonly string[]).includes(arg)) tiers.push(arg as Tier);
    else usage(`Unknown tier "${arg}". Use ${TIERS.join(", ")}, or all.`);
  }
  const offsetText = values["--port-offset"] ?? process.env.MANAGED_COPILOT_PORT_OFFSET ?? "0";
  const portOffset = Number(offsetText);
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 50_000) usage(`The port offset must be a whole number from 0 to 50000 (got "${offsetText}").`);
  // With --only and no tier, the IDs choose the tiers.
  const chosen = tiers.length > 0 ? tiers : only.length > 0 ? [...TIERS] : ["ci" as const];
  return {
    tiers: TIERS.filter((tier) => chosen.includes(tier)),
    only,
    skip,
    list: flags.has("--list"),
    strict: flags.has("--strict"),
    updateDocs: flags.has("--update-docs"),
    url: values["--url"],
    appsDomain: values["--apps-domain"],
    isolatedEnvironment: values["--isolated-env"],
    portOffset,
  };
}

function select(options: Options): Check[] {
  const matches = (check: Check, patterns: readonly string[]) => patterns.some((pattern) => check.id === pattern || check.id.startsWith(pattern));
  for (const pattern of [...options.only, ...options.skip]) {
    if (!CHECKS.some((check) => matches(check, [pattern]))) usage(`No check matches "${pattern}". List them with \`pnpm qa all azure --list\`.`);
  }
  return CHECKS.filter(
    (check) => options.tiers.includes(check.tier) && (options.only.length === 0 || matches(check, options.only)) && !matches(check, options.skip),
  );
}

function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/** pnpm, as the `pnpm qa` script was started (no shell, on every platform). */
function pnpmCommand(args: readonly string[]): { file: string; args: string[] } {
  const execPath = process.env.npm_execpath;
  if (!execPath || !/pnpm/i.test(basename(execPath))) {
    console.error(`${style.red("✗")} Run QA through pnpm: \`pnpm qa\` from the repository root.`);
    process.exit(2);
  }
  return /\.[cm]?js$/i.test(execPath) ? { file: process.execPath, args: [execPath, ...args] } : { file: execPath, args: [...args] };
}

/** Ends a check's whole process tree (pnpm, then the node processes it started) at once. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** How long a check that was asked to stop gets to delete what it created before it is ended. */
const GRACE_MS = 30_000;

/**
 * Asks a check to stop, so its own cleanup deletes the sessions and sandboxes it created, and ends it after the grace
 * period. On POSIX the check runs in its own process group, which gets SIGINT. On Windows a Ctrl+C in the console
 * already reached it (`signalled`); a timed-out check there can only be asked with `taskkill` (no /F).
 */
function stop(child: ChildProcess, signalled = false): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (!signalled) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T"], { stdio: "ignore", windowsHide: true });
    else {
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {
        child.kill("SIGINT");
      }
    }
  }
  const force = setTimeout(() => killTree(child), GRACE_MS);
  force.unref();
  child.once("exit", () => clearTimeout(force));
}

let current: ChildProcess | undefined;
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) {
    if (current) killTree(current);
    return;
  }
  interrupted = true;
  console.error(`\n${style.yellow("Stopping.")} The running check has ${GRACE_MS / 1000} seconds to clean up; press Ctrl+C again to end it now.`);
  if (current) stop(current, process.platform === "win32");
});

async function run(check: AutomatedCheck, ctx: RunContext, probes: Probes): Promise<Omit<Result, "id" | "tier" | "title" | "durationMs">> {
  const unmet = await probes.unmet(check.requires, ctx);
  if (unmet.length > 0) return { outcome: "skipped", detail: unmet.join("; ") };

  const command = check.command(ctx);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of command.unset ?? []) delete env[name];
  Object.assign(env, command.env);
  if (command.githubToken) {
    const token = await probes.token();
    if (token) env.GH_TOKEN = token;
  }
  rmSync(ctx.reportFile, { force: true });
  const spec = pnpmCommand(command.pnpm);
  let timedOut = false;
  const exitCode = await new Promise<number>((resolve) => {
    // No stdin: checks run unattended (snippet 13, for one, opens Copilot CLI when it has a terminal).
    const child = spawn(spec.file, spec.args, { cwd: root, env, stdio: ["ignore", "inherit", "inherit"], detached: process.platform !== "win32" });
    current = child;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child);
    }, check.timeoutMinutes * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(`${style.red("✗")} Could not start pnpm: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  current = undefined;
  if (interrupted) return { outcome: "fail", detail: "interrupted" };
  if (timedOut) return { outcome: "fail", detail: `timed out after ${check.timeoutMinutes} minutes` };
  if (check.interpret) {
    try {
      const interpreted = check.interpret(readFileSync(ctx.reportFile, "utf8"));
      if (interpreted) return exitCode === 0 || interpreted.outcome === "fail" ? interpreted : { outcome: "fail", detail: `exit code ${exitCode}` };
    } catch {
      // No report (the run stopped early): go by the exit code.
    }
  }
  return exitCode === 0 ? { outcome: "pass" } : { outcome: "fail", detail: `exit code ${exitCode}` };
}

function list(checks: readonly Check[]): void {
  for (const tier of TIERS) {
    const inTier = checks.filter((check) => check.tier === tier);
    if (inTier.length === 0) continue;
    console.log(`\n${style.bold(tier)}`);
    const width = Math.max(...inTier.map((check) => check.id.length));
    for (const check of inTier) {
      const needs = check.kind === "manual" ? "" : check.requires.map(need).filter(Boolean).join(", ");
      const cost = check.kind === "automated" && check.cost ? ` · ${check.cost}` : check.kind === "manual" ? " · by hand" : "";
      console.log(`  ${check.id.padEnd(width)}  ${check.title}${style.dim(`${needs ? ` · needs ${needs}` : ""}${cost}`)}`);
    }
  }
  console.log(style.dim(`\n${checks.length} checks. What each tier needs: docs/qa.md`));
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (options.updateDocs) {
    const file = join(root, "docs", "qa.md");
    writeFileSync(file, withCatalog(readFileSync(file, "utf8")));
    console.log(`${style.green("✓")} Updated the check catalog in docs/qa.md.`);
    return 0;
  }
  const checks = select(options);
  if (checks.length === 0) usage("No checks selected.");
  if (options.list) {
    list(checks);
    return 0;
  }

  const probes = new Probes(root);
  const gateways = new Map<Tier, string>(options.tiers.map((tier) => [tier, resolveGateway(tier, options.url, options.portOffset)]));
  console.log(style.bold(`Managed Copilot QA · ${options.tiers.join(", ")} · ${checks.length} checks`));
  for (const tier of options.tiers) {
    const url = gateways.get(tier);
    if (!url || !checks.some((check) => check.tier === tier && check.kind === "automated")) continue;
    console.log(style.dim(`  ${tier}: ${(await probes.describe(url)) ?? `${url} (not answering)`}`));
  }

  mkdirSync(join(output, "reports"), { recursive: true });
  const startedAt = new Date();
  const results: Result[] = [];
  const automated = checks.filter((check): check is AutomatedCheck => check.kind === "automated");
  for (const [index, check] of automated.entries()) {
    if (interrupted) break;
    console.log(`\n${style.cyan("━━")} ${style.bold(`[${index + 1}/${automated.length}] ${check.id}`)} ${style.dim(check.title)}`);
    const ctx: RunContext = {
      tier: check.tier,
      url: gateways.get(check.tier) ?? "",
      appsDomain: options.appsDomain,
      isolatedEnvironment: options.isolatedEnvironment,
      portOffset: options.portOffset,
      reportFile: join(output, "reports", `${check.id}.json`),
    };
    const started = Date.now();
    const result = await run(check, ctx, probes);
    const entry: Result = { id: check.id, tier: check.tier, title: check.title, durationMs: Date.now() - started, ...result };
    results.push(entry);
    console.log(`${PAINT[entry.outcome](`${SYMBOL[entry.outcome]} ${entry.outcome}`)} ${check.id} ${style.dim(duration(entry.durationMs))}${entry.detail ? ` ${style.dim(entry.detail)}` : ""}`);
  }
  for (const check of checks) {
    if (check.kind === "manual") results.push({ id: check.id, tier: check.tier, title: check.title, outcome: "manual", durationMs: 0, detail: check.steps });
  }

  console.log(`\n${style.bold("Summary")}`);
  const width = Math.max(...results.map((result) => result.id.length));
  for (const result of results.filter((entry) => entry.outcome !== "manual")) {
    const detail = result.detail ? `  ${result.outcome === "pass" ? style.dim(result.detail) : PAINT[result.outcome](result.detail)}` : "";
    console.log(`  ${PAINT[result.outcome](SYMBOL[result.outcome])} ${result.id.padEnd(width)}  ${style.dim(duration(result.durationMs).padStart(7))}${detail}`);
  }
  const manual = results.filter((result) => result.outcome === "manual");
  if (manual.length > 0) {
    console.log(`\n${style.bold("By hand")} ${style.dim("(tick these off yourself)")}`);
    for (const result of manual) console.log(`  ${style.cyan(SYMBOL.manual)} ${result.id.padEnd(width)}  ${result.title}\n  ${" ".repeat(width + 4)}${style.dim(result.detail ?? "")}`);
  }
  const count = (outcome: ResultOutcome) => results.filter((result) => result.outcome === outcome).length;
  const notRun = automated.length - results.filter((result) => result.outcome !== "manual").length;
  console.log(
    `\n  ${[
      style.green(`${count("pass")} passed`),
      count("fail") ? style.red(`${count("fail")} failed`) : "",
      count("skipped") ? style.yellow(`${count("skipped")} skipped`) : "",
      notRun ? style.red(`${notRun} not run (interrupted)`) : "",
      manual.length ? style.cyan(`${manual.length} by hand`) : "",
    ]
      .filter(Boolean)
      .join(" · ")}`,
  );

  const reportFile = join(output, "last-run.json");
  writeFileSync(
    reportFile,
    `${JSON.stringify({ startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), tiers: options.tiers, gateways: Object.fromEntries(gateways), strict: options.strict, results }, null, 2)}\n`,
  );
  console.log(style.dim(`  Results: ${relative(root, reportFile)}`));
  return count("fail") > 0 || notRun > 0 || interrupted || (options.strict && count("skipped") > 0) ? 1 : 0;
}

process.exit(await main());
