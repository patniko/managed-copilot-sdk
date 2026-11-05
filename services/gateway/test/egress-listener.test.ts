import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EGRESS_ROUTES } from "@managed-copilot/protocol";
import { GatewayApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { EgressListener, isLoopbackHost } from "../src/modules/network/egress-listener.js";

const log = createLogger("test", "error");
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function gatewayApp(port: number): GatewayApp {
  const db = openDatabase(":memory:");
  const app = new GatewayApp({ port } as GatewayConfig, db, log);
  app.routes.post(EGRESS_ROUTES.hello, () => ({ hello: true }), { auth: "none" });
  app.routes.get("/v1/info", () => ({ info: true }), { auth: "none" });
  cleanup.push(async () => db.close());
  return app;
}

function listener(app: GatewayApp): EgressListener {
  const egress = new EgressListener(app, log);
  cleanup.push(() => egress.close());
  return egress;
}

async function occupy(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("EgressListener", () => {
  it("serves the egress routes on the gateway's port and nothing else", async () => {
    const { server, port: free } = await occupy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const port = await listener(gatewayApp(free)).listen("127.0.0.1");
    expect(port).toBe(free);

    const hello = await fetch(`http://127.0.0.1:${port}${EGRESS_ROUTES.hello}`, { method: "POST", body: "{}" });
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ hello: true });

    for (const path of ["/v1/info", "/internal/egress/v1/../../../v1/info", "/internal/egress/v1/%2e%2e/%2e%2e/%2e%2e/v1/info", "/"]) {
      const refused = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(refused.status, path).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("moves to another port when the gateway's port is taken on that address", async () => {
    const { port: taken } = await occupy();
    const port = await listener(gatewayApp(taken)).listen("127.0.0.1");
    expect(port).toBeTypeOf("number");
    expect(port).not.toBe(taken);
    expect((await fetch(`http://127.0.0.1:${port}${EGRESS_ROUTES.hello}`, { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("returns the same port for the same address, and undefined for an address that isn't this machine's", async () => {
    const egress = listener(gatewayApp(0));
    const port = await egress.listen("127.0.0.1");
    expect(await egress.listen("127.0.0.1")).toBe(port);
    // TEST-NET-1 (RFC 5737) is never assigned to a local interface.
    expect(await listener(gatewayApp(0)).listen("192.0.2.1")).toBeUndefined();
  });

  it("stops serving once closed", async () => {
    const egress = listener(gatewayApp(0));
    const port = await egress.listen("127.0.0.1");
    await egress.close();
    await expect(fetch(`http://127.0.0.1:${port}${EGRESS_ROUTES.hello}`, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("isLoopbackHost", () => {
  it("recognizes loopback-only listen hosts", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "172.17.0.1"]) expect(isLoopbackHost(host), host).toBe(false);
  });
});
