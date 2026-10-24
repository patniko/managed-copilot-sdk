import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayConfig } from "./config.js";
import type { Database } from "./db.js";
import { Router, UpgradeRouter, type Authenticator } from "./http.js";
import type { Logger } from "./log.js";

/**
 * Services shared across modules. Each module adds its own entries with declaration merging, e.g.
 *
 * ```ts
 * declare module "../../app.js" {
 *   interface GatewayServices { sandboxes: SandboxProvider }
 * }
 * ```
 */
export interface GatewayServices {
  auth: Authenticator;
}

export interface GatewayModule {
  readonly name: string;
  register(app: GatewayApp): void | Promise<void>;
}

type Hook = () => void | Promise<void>;

export class GatewayApp {
  readonly config: GatewayConfig;
  readonly db: Database;
  readonly log: Logger;
  readonly routes = new Router();
  readonly upgrades = new UpgradeRouter();
  readonly services: Partial<GatewayServices> = {};
  readonly #startHooks: Hook[] = [];
  readonly #stopHooks: Hook[] = [];

  constructor(config: GatewayConfig, db: Database, log: Logger) {
    this.config = config;
    this.db = db;
    this.log = log;
  }

  provide<K extends keyof GatewayServices>(key: K, value: GatewayServices[K]): void {
    if (this.services[key] !== undefined) throw new Error(`Service "${String(key)}" is already provided`);
    this.services[key] = value;
  }

  /** Returns a required service, or fails with `capability_unavailable` naming it. */
  service<K extends keyof GatewayServices>(key: K): GatewayServices[K] {
    const value = this.services[key];
    if (value === undefined) throw new ManagedCopilotError("capability_unavailable", `The ${String(key)} service is not available on this gateway`);
    return value as GatewayServices[K];
  }

  /** Runs after every module registered and the HTTP server is listening. */
  onStart(hook: Hook): void {
    this.#startHooks.push(hook);
  }

  /** Runs in reverse registration order during shutdown. */
  onStop(hook: Hook): void {
    this.#stopHooks.push(hook);
  }

  async start(): Promise<void> {
    for (const hook of this.#startHooks) await hook();
  }

  async stop(): Promise<void> {
    for (const hook of [...this.#stopHooks].reverse()) {
      try {
        await hook();
      } catch (error) {
        this.log.warn("Stop hook failed", { error: (error as Error).message });
      }
    }
  }
}
