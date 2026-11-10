import { spawn, type SpawnOptions } from "node:child_process";
import { APPS, CONSOLE, GATEWAY_APP, GATEWAY_PORT, type AppEntry, type Health, type Link } from "../shared/catalog.js";

/** The page's own route that signs a browser in to the operator console and redirects to it. */
export const consoleRoute = (target: "local" | "cloud"): string => `/open/console?target=${target}`;

/** Local URLs of the gateway and every app, from the AppHost's fixed ports. */
export function localUrls(offset = 0): { readonly gatewayUrl: string; readonly apps: Readonly<Record<string, string>> } {
  const apps: Record<string, string> = {};
  for (const app of APPS) apps[app.id] = app === CONSOLE ? consoleRoute("local") : `http://localhost:${app.port + offset}`;
  return { gatewayUrl: `http://localhost:${GATEWAY_PORT + offset}`, apps };
}

/**
 * Deployed URLs from the gateway's. `aspire deploy` gives every app https://<app>.<environment-domain>, and the gateway
 * is the `copilot` app, so the apps share its domain.
 */
export function cloudUrls(gatewayUrl: string, options: { readonly console?: boolean } = {}): { readonly gatewayUrl: string; readonly apps: Readonly<Record<string, string>> } {
  const gateway = new URL(gatewayUrl);
  const [first, ...rest] = gateway.hostname.split(".");
  const domain = first === GATEWAY_APP && rest.length > 0 ? rest.join(".") : undefined;
  const apps: Record<string, string> = {};
  for (const app of APPS) {
    if (app === CONSOLE) {
      if (options.console !== false) apps[app.id] = consoleRoute("cloud");
    } else if (domain && !app.localOnly) apps[app.id] = `${gateway.protocol}//${app.app}.${domain}`;
  }
  return { gatewayUrl: gateway.origin, apps };
}

/** Accepts `copilot.<domain>`, `https://copilot.<domain>/`, and similar; returns the origin or throws. */
export function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`"${value}" is not an http or https URL.`);
  return url.origin;
}

export function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** One health check: any answer is online, except 403 (an ingress allowlist that refuses this machine). */
export async function probe(url: string, timeoutMs = 3_000): Promise<Health> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 403) return "restricted";
    return response.status < 500 ? "online" : "offline";
  } catch {
    return "offline";
  }
}

/**
 * Health-checks every link of a target. The console's health is the gateway's. `checkAt` gives the address to check an
 * app at when it differs from its link (a hosted gallery checks apps by their names in the deployment's environment).
 */
export async function checkTarget(
  urls: { readonly gatewayUrl: string; readonly apps: Readonly<Record<string, string>> },
  checkAt?: (app: AppEntry) => string,
): Promise<{ readonly gateway: Health; readonly links: Record<string, Link> }> {
  const gatewayCheck = probe(new URL(CONSOLE.healthPath, urls.gatewayUrl).toString());
  const entries = await Promise.all(
    APPS.filter((app) => urls.apps[app.id]).map(async (app): Promise<[string, Link]> => {
      const url = urls.apps[app.id]!;
      const health = app === CONSOLE ? await gatewayCheck : await probe(new URL(app.healthPath, checkAt?.(app) ?? url).toString());
      return [app.id, { url, health }];
    }),
  );
  return { gateway: await gatewayCheck, links: Object.fromEntries(entries) };
}

/** Runs a command and returns its stdout, or undefined when it fails, is missing, or times out. */
export function capture(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    const options: SpawnOptions = { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
    try {
      // The Azure CLI is a .cmd script on Windows, so it needs a shell; its arguments are fixed strings, never input.
      child =
        process.platform === "win32" && command === "az" ? spawn([command, ...args].join(" "), { ...options, shell: true }) : spawn(command, args, options);
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      // A shell ran the Azure CLI on Windows; killing the shell leaves the CLI running, so end the whole tree.
      if (process.platform === "win32" && command === "az" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("error", () => undefined);
      } else child.kill();
      child.stdout?.destroy();
      settle(undefined);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.once("error", () => settle(undefined));
    child.once("close", (code) => settle(code === 0 ? out : undefined));
  });
}

/** Finds an `aspire deploy` gateway (the `copilot` container app) with the signed-in Azure CLI. */
export async function findAzureGateway(): Promise<{ readonly url?: string; readonly note: string }> {
  const query = `[?name=='${GATEWAY_APP}'].{fqdn:properties.configuration.ingress.fqdn,group:resourceGroup}`;
  const out = await capture("az", ["containerapp", "list", "--query", process.platform === "win32" ? `"${query}"` : query, "-o", "json"], 60_000);
  if (out === undefined) return { note: "The Azure CLI isn't installed or signed in (`az login`), so no deployment was found." };
  let found: { fqdn?: string; group?: string }[];
  try {
    found = JSON.parse(out) as { fqdn?: string; group?: string }[];
  } catch {
    return { note: "The Azure CLI answered with something unexpected, so no deployment was found." };
  }
  const first = found.find((app) => app.fqdn);
  if (!first) return { note: "No Managed Copilot deployment in your Azure subscription. Deploy one with `aspire deploy`." };
  const others = found.length > 1 ? ` (${found.length - 1} more in the subscription; choose one with --cloud)` : "";
  return { url: `https://${first.fqdn}`, note: `Found with the Azure CLI in resource group ${first.group}${others}.` };
}
