/**
 * Whether a check's requirements are met. Each probe runs at most once per `pnpm qa` run and answers with nothing when
 * the requirement is met, or with the reason it isn't (shown as the check's "skipped" detail). Tokens are only ever
 * sent to the gateway being checked; they are never printed.
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { appUrl, CI_UNSET, type DemoName, type Requirement, type RunContext } from "./catalog.js";

const execFileAsync = promisify(execFile);

/** The token variables `ManagedCopilot.connect()` reads, in its order (CI_UNSET also removes the e2e opt-in). */
const TOKEN_ENVS = CI_UNSET.filter((name) => name !== "MANAGED_COPILOT_E2E");

/** Files `pnpm build` writes that the live checks run. */
const BUILT = ["libraries/protocol/dist/index.js", "libraries/sdk/dist/bridge.js", "services/gateway/dist/main.js"];

interface DeploymentInfo {
  readonly name: string;
  readonly version: string;
  readonly environments: ReadonlyArray<{ readonly name: string }>;
  readonly capabilities: readonly string[];
}

/** The gateway for a tier: `--url`, then MANAGED_COPILOT_URL, then (local only) the running AppHost's discovery record. */
export function resolveGateway(tier: RunContext["tier"], explicit: string | undefined, portOffset: number): string {
  const chosen = explicit ?? process.env.MANAGED_COPILOT_URL;
  if (chosen) return chosen.replace(/\/+$/, "");
  if (tier !== "local") return "";
  if (portOffset === 0) {
    try {
      const record = JSON.parse(readFileSync(join(process.env.MANAGED_COPILOT_HOME ?? join(homedir(), ".managed-copilot"), "local.json"), "utf8")) as { url?: unknown };
      if (typeof record.url === "string") return record.url.replace(/\/+$/, "");
    } catch {
      // No discovery record: fall back to the AppHost's fixed port.
    }
  }
  return `http://localhost:${7400 + portOffset}`;
}

function edgeInstalled(): boolean {
  const candidates =
    process.platform === "win32"
      ? [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
          .filter((base): base is string => Boolean(base))
          .map((base) => join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
      : process.platform === "darwin"
        ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];
  return candidates.some((path) => existsSync(path));
}

export class Probes {
  readonly #root: string;
  readonly #cache = new Map<string, Promise<string | undefined>>();
  #token: Promise<string | undefined> | undefined;
  readonly #info = new Map<string, Promise<DeploymentInfo | string>>();

  constructor(root: string) {
    this.#root = root;
  }

  /** The caller's GitHub token, found like `ManagedCopilot.connect()` finds it; undefined when signed out. */
  token(): Promise<string | undefined> {
    return (this.#token ??= (async () => {
      for (const name of TOKEN_ENVS) if (process.env[name]) return process.env[name];
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true, timeout: 15_000 });
        return stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    })());
  }

  /** The reasons the requirements aren't met; empty when the check can run. */
  async unmet(requirements: readonly Requirement[], ctx: RunContext): Promise<string[]> {
    const reasons: string[] = [];
    for (const requirement of requirements) {
      const key = `${requirement}@${ctx.tier}`;
      let probe = this.#cache.get(key);
      if (!probe) {
        probe = this.#probe(requirement, ctx);
        // `built` changes when the run itself builds; the rest hold for the whole run.
        if (requirement !== "built") this.#cache.set(key, probe);
      }
      const reason = await probe;
      if (reason) reasons.push(reason);
    }
    return reasons;
  }

  async #probe(requirement: Requirement, ctx: RunContext): Promise<string | undefined> {
    switch (requirement) {
      case "built": {
        const missing = BUILT.filter((file) => !existsSync(join(this.#root, file)));
        return missing.length ? "the packages aren't built: run `pnpm build` (or `pnpm qa ci`)" : undefined;
      }
      case "docker": {
        const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { windowsHide: true, timeout: 30_000, encoding: "utf8" });
        return result.status === 0 ? undefined : "Docker isn't running (`docker info` failed)";
      }
      case "github":
        return (await this.token()) ? undefined : "no GitHub sign-in: run `gh auth login`, or set GH_TOKEN";
      case "platform": {
        const info = await this.#deployment(ctx.url);
        return typeof info === "string" ? info : undefined;
      }
      case "background":
        return this.#background(ctx.url);
      case "edge":
        return edgeInstalled() ? undefined : "Microsoft Edge isn't installed";
      case "apps-domain":
        return ctx.appsDomain ? undefined : "pass `--apps-domain <environment domain>` to check the deployed demos";
      case "isolated-environment":
        return ctx.isolatedEnvironment ? undefined : "pass `--isolated-env <environment>` (one with a short idleTimeoutSeconds)";
      default:
        break;
    }
    if (requirement.startsWith("environment:")) {
      const name = requirement.slice("environment:".length);
      const info = await this.#deployment(ctx.url);
      if (typeof info === "string") return info;
      return info.environments.some((environment) => environment.name === name) ? undefined : `the deployment has no \`${name}\` environment`;
    }
    const demo = requirement.slice("app:".length) as DemoName;
    const url = appUrl(ctx, demo);
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      return undefined;
    } catch {
      return `${demo} isn't answering at ${url}`;
    }
  }

  #deployment(url: string): Promise<DeploymentInfo | string> {
    let lookup = this.#info.get(url);
    if (!lookup) {
      lookup = (async () => {
        if (!url) return "no gateway: pass `--url <gateway>` or set MANAGED_COPILOT_URL";
        const token = await this.token();
        if (!token) return "no GitHub sign-in: run `gh auth login`, or set GH_TOKEN";
        try {
          const response = await fetch(`${url}/v1/info`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
          if (!response.ok) return `${url} answered /v1/info with HTTP ${response.status}`;
          return (await response.json()) as DeploymentInfo;
        } catch (error) {
          return `the platform isn't answering at ${url} (${(error as Error).message}); start it with \`aspire run --non-interactive\``;
        }
      })();
      this.#info.set(url, lookup);
    }
    return lookup;
  }

  async #background(url: string): Promise<string | undefined> {
    const info = await this.#deployment(url);
    if (typeof info === "string") return info;
    const token = await this.token();
    try {
      const response = await fetch(`${url}/v1/credentials/background`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      const body = (await response.json()) as { active?: unknown };
      return body.active === true ? undefined : "background sign-in is off: run `npx managed-copilot login`";
    } catch (error) {
      return `could not read background sign-in (${(error as Error).message})`;
    }
  }

  /** What the run is checking, for its header: `<name> v<version> at <url>`. */
  async describe(url: string): Promise<string | undefined> {
    const info = await this.#deployment(url);
    return typeof info === "string" ? undefined : `${info.name} v${info.version} at ${url}`;
  }
}
