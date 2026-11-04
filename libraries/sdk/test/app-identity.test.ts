// An app's connection acts for its own users and for people who signed in with GitHub (spec section 2, "Your app's own
// users"): each request carries exactly that person's credentials, and what the gateway would refuse fails early.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_KEY_ENV, APP_KEY_HEADER, APP_USER_HEADER, APP_USER_NAME_HEADER, BRIDGE_ENV, BRIDGE_SUBPROTOCOL } from "@managed-copilot/protocol";
import { WebSocketServer } from "ws";
import { ManagedCopilot } from "../src/index.js";

const BRIDGE = fileURLToPath(new URL("../src/bridge.ts", import.meta.url));
const APP_KEY = "app-key-for-tests";
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("app connections", () => {
  let server: Server;
  let url: string;
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const lastTo = (path: string) => seen.filter((request) => request.path.split("?")[0] === path).at(-1)!.headers;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      res.setHeader("content-type", "application/json");
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/info") {
        res.end(
          JSON.stringify({
            name: "copilot",
            version: "test",
            environments: [
              { name: "support", type: "shared", inference: { foundry: "contoso" }, models: ["grok-4.7"] },
              { name: "chat", type: "shared" },
            ],
            capabilities: ["apps", "foundry"],
          }),
        );
        return;
      }
      if (path === "/v1/me") {
        const user = req.headers[APP_USER_HEADER];
        if (typeof user === "string") {
          const id = decodeURIComponent(user);
          res.end(JSON.stringify({ id: -1, login: `front-desk/${id}`, kind: "app-user", app: "front-desk", userId: id }));
        } else if (req.headers.authorization) {
          res.end(JSON.stringify({ id: 7, login: "octo" }));
        } else {
          res.end(JSON.stringify({ id: 0, login: "front-desk", kind: "app", app: "front-desk" }));
        }
        return;
      }
      if (path === "/v1/sessions") {
        res.end("[]");
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "session_not_found", message: "No such session." } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("is the app itself, and never this machine's GitHub sign-in", async () => {
    process.env.GITHUB_TOKEN = "gho_machine_token";
    process.env[APP_KEY_ENV] = APP_KEY;
    const managed = await ManagedCopilot.connect({ url });
    expect(managed.account).toMatchObject({ kind: "app", app: "front-desk" });
    for (const path of ["/v1/info", "/v1/me"]) {
      expect(lastTo(path)[APP_KEY_HEADER]).toBe(APP_KEY);
      expect(lastTo(path).authorization).toBeUndefined();
    }
    // The app alone owns nothing: anything that acts for a person needs one.
    await expect(managed.client("support")).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/needs a person to act for/) });
    await expect(managed.createSession({ environment: "support", onPermissionRequest: () => ({ kind: "approve-once" }) } as never)).rejects.toMatchObject({ code: "invalid_request" });
    await managed.close();
  });

  it("acts for an app user with that user's headers only, and shares one view per person", async () => {
    const managed = await ManagedCopilot.connect({ url, appKey: APP_KEY });
    const zoe = await managed.as({ appUser: { id: "auth0|zoë", name: "Zoë Ångström" } });
    expect(zoe.account).toMatchObject({ kind: "app-user", userId: "auth0|zoë" });
    await zoe.sessions.list();
    const headers = lastTo("/v1/sessions");
    expect(headers[APP_KEY_HEADER]).toBe(APP_KEY);
    expect(headers[APP_USER_HEADER]).toBe(encodeURIComponent("auth0|zoë"));
    expect(headers[APP_USER_NAME_HEADER]).toBe(encodeURIComponent("Zoë Ångström"));
    expect(headers.authorization).toBeUndefined();
    expect(await managed.as({ appUser: { id: "auth0|zoë", name: "Zoë Ångström" } })).toBe(zoe);
    expect(await managed.as({ appUser: { id: "someone-else" } })).not.toBe(zoe);
    // A closed view is forgotten: the next as(...) for the same person is a fresh one.
    await zoe.close();
    const again = await managed.as({ appUser: { id: "auth0|zoë" } });
    expect(again).not.toBe(zoe);
    await again.sessions.list();

    const octo = await managed.as({ gitHubToken: "gho_signed_in_user" });
    expect(octo.account).toMatchObject({ id: 7, login: "octo" });
    await octo.sessions.list();
    expect(lastTo("/v1/sessions").authorization).toBe(["Bearer", "gho_signed_in_user"].join(" "));
    expect(lastTo("/v1/sessions")[APP_KEY_HEADER]).toBe(APP_KEY);
    expect(lastTo("/v1/sessions")[APP_USER_HEADER]).toBeUndefined();
    await managed.close();
  });

  it("resumes from a view as that view's person, never as whoever this process last saw on the session", async () => {
    const { resumeManagedSession } = await import("../src/features/client.js");
    const alice = { appKey: APP_KEY, appUser: { id: "alice" } };
    const bob = { appKey: APP_KEY, appUser: { id: "bob" } };
    // Alice's session, as the connection remembers it; Bob's view asks to resume it without naming anyone.
    const root = { identities: new Map([["s-alice", alice]]) };
    const view = { url, identity: bob, identities: root.identities, httpClients: new Map(), root, info: { environments: [] } };
    await expect(resumeManagedSession(view as never, "s-alice", {})).rejects.toThrow();
    const asked = lastTo("/v1/sessions/s-alice");
    expect(asked[APP_USER_HEADER]).toBe("bob");
  });

  it("refuses what the gateway would, before sending anything", async () => {
    const managed = await ManagedCopilot.connect({ url, appKey: APP_KEY });
    await expect(managed.as({ appUser: { id: "zoe" }, gitHubToken: "gho_x" } as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(managed.as({ appUser: { id: " padded" } })).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/whitespace/) });
    // App users have no Copilot plan: only Foundry environments.
    await expect(managed.client("chat", { appUser: { id: "zoe" } })).rejects.toMatchObject({ code: "inference_unavailable" });
    await managed.close();

    const github = await ManagedCopilot.connect({ url, gitHubToken: "gho_direct" });
    await expect(github.as({ appUser: { id: "zoe" } })).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/needs an app connection/) });
    await github.close();
  });
});

describe("bridge refusals", { timeout: 30_000 }, () => {
  it("answers requests the SDK already sent when the gateway cannot be reached", async () => {
    const child = spawn(process.execPath, [BRIDGE, "--headless", "--no-auto-update", "--stdio"], {
      env: { ...process.env, [BRIDGE_ENV]: JSON.stringify({ url: "ws://127.0.0.1:9/v1/connect", appKey: APP_KEY, appUser: { id: "zoe" }, environment: { name: "support" } }) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "connect", params: {} });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    const answer = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { id: number; error: { message: string } };
    expect(answer.id).toBe(7);
    expect(answer.error.message).toMatch(/^\[managed-copilot\] Cannot reach Managed Copilot at ws:\/\/127\.0\.0\.1:9: .+ \(capability_unavailable\)$/);
  });

  it("answers requests the SDK already sent with the gateway's refusal, instead of dropping them", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server, handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false) });
    const upgrades: IncomingHttpHeaders[] = [];
    wss.on("connection", (ws, request) => {
      upgrades.push(request.headers);
      ws.once("message", () => ws.close(4403, "inference_unavailable: App users have no GitHub Copilot plan."));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const child = spawn(process.execPath, [BRIDGE, "--headless", "--no-auto-update", "--stdio"], {
        env: {
          ...process.env,
          [BRIDGE_ENV]: JSON.stringify({
            url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/connect`,
            appKey: APP_KEY,
            appUser: { id: "zoë" },
            environment: { name: "chat" },
          }),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connect", params: {} });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      const [code] = await once(child, "exit");
      expect(code).toBe(1);
      const answer = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { id: number; error: { message: string } };
      expect(answer.id).toBe(1);
      expect(answer.error.message).toBe("[managed-copilot] Managed Copilot closed the connection: App users have no GitHub Copilot plan. (inference_unavailable)");
      expect(upgrades[0]![APP_KEY_HEADER]).toBe(APP_KEY);
      expect(upgrades[0]![APP_USER_HEADER]).toBe(encodeURIComponent("zoë"));
      expect(upgrades[0]!.authorization).toBeUndefined();
    } finally {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
