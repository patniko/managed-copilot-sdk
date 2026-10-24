import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  discoveryFile,
  ManagedCopilotError,
  ROUTES,
  TOKEN_ENVS,
  URL_ENV,
  type AccountInfo,
  type DeploymentInfo,
  type DiscoveryRecord,
} from "@managed-copilot/protocol";
import { HttpClient } from "./http.js";
import type { ConnectOptions, ManagedContext } from "./types.js";

const execFileAsync = promisify(execFile);

/** Explicit option, then `MANAGED_COPILOT_URL`, then the discovery record written by a running local AppHost. */
export async function resolveUrl(explicit?: string): Promise<string> {
  const fromEnv = process.env[URL_ENV];
  if (explicit) return explicit;
  if (fromEnv) return fromEnv;
  let record: DiscoveryRecord;
  try {
    record = JSON.parse(await readFile(discoveryFile(), "utf8")) as DiscoveryRecord;
  } catch {
    throw new ManagedCopilotError(
      "capability_unavailable",
      `No Managed Copilot deployment found. Start the local platform with \`aspire run\`, or pass { url } / set ${URL_ENV}.`,
    );
  }
  return record.url;
}

/** Explicit token, then the documented environment variables, then the signed-in GitHub CLI. */
export async function resolveToken(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const name of TOKEN_ENVS) {
    const value = process.env[name];
    if (value) return value;
  }
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new ManagedCopilotError(
    "authentication_required",
    `Sign in with GitHub first: pass { gitHubToken }, set ${TOKEN_ENVS.join(" or ")}, or run \`gh auth login\`.`,
  );
}

export async function createContext(options: ConnectOptions = {}): Promise<ManagedContext> {
  const url = await resolveUrl(options.url);
  const token = await resolveToken(options.gitHubToken);
  const http = new HttpClient(url, token);
  const [info, account] = await Promise.all([http.get<DeploymentInfo>(ROUTES.info), http.get<AccountInfo>(ROUTES.me)]);
  return {
    url: http.baseUrl,
    token,
    clientName: options.clientName,
    info,
    account,
    http,
    clients: new Set(),
    listeners: new Map(),
    disposables: new Set(),
  };
}

export function notImplemented(feature: string): never {
  throw new ManagedCopilotError("capability_unavailable", `${feature} is not available in this build of @managed-copilot/sdk yet.`);
}
