import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { run } from "@managed-copilot/cli";
import { GALLERY_PORT } from "../shared/catalog.js";
import { createGallery, type CloudLookup, type ConsoleLink } from "./gallery.js";
import { capture, findAzureGateway, isLocalUrl, normalizeGatewayUrl } from "./targets.js";

const HELP = `pnpm gallery [--cloud <gateway url>] [--port <port>] [--no-open] [--no-azure]

Opens a gallery of every demo and walkthrough, linked to your local platform and your Azure deployment.

  --cloud <url>   Your deployed gateway (https://copilot.<environment-domain>). Default: MANAGED_COPILOT_URL when it
                  isn't local, then the \`copilot\` container app the signed-in Azure CLI finds.
  --port <port>   Port for the gallery (default ${GALLERY_PORT}, plus MANAGED_COPILOT_PORT_OFFSET).
  --no-open       Don't open a browser.
  --no-azure      Don't ask the Azure CLI for a deployment.`;

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(2);
}

const OPTIONS = { cloud: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" }, "no-azure": { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;

function parse() {
  try {
    return parseArgs({ options: OPTIONS, strict: true }).values;
  } catch (error) {
    return fail(`${(error as Error).message.replace(/\. To specify a positional.*$/s, ".")}\n\n${HELP}`);
  }
}
const args = parse();
if (args.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset > 50_000) fail(`MANAGED_COPILOT_PORT_OFFSET must be a whole number from 0 to 50000 (got "${process.env.MANAGED_COPILOT_PORT_OFFSET}").`);
const port = args.port === undefined ? GALLERY_PORT + offset : Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`--port must be a port number (got "${args.port}").`);

async function lookupCloud(): Promise<CloudLookup> {
  if (args.cloud) {
    try {
      return { url: normalizeGatewayUrl(args.cloud), note: "From --cloud." };
    } catch {
      fail(`--cloud must be your gateway's URL, like https://copilot.<environment-domain> (got "${args.cloud}").`);
    }
  }
  const fromEnv = process.env.MANAGED_COPILOT_URL;
  if (fromEnv && !isLocalUrl(fromEnv)) {
    try {
      return { url: normalizeGatewayUrl(fromEnv), note: "From MANAGED_COPILOT_URL." };
    } catch {
      // Not a URL: fall through to the Azure CLI.
    }
  }
  if (args["no-azure"]) return { note: "No deployment given. Start the gallery with `--cloud https://copilot.<environment-domain>`." };
  return findAzureGateway();
}

/** A one-time console sign-in link, made by `managed-copilot console --json` with this machine's GitHub sign-in. */
async function openConsole(gatewayUrl: string): Promise<ConsoleLink> {
  let out = "";
  let err = "";
  const code = await run(["console", "--json", "--no-open", "--url", gatewayUrl], {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    env: process.env,
  });
  try {
    if (code === 0) return { url: (JSON.parse(out) as { url: string }).url };
    const { error } = JSON.parse(err) as { error: { message: string; hint?: string } };
    return { message: error.message, ...(error.hint ? { hint: error.hint } : {}) };
  } catch {
    return { message: (err || out).trim() || "The operator console didn't answer." };
  }
}

/** The repository's GitHub URL for README links, from the git remote. */
async function repoUrl(): Promise<string> {
  const remote = (await capture("git", ["-C", packageRoot, "remote", "get-url", "origin"], 5_000))?.trim();
  const match = remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return `https://github.com/${match?.[1] ?? "patniko/managed-copilot-sdk"}/blob/main/`;
}

function openInBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command, commandArgs, { stdio: "ignore", detached: true, windowsHide: true });
  child.once("error", () => process.stdout.write(`  Open ${url} in your browser.\n`));
  child.unref();
}

const address = `http://localhost:${port}`;
const handler = createGallery({
  offset,
  cloud: lookupCloud(),
  webRoot: fileURLToPath(new URL("../web", import.meta.url)),
  shotsDir: fileURLToPath(new URL("../../shots", import.meta.url)),
  repoUrl: await repoUrl(),
  openConsole,
});
const server = createServer(handler);

const listening = await new Promise<boolean>((resolve) => {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") return resolve(false);
    fail(`Couldn't start the gallery: ${error.message}`);
  });
  server.listen(port, "127.0.0.1", () => resolve(true));
});

if (!listening) {
  // Another gallery may already be running there: open it instead of failing.
  const existing = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok).catch(() => false);
  if (!existing) fail(`Port ${port} is in use by something else. Choose another with --port.`);
  process.stdout.write(`✓ The gallery is already running: ${address}\n`);
  if (!args["no-open"]) openInBrowser(address);
  process.exit(0);
}

process.stdout.write(`✓ Demo gallery: ${address}\n  Ctrl+C to stop.\n`);
if (!args["no-open"]) openInBrowser(address);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
