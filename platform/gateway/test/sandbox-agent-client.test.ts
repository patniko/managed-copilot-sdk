import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SandboxAgentClient } from "../src/modules/sandbox/agent-client.js";

const servers: { server: Server; sockets: WebSocketServer }[] = [];

/** A sandboxd stand-in that accepts every WebSocket; `autoPong: false` models a link that stopped carrying frames. */
async function sandboxd(autoPong: boolean): Promise<SandboxAgentClient> {
  const server = createServer();
  const sockets = new WebSocketServer({ server, autoPong });
  servers.push({ server, sockets });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return new SandboxAgentClient(async () => ({ url, headers: {} }), "test-key");
}

/** Whether the stream closes within `ms` while it is read, as core's transport reads every runtime stream. */
function closedWithin(stream: Duplex, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (stream.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    stream.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
    stream.resume();
  });
}

describe("SandboxAgentClient streams", () => {
  afterEach(async () => {
    for (const { server, sockets } of servers.splice(0)) {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes a stream whose link stops answering pings, so a dead path never holds a runtime connection open", async () => {
    const client = await sandboxd(false);
    const stream = await client.openStream("/v1/runtime", undefined, { keepaliveMs: 50 });
    expect(await closedWithin(stream, 2_000)).toBe(true);
  });

  it("keeps a stream whose link answers pings", async () => {
    const client = await sandboxd(true);
    const stream = await client.openStream("/v1/runtime", undefined, { keepaliveMs: 50 });
    expect(await closedWithin(stream, 500)).toBe(false);
    stream.destroy();
  });
});
