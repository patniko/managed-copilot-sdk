import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface FrontDeskConfig {
  readonly port: number;
  readonly host: string;
  /** The address people open Front Desk at; GitHub redirects back to `<publicUrl>/auth/github/callback`. */
  readonly publicUrl: string;
  /** Host names requests may be addressed to (DNS-rebinding protection), lowercased, without ports. */
  readonly allowedHosts: readonly string[];
  /** Front Desk's own records: accounts, sign-ins, the conversation list, and memory. Conversations live in Managed Copilot. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  readonly webRoot: string;
  /** The environment conversations of people who sign in with GitHub run in. */
  readonly environment: string;
  readonly model: string;
  /** The environment the conversations of people without GitHub run in: one that sends model calls to Foundry. */
  readonly foundryEnvironment: string;
  /** Their model (a Foundry deployment); absent: the environment's default. */
  readonly foundryModel: string | undefined;
  /** Seals the GitHub tokens Front Desk keeps (`FRONT_DESK_SEALING_KEY`; a generated file locally when unset). */
  readonly sealingKey: string | undefined;
  /** "Continue with GitHub": a GitHub OAuth app (or GitHub App) client. */
  readonly github: GitHubOAuthConfig | undefined;
  readonly githubUrl: string;
  readonly githubApiUrl: string;
  /** Local only: offer sign-in as the account this computer's GitHub CLI uses. */
  readonly localGitHubSignIn: boolean;
  /** Creating an account needs this code (`FRONT_DESK_INVITE_CODE`). */
  readonly inviteCode: string | undefined;
  /** Messages a day for each person whose model use the app pays for. */
  readonly dailyMessageLimit: number;
  /** Behind a proxy that sets X-Forwarded-For (Azure Container Apps ingress): use its last entry as the client address. */
  readonly trustProxy: boolean;
  /** Secure cookies (`__Host-` prefix) when the public URL is HTTPS. */
  readonly secureCookies: boolean;
  /** How long a person's platform connection stays open without a browser or a running turn. */
  readonly idleCloseMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Front Desk package directory");
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host) || host.endsWith(".localhost");
}

/** GitHub endpoints are HTTPS; plain HTTP only for loopback test doubles. */
function githubEndpoint(value: string | undefined, fallback: string, name: string): string {
  const text = value?.trim() || fallback;
  const url = new URL(text);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${name} must be an https:// URL (plain http only for a loopback test server).`);
  }
  return url.toString().replace(/\/+$/, "");
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a whole number (got "${value}").`);
  return parsed;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): FrontDeskConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const port = Number(env.PORT ?? 7450);
  const publicUrl = new URL(env.FRONT_DESK_PUBLIC_URL?.trim() || `http://localhost:${port}`).toString().replace(/\/+$/, "");
  const publicHost = new URL(publicUrl).hostname.toLowerCase();
  const extraHosts = (env.FRONT_DESK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/:\d+$/, ""))
    .filter(Boolean);
  const clientId = env.FRONT_DESK_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.FRONT_DESK_GITHUB_CLIENT_SECRET?.trim();
  const deployed = env.FRONT_DESK_DEPLOYED === "1";
  const environment = env.FRONT_DESK_ENVIRONMENT?.trim() || "front-desk";
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    publicUrl,
    allowedHosts: [...new Set(["localhost", "127.0.0.1", "::1", publicHost, ...extraHosts])],
    dataDir: resolve(env.FRONT_DESK_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.FRONT_DESK_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    environment,
    model: env.FRONT_DESK_MODEL?.trim() || "claude-sonnet-5",
    foundryEnvironment: env.FRONT_DESK_FOUNDRY_ENVIRONMENT?.trim() || `${environment}-foundry`,
    foundryModel: env.FRONT_DESK_FOUNDRY_MODEL?.trim() || undefined,
    sealingKey: env.FRONT_DESK_SEALING_KEY?.trim() || undefined,
    github: clientId && clientSecret ? { clientId, clientSecret } : undefined,
    githubUrl: githubEndpoint(env.FRONT_DESK_GITHUB_URL, "https://github.com", "FRONT_DESK_GITHUB_URL"),
    githubApiUrl: githubEndpoint(env.FRONT_DESK_GITHUB_API_URL, "https://api.github.com", "FRONT_DESK_GITHUB_API_URL"),
    // Never in a deployed app: only a loopback app on the developer's own machine, and only if not turned off.
    localGitHubSignIn: !deployed && isLoopbackHost(publicHost) && env.FRONT_DESK_LOCAL_SIGNIN !== "0",
    inviteCode: env.FRONT_DESK_INVITE_CODE?.trim() || undefined,
    dailyMessageLimit: positiveInt(env.FRONT_DESK_DAILY_LIMIT, 50, "FRONT_DESK_DAILY_LIMIT"),
    trustProxy: env.FRONT_DESK_TRUST_PROXY === "1",
    secureCookies: publicUrl.startsWith("https://"),
    idleCloseMs: positiveInt(env.FRONT_DESK_IDLE_CLOSE_MS, 10 * 60_000, "FRONT_DESK_IDLE_CLOSE_MS"),
  };
}
