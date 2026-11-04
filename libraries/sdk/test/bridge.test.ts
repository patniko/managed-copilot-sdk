// The bridge keeps its gateway connection busy and notices a dead one: proxies in front of a deployment close
// WebSockets that carry nothing for a while (Azure Container Apps ingress after 240 s), so it pings on an interval, and
// a gateway that answers nothing for three intervals (a half-open connection) ends it with a clear error.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { BRIDGE_ENV, BRIDGE_SUBPROTOCOL, BRIDGE_WELCOME } from "@managed-copilot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

// The source itself (Node runs TypeScript without a build), so the test checks what is in the tree.
const BRIDGE = fileURLToPath(new URL("../src/bridge.ts", import.meta.url));

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A stand-in gateway that completes the bridge handshake and counts pings; `answersPings: false` is a silent one.
 * `connected` resolves with the time the bridge reached it: tests time from there, not from spawning the bridge (Node's
 * startup alone can take seconds on a loaded machine).
 */
async function fakeGateway(answersPings: boolean): Promise<{ url: string; pings: () => number; connected: Promise<number> }> {
  const server = createServer();
  const wss = new WebSocketServer({ server, autoPong: answersPings, handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false) });
  let pings = 0;
  let reached!: (at: number) => void;
  const connected = new Promise<number>((resolve) => {
    reached = resolve;
  });
  wss.on("connection", (ws) => {
    reached(Date.now());
    ws.on("ping", () => pings++);
    ws.once("message", () => ws.send(JSON.stringify({ type: BRIDGE_WELCOME, connectionId: "conn_test", environment: "chat" })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/connect`, pings: () => pings, connected };
}

function startBridge(url: string, pingMs: number): { exitCode: () => number | null; stderr: () => string; exited: Promise<unknown> } {
  const child = spawn(process.execPath, [BRIDGE, "--headless", "--no-auto-update", "--stdio"], {
    env: { ...process.env, [BRIDGE_ENV]: JSON.stringify({ url, token: "t", environment: { name: "chat" } }), MANAGED_COPILOT_BRIDGE_PING_MS: String(pingMs) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  });
  return { exitCode: () => child.exitCode, stderr: () => stderr, exited };
}

// Each test spawns a bridge process; its startup is not what they measure, so they have room for a loaded machine.
describe("bridge keepalive", { timeout: 30_000 }, () => {
  it("pings an idle gateway connection on an interval and keeps it", async () => {
    const gateway = await fakeGateway(true);
    const bridge = startBridge(gateway.url, 100);
    await gateway.connected;
    // Three 100 ms intervals; the bound leaves room for a loaded machine.
    await waitUntil(() => gateway.pings() >= 3, 10_000);
    expect(bridge.exitCode()).toBeNull();
    expect(bridge.stderr()).toBe("");
  });

  it("ends with a clear error when the gateway stops answering", async () => {
    const gateway = await fakeGateway(false);
    const bridge = startBridge(gateway.url, 100);
    const connectedAt = await gateway.connected;
    await bridge.exited;
    expect(bridge.exitCode()).toBe(1);
    // It ends after three silent 100 ms intervals; without the keepalive it would never end.
    expect(Date.now() - connectedAt).toBeLessThan(10_000);
    expect(bridge.stderr()).toContain("[managed-copilot] The connection to Managed Copilot at ws://127.0.0.1:");
    expect(bridge.stderr()).toContain("stopped responding (no answer for 300 ms).");
  });
});
