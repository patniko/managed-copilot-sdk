/**
 * Runs the egress proxy container next to a local gateway (`MANAGED_COPILOT_EGRESS=docker`): builds the image from
 * `services/egress` (the prebuilt bundle, no registry access needed), creates the instance's networks, and keeps one
 * container `${instance}-egress` running with the current configuration. The sandbox provider connects it to each
 * sandbox network with the `mc-egress` alias. Secrets reach the container only through inherited environment
 * variables, never the command line.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EGRESS_PROXY_HOST } from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";

export interface EgressSupervisorOptions {
  /** Prefix for Docker resources (`MANAGED_COPILOT_INSTANCE`, default "mc"). */
  readonly instance: string;
  /** Directory containing the egress Dockerfile and `dist/egress.mjs`. */
  readonly context: string;
  /** Gateway URL as seen from inside the container. */
  readonly gatewayUrl: () => string;
  readonly key: string;
  readonly settings: { readonly allowedPorts: readonly number[]; readonly privateHosts: readonly string[]; readonly protectedCidrs: readonly string[]; readonly blockedCidrs: readonly string[] };
  /** Additional CA certificates the proxy trusts upstream (base64 PEM is passed through the environment). */
  readonly upstreamCa?: string;
  readonly log: Logger;
  readonly docker?: string;
}

interface Run {
  readonly stdout: string;
  readonly stderr: string;
}

export class EgressSupervisor {
  readonly #options: EgressSupervisorOptions;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(options: EgressSupervisorOptions) {
    this.#options = options;
  }

  get containerName(): string {
    return `${this.#options.instance}-egress`;
  }

  get sandboxNetwork(): string {
    return `${this.#options.instance}-sandboxes`;
  }

  get wanNetwork(): string {
    return `${this.#options.instance}-egress-wan`;
  }

  get volume(): string {
    return `${this.#options.instance}-egress-data`;
  }

  #docker(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<Run> {
    return new Promise((resolve, reject) => {
      execFile(this.#options.docker ?? "docker", [...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(new Error(`docker ${args[0]} failed: ${(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`), { stderr }));
        else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }

  async #exists(args: readonly string[]): Promise<boolean> {
    try {
      await this.#docker(args);
      return true;
    } catch {
      return false;
    }
  }

  /** Starts (or restarts) supervision in the background; failures are logged, and `ensure` can be retried. */
  start(): void {
    if (this.#running || this.#stopped) return;
    this.#running = this.ensure()
      .catch((error: unknown) => {
        this.#options.log.error("The egress proxy could not start; sandboxes with network access or vault credentials will fail", { error: (error as Error).message });
      })
      .finally(() => {
        this.#running = undefined;
      });
  }

  async #image(): Promise<string> {
    const bundle = join(this.#options.context, "dist", "egress.mjs");
    const dockerfile = join(this.#options.context, "Dockerfile");
    if (!existsSync(bundle)) throw new Error(`The egress proxy is not built (${bundle} is missing). Run: pnpm --filter @managed-copilot/egress build`);
    const digest = createHash("sha256").update(readFileSync(bundle)).update(readFileSync(dockerfile)).digest("hex").slice(0, 16);
    const tag = `managed-copilot-egress:${digest}`;
    if (!(await this.#exists(["image", "inspect", tag]))) {
      this.#options.log.info("Building the egress proxy image", { tag });
      await this.#docker(["build", "--quiet", "-t", tag, this.#options.context]);
    }
    return tag;
  }

  async #network(name: string, internal: boolean): Promise<void> {
    if (await this.#exists(["network", "inspect", name])) return;
    try {
      await this.#docker(["network", "create", ...(internal ? ["--internal"] : []), "--label", `managed-copilot.instance=${this.#options.instance}`, name]);
    } catch (error) {
      if (!/already exists/i.test((error as { stderr?: string }).stderr ?? "")) throw error;
    }
  }

  /** Makes sure the image, networks, and container exist and match the current configuration. */
  async ensure(): Promise<void> {
    await this.#docker(["version", "--format", "{{.Server.Version}}"]).catch(() => {
      throw new Error("Docker is not available; start Docker Desktop to run sandboxes and the egress proxy");
    });
    const image = await this.#image();
    await this.#network(this.wanNetwork, false);
    await this.#network(this.sandboxNetwork, true);
    const settings = this.#options.settings;
    const env: Record<string, string> = {
      EGRESS_GATEWAY_URL: this.#options.gatewayUrl(),
      EGRESS_ALLOWED_PORTS: settings.allowedPorts.join(","),
      EGRESS_PRIVATE_HOSTS: settings.privateHosts.join(","),
      EGRESS_PROTECTED_CIDRS: settings.protectedCidrs.join(","),
      EGRESS_BLOCKED_CIDRS: settings.blockedCidrs.join(","),
      ...(this.#options.upstreamCa ? { EGRESS_UPSTREAM_CA_B64: this.#options.upstreamCa } : {}),
    };
    const configHash = createHash("sha256")
      .update(JSON.stringify({ image, env, key: createHash("sha256").update(this.#options.key).digest("hex") }))
      .digest("hex")
      .slice(0, 16);
    const name = this.containerName;
    let current: { running: boolean; hash: string } | undefined;
    try {
      const { stdout } = await this.#docker(["inspect", "--format", '{{.State.Running}} {{index .Config.Labels "managed-copilot.egress-config"}}', name]);
      const [running, hash] = stdout.split(" ");
      current = { running: running === "true", hash: hash ?? "" };
    } catch {
      current = undefined;
    }
    if (current?.hash === configHash) {
      if (!current.running) await this.#docker(["start", name]);
      await this.#attachHome(name);
      return;
    }
    if (current) await this.#docker(["rm", "-f", name]);
    this.#options.log.info("Starting the egress proxy container", { container: name, image });
    const inherited = { ...process.env, ...env, EGRESS_GATEWAY_KEY: this.#options.key };
    await this.#docker(
      [
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `managed-copilot.instance=${this.#options.instance}`,
        "--label",
        `managed-copilot.egress-config=${configHash}`,
        "--network",
        this.wanNetwork,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--volume",
        `${this.volume}:/var/lib/managed-copilot-egress`,
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--restart",
        "unless-stopped",
        ...Object.keys(env).flatMap((key) => ["--env", key]),
        "--env",
        "EGRESS_GATEWAY_KEY",
        image,
      ],
      inherited,
    );
    await this.#attachHome(name);
  }

  async #attachHome(name: string): Promise<void> {
    try {
      await this.#docker(["network", "connect", "--alias", EGRESS_PROXY_HOST, this.sandboxNetwork, name]);
    } catch (error) {
      if (!/already exists|already connected/i.test((error as { stderr?: string }).stderr ?? (error as Error).message)) throw error;
    }
  }

  /** Removes the container (the CA volume is kept, so sandboxes keep trusting the same CA after a restart). */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#running?.catch(() => undefined);
    await this.#docker(["rm", "-f", this.containerName]).catch(() => undefined);
  }
}
