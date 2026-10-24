import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { SessionConfig } from "@github/copilot-sdk";
import { ManagedCopilotError } from "@managed-copilot/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { isRetryable, Platform, reconnectDelay } from "../src/server/platform.js";
import { FACTORY_ENVIRONMENTS, ROLE_AGENTS, ROLES } from "../src/shared/environments.js";
import type { PlatformState, PlatformStatus } from "../src/shared/types.js";

const INFO = {
  name: "copilot",
  version: "0.0.0-test",
  mode: "local",
  capabilities: ["shared", "events", "isolated", "files", "artifacts"],
  environments: ROLES.map((role) => ({
    name: FACTORY_ENVIRONMENTS[role],
    type: role === "builder" || role === "release" ? "isolated" : "shared",
    network: { access: "disabled", allowedDomains: [] },
    scheduling: false,
    agents: [ROLE_AGENTS[role]],
  })),
  sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
};

type Mode = "healthy" | "standby" | "hang";

/**
 * A stand-in gateway behind its lease supervisor. `standby` answers like a replica that handed over (503 with
 * Connection: close); `hang` holds requests open like the ingress that held one for 240 s during a handover.
 */
class FakeGateway {
  mode: Mode = "healthy";
  url = "";
  /** Connect attempts (`GET /v1/info`) turned away while on standby. */
  rejectedConnects = 0;
  readonly held: string[] = [];
  /** WebSocket upgrades (each a client's bridge connecting); `holdUpgrades` leaves them unanswered. */
  upgrades = 0;
  holdUpgrades = false;
  #standbyConnects = 0;
  readonly #responses: ServerResponse[] = [];
  readonly #sockets: Duplex[] = [];
  readonly #server: Server;

  constructor() {
    this.#server = createServer((req, res) => this.#handle(req, res));
    // Bridges (model discovery, sessions) are turned away or held: these tests don't need a live runtime. A bridge
    // exits as soon as it reads the answer, which can reset the connection.
    this.#server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
      this.upgrades++;
      socket.on("error", () => undefined);
      if (this.holdUpgrades) {
        this.#sockets.push(socket);
        return;
      }
      socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    });
  }

  /** The serving replica hands over: everything gets standby answers until `connects` connect attempts were turned away. */
  handover(connects: number): void {
    this.mode = "standby";
    this.#standbyConnects = connects;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve()));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.#responses) res.destroy();
    for (const socket of this.#sockets) socket.destroy();
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (this.mode === "hang") {
      this.held.push(path);
      this.#responses.push(res);
      return;
    }
    if (this.mode === "standby") {
      if (path === "/v1/info") {
        this.rejectedConnects++;
        if (--this.#standbyConnects <= 0) this.mode = "healthy";
      }
      res.writeHead(503, { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store", connection: "close" });
      res.end(
        JSON.stringify({
          error: { code: "capability_unavailable", message: "The gateway is not serving on this instance yet: handed over to a newer deployment. Retry shortly." },
          status: "standby",
        }),
      );
      return;
    }
    const body = path === "/v1/info" ? INFO : path === "/v1/me" ? { id: 1, login: "octocat" } : path === "/v1/sessions" ? [] : undefined;
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: { code: "not_found", message: "Not found" } }));
  }
}

const TIMINGS = { retryBaseMs: 20, retryMaxMs: 200, connectTimeoutMs: 500, healthTimeoutMs: 300, discoveryTimeoutMs: 5_000, stopTimeoutMs: 500 };

let gateway: FakeGateway | undefined;
let platform: Platform | undefined;

afterEach(async () => {
  await platform?.stop();
  await gateway?.stop();
  platform = undefined;
  gateway = undefined;
});

async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connected(
  options: { holdUpgrades?: boolean; timings?: Partial<typeof TIMINGS> } = {},
): Promise<{ platform: Platform; gateway: FakeGateway; seen: PlatformStatus[]; states: PlatformState[] }> {
  gateway = new FakeGateway();
  gateway.holdUpgrades = options.holdUpgrades ?? false;
  await gateway.start();
  platform = new Platform(
    { ...loadConfig({}), healthIntervalMs: 50 },
    { url: gateway.url, gitHubToken: "gho_test", timings: { ...TIMINGS, ...options.timings } },
  );
  const seen: PlatformStatus[] = [];
  const states: PlatformState[] = [];
  platform.onStatus((status) => {
    seen.push(status);
    if (states.at(-1) !== status.state) states.push(status.state);
  });
  platform.start();
  const current = platform;
  await until(() => current.status.state === "connected", "the first connection");
  return { platform, gateway, seen, states };
}

describe("platform connection", () => {
  it("reconnects after a gateway handover: one failed attempt (503), then a healthy gateway", async () => {
    const { platform, gateway, seen, states } = await connected();
    gateway.handover(1);
    await until(() => platform.status.state === "reconnecting", "the lost connection to be noticed");
    await until(() => platform.status.state === "connected", "the reconnection");

    expect(gateway.rejectedConnects).toBe(1);
    expect(states).toEqual(["connected", "reconnecting", "connected"]);
    const reconnecting = seen.filter((status) => status.state === "reconnecting");
    expect(reconnecting.every((status) => !status.features.runs)).toBe(true);
    expect(reconnecting.at(-1)!.hint).toMatch(/handed over to a newer deployment/);
    // The floor keeps showing what it was connected to.
    expect(reconnecting.at(-1)!.account?.login).toBe("octocat");
    expect(platform.status.features.runs).toBe(true);
  });

  it("abandons a request held open in front of the gateway instead of waiting for it", async () => {
    const { platform, gateway, seen } = await connected();
    gateway.mode = "hang";
    await until(() => platform.status.state === "reconnecting", "the unanswered health checks to be noticed");
    await until(() => gateway.held.filter((path) => path === "/v1/info").length >= 2, "a new connect attempt while the first is still held");
    gateway.mode = "healthy";
    await until(() => platform.status.state === "connected", "the reconnection");

    expect(seen.some((status) => status.state === "reconnecting" && /took longer than/.test(status.hint ?? ""))).toBe(true);
  });

  it("verify() reports a dead connection and starts reconnecting", async () => {
    const { platform, gateway } = await connected();
    expect(await platform.verify()).toBe(true);
    gateway.handover(Number.POSITIVE_INFINITY);
    expect(await platform.verify()).toBe(false);
    expect(platform.status.state).toBe("reconnecting");
    gateway.mode = "healthy";
    await until(() => platform.status.state === "connected", "the reconnection");
  });

  it("doesn't let a client that never starts hold back later sessions", async () => {
    const { platform, gateway } = await connected({ holdUpgrades: true, timings: { discoveryTimeoutMs: 300 } });
    // Model discovery's client never got an answer and was abandoned at its deadline.
    expect(gateway.upgrades).toBe(1);
    void platform.createSession("planner", {} as SessionConfig).catch(() => undefined);
    await until(() => gateway.upgrades === 2, "a fresh client for the planner session");
  });

  it("backs off exponentially with jitter, up to the cap, and retries only what retrying can fix", () => {
    const timings = { retryBaseMs: 1_000, retryMaxMs: 30_000 };
    expect(reconnectDelay(1, timings, () => 1)).toBe(1_000);
    expect(reconnectDelay(1, timings, () => 0)).toBe(500);
    expect(reconnectDelay(4, timings, () => 1)).toBe(8_000);
    expect(reconnectDelay(12, timings, () => 1)).toBe(30_000);
    expect(reconnectDelay(12, timings, () => 0)).toBe(15_000);
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
    expect(isRetryable(new ManagedCopilotError("capability_unavailable", "draining"))).toBe(true);
    expect(isRetryable(new ManagedCopilotError("upstream_unavailable", "GitHub is unreachable"))).toBe(true);
    expect(isRetryable(new ManagedCopilotError("authentication_required", "sign in"))).toBe(false);
  });
});
