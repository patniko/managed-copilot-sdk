import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { TOKEN_ENVS, URL_ENV } from "@managed-copilot/protocol";
import { artifacts } from "./commands/artifacts.js";
import { login, logout, status } from "./commands/account.js";
import { consoleCommand, OPERATOR_VIEWS, operatorCommand } from "./commands/operator.js";
import { schedules, SCHEDULE_ACTIONS } from "./commands/schedules.js";
import { attach, newSession, promote, sessions } from "./commands/sessions.js";
import { connectDeployment, openInBrowser, type Context, type Deployment, type Writer } from "./context.js";
import { describeError, UsageError } from "./errors.js";
import { createStyle, type Style } from "./output.js";

export { connectDeployment, type Deployment, type ManagedApi } from "./context.js";

interface Command {
  readonly usage: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly run: (ctx: Context) => Promise<number | void>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  status: { usage: "status", summary: "Show the deployment, your account, and background sign-in", options: [], run: status },
  login: { usage: "login", summary: "Let scheduled and unattended work run as you", options: [], run: login },
  logout: { usage: "logout", summary: "Turn off background sign-in and pause dependent schedules", options: [], run: logout },
  sessions: { usage: "sessions [--environment <name>] [--state <state>] [--limit <n>]", summary: "List your sessions", options: ["environment", "state", "limit"], run: sessions },
  new: { usage: "new <environment> [--model <id>]", summary: "Start a new session and open it in Copilot CLI", options: ["model"], run: newSession },
  attach: { usage: "attach <session>", summary: "Open Copilot CLI on a live session", options: [], run: attach },
  promote: { usage: "promote <session>", summary: "Move a promotable session into its own sandbox", options: [], run: promote },
  artifacts: { usage: "artifacts <session> [--download <dir>] [--all]", summary: "List or download a session's published files", options: ["download", "all"], run: artifacts },
  schedules: {
    usage: `schedules [${SCHEDULE_ACTIONS.join("|")}] [schedule]`,
    summary: "List schedules, show runs, pause, resume, delete, or run now",
    options: ["yes"],
    run: schedules,
  },
  console: { usage: "console [--no-open]", summary: "Open the operator console in your browser, signed in as you", options: ["no-open"], run: consoleCommand },
  operator: {
    usage: `operator [${OPERATOR_VIEWS.join("|")}] [--environment <name>] [--state <state>] [--owner <login>] [--limit <n>]`,
    summary: "Show the deployment as operators see it: health, environments, every owner's sessions",
    options: ["environment", "state", "owner", "limit"],
    run: operatorCommand,
  },
};

const GLOBAL_OPTIONS = ["url", "json", "no-color", "help", "version"];

const OPTIONS = {
  url: { type: "string" },
  json: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  yes: { type: "boolean", short: "y" },
  environment: { type: "string", short: "e" },
  model: { type: "string" },
  state: { type: "string" },
  owner: { type: "string" },
  limit: { type: "string" },
  download: { type: "string" },
  all: { type: "boolean" },
  "no-open": { type: "boolean" },
} as const;

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

function help(style: Style): string {
  const width = Math.max(...Object.values(COMMANDS).map((command) => command.usage.split(" [")[0]!.length + 0));
  const commands = Object.entries(COMMANDS).map(([, command]) => {
    const head = command.usage.split(" [")[0]!;
    return `  ${style.bold(head.padEnd(width))}  ${command.summary}`;
  });
  return [
    `${style.bold("managed-copilot")} ${style.dim(version())}`,
    "Work with your Managed Copilot deployment: the local `aspire run` platform or your Azure deployment.",
    "",
    style.bold("Usage"),
    "  npx managed-copilot <command> [options]",
    "",
    style.bold("Commands"),
    ...commands,
    "",
    style.bold("Options"),
    `  --url <url>     Deployment URL ${style.dim(`(default: ${URL_ENV}, then the local AppHost)`)}`,
    "  --json          Print JSON",
    "  --no-color      Plain output (NO_COLOR works too)",
    "  -h, --help      Show help for a command",
    "  -v, --version   Show the version",
    "",
    style.dim(`You are your GitHub sign-in: ${TOKEN_ENVS.join(", ")}, or \`gh auth login\`.`),
    style.dim("Examples: npx managed-copilot new chat · npx managed-copilot sessions · npx managed-copilot attach 7f3a2c1 · npx managed-copilot console"),
  ].join("\n");
}

function commandHelp(name: string, command: Command, style: Style): string {
  return [`${style.bold("Usage")}  npx managed-copilot ${command.usage}`, "", command.summary, "", style.dim("Global options: --url <url>, --json, --no-color")].join("\n");
}

export interface CliIo {
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly stdin?: { readonly isTTY?: boolean };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly connect?: (options: { readonly url?: string }) => Promise<Deployment>;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly now?: () => number;
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

/** Runs one CLI invocation and returns its exit code: 0 success, 1 failure, 2 usage error. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  const fallbackStyle = createStyle({ isTTY: Boolean(io.stderr.isTTY), env: io.env, noColor: argv.includes("--no-color") });
  const fail = (message: string, hint?: string, code = 2) => {
    io.stderr.write(`${fallbackStyle.red(fallbackStyle.fail)} ${message}\n`);
    if (hint) io.stderr.write(`${fallbackStyle.dim(`  ${hint}`)}\n`);
    return code;
  };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return fail((error as Error).message.replace(/\. To specify a positional.*$/s, "."), "Run `npx managed-copilot --help` for usage.");
  }
  const { values, positionals } = parsed;
  const style = createStyle({ isTTY: Boolean(io.stdout.isTTY), env: io.env, noColor: values["no-color"] === true });
  const errStyle = createStyle({ isTTY: Boolean(io.stderr.isTTY), env: io.env, noColor: values["no-color"] === true });
  const [name, ...args] = positionals;

  if (values.version) {
    io.stdout.write(`${version()}\n`);
    return 0;
  }
  if (!name) {
    io.stdout.write(`${help(style)}\n`);
    return values.help ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) return fail(`Unknown command "${name}".`, "Run `npx managed-copilot --help` to see the commands.");
  if (values.help) {
    io.stdout.write(`${commandHelp(name, command, style)}\n`);
    return 0;
  }
  const allowed = new Set([...GLOBAL_OPTIONS, ...command.options]);
  const unexpected = Object.keys(values).filter((option) => !allowed.has(option));
  if (unexpected.length > 0) return fail(`${name} does not take --${unexpected[0]}.`, `Usage: npx managed-copilot ${command.usage}`);

  let deployment: Promise<Deployment> | undefined;
  const ctx: Context = {
    style,
    errStyle,
    json: values.json === true,
    yes: values.yes === true,
    interactive: Boolean(io.stdin?.isTTY && io.stdout.isTTY),
    options: values,
    args,
    now: io.now ?? Date.now,
    out: (line = "") => void io.stdout.write(`${line}\n`),
    err: (line = "") => void io.stderr.write(`${line}\n`),
    confirm: io.confirm ?? confirmOnTerminal,
    openUrl: io.openUrl ?? ((url) => openInBrowser(url)),
    deployment: () => (deployment ??= (io.connect ?? connectDeployment)({ ...(typeof values.url === "string" ? { url: values.url } : {}) })),
  };
  try {
    return (await command.run(ctx)) ?? 0;
  } catch (error) {
    const described = describeError(error);
    if (ctx.json) {
      io.stderr.write(`${JSON.stringify({ error: { code: described.code ?? "usage", message: described.message, ...(described.hint ? { hint: described.hint } : {}) } })}\n`);
    } else {
      io.stderr.write(`${errStyle.red(errStyle.fail)} ${described.message}${described.code ? errStyle.dim(` (${described.code})`) : ""}\n`);
      if (described.hint) io.stderr.write(`${errStyle.dim(`  ${described.hint}`)}\n`);
    }
    return error instanceof UsageError ? 2 : 1;
  }
}
