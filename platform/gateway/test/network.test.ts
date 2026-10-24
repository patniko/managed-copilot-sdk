import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EGRESS_KEY_HEADER, EGRESS_ROUTES, parseConfig, type EgressRegistration, type VaultInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaMaterial } from "../../egress/src/x509.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { SessionLedger } from "../src/modules/core/ledger.js";
import { PolicyService } from "../src/modules/network/policy.js";
import { Sealer } from "../src/modules/network/sealing.js";
import { getState, migrateNetwork } from "../src/modules/network/store.js";
import { VaultStore } from "../src/modules/network/vaults.js";
import { PromotionStore } from "../src/modules/promotion/store.js";
import { startGateway, type RunningGateway } from "../src/server.js";

const ALICE = { token: "tok-alice", id: 101, login: "alice" };
const BOB = { token: "tok-bob", id: 202, login: "bob" };
const EGRESS_KEY = "test-egress-key-0123456789";
const CA = createCaMaterial({ commonName: "Test Egress CA" }).certPem;
const bearer = (token: string) => ["Bearer", token].join(" ");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const CONFIG = {
  name: "copilot",
  vaults: {
    payments: [{ env: "STRIPE_API_KEY", value: { secretEnv: "TEST_STRIPE_KEY" }, hosts: ["api.stripe.com"] }],
    docs: [{ mcpServer: "https://mcp.contoso.example/docs", value: { secretEnv: "TEST_DOCS_TOKEN" } }],
  },
  environments: {
    chat: { type: "shared", vaults: ["docs"], network: ["learn.microsoft.com", "mcp.contoso.example"] },
    coder: { type: "isolated", vaults: ["payments"], network: ["api.stripe.com", "github.com", "*.githubusercontent.com", "contoso.atlassian.net"] },
    offline: { type: "isolated", network: false },
    helper: { type: "promotable", promoteTo: "offline" },
  },
  inline: { types: ["shared", "isolated"] },
};

function githubStub(): Server {
  return createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^(Bearer|token)\s+/i, "");
    const user = [ALICE, BOB].find((candidate) => candidate.token === token);
    if (req.url === "/user" && user) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: user.id, login: user.login }));
    } else {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
    }
  });
}

interface SseClient {
  readonly events: { event: string; data: unknown }[];
  next(event: string, predicate?: (data: never) => boolean): Promise<unknown>;
  close(): void;
}

function openStream(base: string, key: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const events: { event: string; data: unknown }[] = [];
    const waiters: (() => void)[] = [];
    const req = request(`${base}${EGRESS_ROUTES.stream}`, { headers: { [EGRESS_KEY_HEADER]: key } }, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        reject(new Error(`stream HTTP ${res.statusCode}`));
        return;
      }
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          events.push({ event, data: data ? JSON.parse(data) : undefined });
          for (const waiter of waiters.splice(0)) waiter();
        }
      });
      resolve({
        events,
        async next(event, predicate) {
          const deadline = Date.now() + 3_000;
          for (;;) {
            const index = events.findIndex((entry) => entry.event === event && (!predicate || predicate(entry.data as never)));
            if (index >= 0) return events.splice(index, 1)[0]!.data;
            if (Date.now() > deadline) throw new Error(`no ${event} event`);
            await new Promise<void>((done) => {
              waiters.push(done);
              setTimeout(done, 100);
            });
          }
        },
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("network module", () => {
  let github: Server;
  let gateway: RunningGateway;
  let base: string;
  let dataDir: string;
  let stream: SseClient;

  const call = async (method: string, path: string, user: { token: string } | undefined, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(user ? { authorization: bearer(user.token) } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown> & { error?: { code: string; message: string } }) : undefined, text };
  };
  const egress = (path: string, body: unknown, key = EGRESS_KEY) => call("POST", path, undefined, body, { [EGRESS_KEY_HEADER]: key });
  const policy = () => gateway.app.service("policy");

  beforeAll(async () => {
    github = githubStub();
    await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", () => resolve()));
    dataDir = mkdtempSync(join(tmpdir(), "mc-network-"));
    gateway = await startGateway(
      loadConfig({
        PORT: "0",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_EGRESS: "off",
        MANAGED_COPILOT_EGRESS_KEY: EGRESS_KEY,
        MANAGED_COPILOT_GITHUB_API_URL: `http://127.0.0.1:${(github.address() as { port: number }).port}`,
        MANAGED_COPILOT_CONFIG: JSON.stringify(CONFIG),
        TEST_STRIPE_KEY: "sk_test_stripe_123",
        TEST_DOCS_TOKEN: "docs-token-xyz",
      }),
    );
    base = gateway.url;
    const hello = await egress(EGRESS_ROUTES.hello, { instanceId: "test-proxy", version: "0.1.0", caCertificate: CA });
    expect(hello.status).toBe(200);
    stream = await openStream(base, EGRESS_KEY);
    await stream.next("snapshot");
  });

  afterAll(async () => {
    stream?.close();
    await gateway?.close();
    github?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("vaults created in code", () => {
    let jira: VaultInfo;

    it("creates a vault without ever returning its value", async () => {
      const created = await call("POST", "/v1/vaults", ALICE, { name: "jira-1", credentials: [{ env: "JIRA_TOKEN", value: "jira-secret-value", hosts: ["contoso.atlassian.net"] }] });
      expect(created.status).toBe(201);
      jira = created.body as unknown as VaultInfo;
      expect(jira).toMatchObject({ name: "jira-1", kind: "user", credentials: [{ env: "JIRA_TOKEN", hosts: ["contoso.atlassian.net"] }] });
      expect(created.text).not.toContain("jira-secret-value");
      const sealed = gateway.app.db.prepare("SELECT sealed FROM network_vaults WHERE id = ?").get(jira.id) as { sealed: string };
      expect(sealed.sealed).not.toContain("jira-secret-value");
      expect(sealed.sealed).toMatch(/^v1\./);
    });

    it("lists the caller's vaults and the AppHost vaults, but not other users' vaults", async () => {
      const mine = await call("GET", "/v1/vaults", ALICE);
      expect((mine.body as unknown as VaultInfo[]).map((vault) => vault.name)).toEqual(["payments", "docs", "jira-1"]);
      expect(mine.text).not.toMatch(/sk_test_stripe_123|docs-token-xyz|jira-secret-value/);
      const theirs = await call("GET", "/v1/vaults", BOB);
      expect((theirs.body as unknown as VaultInfo[]).map((vault) => vault.name)).toEqual(["payments", "docs"]);
      expect((await call("GET", `/v1/vaults/${jira.id}`, BOB)).status).toBe(404);
      expect((await call("DELETE", `/v1/vaults/${jira.id}`, BOB)).status).toBe(404);
      expect((await call("DELETE", "/v1/vaults/payments", ALICE)).status).toBe(403);
      expect((await call("GET", "/v1/vaults", undefined)).status).toBe(401);
    });

    it("validates credentials", async () => {
      const cases: [unknown, number, RegExp][] = [
        [{ name: "x", credentials: [{ env: "HTTPS_PROXY", value: "v", hosts: ["api.example.com"] }] }, 400, /reserved/],
        [{ name: "x", credentials: [{ env: "TOKEN", value: "v", hosts: ["*.example.com"] }] }, 400, /wildcards/],
        [{ name: "x", credentials: [{ env: "TOKEN", value: "v", hosts: ["10.0.0.1"] }] }, 400, /IP addresses/],
        [{ name: "x", credentials: [{ env: "TOKEN", value: "line\nbreak", hosts: ["api.example.com"] }] }, 400, /line breaks/],
        [{ name: "x", credentials: [{ env: "TOKEN", value: "v", hosts: ["api.example.com"], headers: ["host"] }] }, 400, /cannot carry/],
        [{ name: "x", credentials: [{ mcpServer: "http://mcp.example.com", value: "v" }] }, 400, /https/],
        [{ name: "x", credentials: [] }, 400, /1 to 20/],
        [{ name: "jira-1", credentials: [{ env: "TOKEN", value: "v", hosts: ["api.example.com"] }] }, 409, /already have/],
        [{ name: "payments", credentials: [{ env: "TOKEN", value: "v", hosts: ["api.example.com"] }] }, 409, /AppHost/],
      ];
      for (const [body, status, message] of cases) {
        const response = await call("POST", "/v1/vaults", ALICE, body);
        expect(response.status, JSON.stringify(body)).toBe(status);
        expect(response.body?.error?.message).toMatch(message);
      }
    });

    describe("session bindings and sandbox egress", () => {
      let registration: EgressRegistration;
      let env: Record<string, string>;

      it("binds the effective policy and the environment's and caller's vaults", () => {
        const network = policy().bindSession({ sessionId: "s-coder", owner: ALICE.id, environment: "coder", type: "isolated", requested: undefined, vaults: [jira.id] });
        expect(network).toEqual({ access: "restricted", allowedDomains: ["*.githubusercontent.com", "api.stripe.com", "contoso.atlassian.net", "github.com"] });
        expect(policy().session("s-coder")?.vaults).toEqual(["payments", jira.id]);
      });

      it("only lets callers narrow, and keeps network: false through promotion", async () => {
        expect(policy().bindSession({ sessionId: "s-narrow", owner: ALICE.id, environment: "coder", type: "isolated", requested: ["github.com", "evil.com"], vaults: undefined })).toEqual({
          access: "restricted",
          allowedDomains: ["github.com"],
        });
        expect(policy().bindSession({ sessionId: "s-off", owner: ALICE.id, environment: "offline", type: "isolated", requested: true, vaults: undefined }).access).toBe("disabled");
        expect(policy().bindSession({ sessionId: "s-inline", owner: ALICE.id, environment: "inline-isolated", type: "isolated", requested: undefined, vaults: undefined }).access).toBe("enabled");
        expect(policy().bindSession({ sessionId: "s-helper", owner: ALICE.id, environment: "helper", type: "promotable", requested: undefined, vaults: undefined }).access).toBe("enabled");
        expect(policy().promoteSession("s-helper", "offline").access).toBe("disabled");
        expect(policy().session("s-helper")).toMatchObject({ environment: "helper", promotedTo: "offline", type: "isolated", policy: { access: "disabled" } });
        expect((await call("GET", "/v1/sessions/s-helper/network", ALICE)).body).toMatchObject({ sessionId: "s-helper", environment: "helper", promotedTo: "offline", policy: { access: "disabled" } });
      });

      it("rejects vaults the caller cannot use", () => {
        expect(() => policy().bindSession({ sessionId: "s-bob", owner: BOB.id, environment: "coder", type: "isolated", requested: undefined, vaults: [jira.id] })).toThrow(/not found/);
        expect(() => policy().bindSession({ sessionId: "s-chat", owner: ALICE.id, environment: "chat", type: "shared", requested: undefined, vaults: [jira.id] })).toThrow(/shared environments cannot use/);
        expect(() => policy().bindSession({ sessionId: "s-chat", owner: ALICE.id, environment: "chat", type: "shared", requested: undefined, vaults: ["payments"] })).toThrow(/not available in environment "chat"/);
        expect(policy().session("s-bob")).toBeUndefined();
      });

      it("issues a proxy credential, placeholders, and the CA, and pushes the registration", async () => {
        const egressConfig = await policy().registerSandbox({ sandboxId: "sbx_1", sessionId: "s-coder" });
        env = { ...egressConfig.env };
        expect(egressConfig.caCertificate).toBe(new (await import("node:crypto")).X509Certificate(CA).toString());
        expect(env.HTTPS_PROXY).toMatch(/^http:\/\/sbx_1:[A-Za-z0-9_-]{43}@mc-egress:3128$/);
        expect(env.https_proxy).toBe(env.HTTPS_PROXY);
        expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
        expect(env.STRIPE_API_KEY).toMatch(/^mcv_placeholder_[0-9a-f]{40}$/);
        expect(env.JIRA_TOKEN).toMatch(/^mcv_placeholder_[0-9a-f]{40}$/);
        expect(JSON.stringify(env)).not.toMatch(/sk_test_stripe_123|jira-secret-value/);
        registration = (await stream.next("upsert", (data: EgressRegistration) => data.sandboxId === "sbx_1")) as EgressRegistration;
        const secret = /sbx_1:([^@]+)@/.exec(env.HTTPS_PROXY!)![1]!;
        expect(registration).toMatchObject({ sessionId: "s-coder", credentialHash: sha256(secret), policy: { access: "restricted" } });
        expect(registration.credentials.map((credential) => [credential.placeholder, credential.destinations, credential.headers])).toEqual([
          [env.STRIPE_API_KEY, [{ host: "api.stripe.com", port: 443 }], ["authorization"]],
          [env.JIRA_TOKEN, [{ host: "contoso.atlassian.net", port: 443 }], ["authorization"]],
        ]);
        expect(JSON.stringify(registration)).not.toMatch(/sk_test_stripe_123|jira-secret-value/);
      });

      it("authorizes each vault use with every check repeated", async () => {
        const stripe = registration.credentials.find((credential) => credential.placeholder === env.STRIPE_API_KEY)!;
        const use = { sandboxId: "sbx_1", credentialId: stripe.id, placeholder: stripe.placeholder, host: "api.stripe.com", port: 443, header: "authorization" };
        expect((await egress(EGRESS_ROUTES.secret, use)).body).toEqual({ value: "sk_test_stripe_123" });
        expect((await egress(EGRESS_ROUTES.secret, { ...use, host: "evil.example.com" })).status).toBe(403);
        expect((await egress(EGRESS_ROUTES.secret, { ...use, header: "x-api-key" })).status).toBe(403);
        expect((await egress(EGRESS_ROUTES.secret, { ...use, placeholder: env.JIRA_TOKEN })).status).toBe(403);
        expect((await egress(EGRESS_ROUTES.secret, { ...use, sandboxId: "sbx_other" })).status).toBe(403);
        expect((await egress(EGRESS_ROUTES.secret, use, "wrong-key")).status).toBe(403);
        const jiraBinding = registration.credentials.find((credential) => credential.placeholder === env.JIRA_TOKEN)!;
        const jiraUse = { sandboxId: "sbx_1", credentialId: jiraBinding.id, placeholder: jiraBinding.placeholder, host: "contoso.atlassian.net", port: 443, header: "authorization" };
        expect((await egress(EGRESS_ROUTES.secret, jiraUse)).body).toEqual({ value: "jira-secret-value" });
      });

      it("revokes a deleted vault from running sandboxes", async () => {
        expect((await call("DELETE", `/v1/vaults/${jira.id}`, ALICE)).status).toBe(204);
        const updated = (await stream.next("upsert", (data: EgressRegistration) => data.sandboxId === "sbx_1")) as EgressRegistration;
        expect(updated.credentials.map((credential) => credential.placeholder)).toEqual([env.STRIPE_API_KEY]);
        const jiraBinding = registration.credentials.find((credential) => credential.placeholder === env.JIRA_TOKEN)!;
        const response = await egress(EGRESS_ROUTES.secret, { sandboxId: "sbx_1", credentialId: jiraBinding.id, placeholder: jiraBinding.placeholder, host: "contoso.atlassian.net", port: 443, header: "authorization" });
        expect(response.status).toBe(403);
      });

      it("pins the credential to the sandbox address", async () => {
        policy().updateSandbox("sbx_1", { address: "10.213.0.18" });
        expect(await stream.next("upsert", (data: EgressRegistration) => data.sandboxId === "sbx_1" && data.address === "10.213.0.18")).toBeDefined();
      });

      it("records blocked attempts for the owning session only", async () => {
        const reported = await egress(EGRESS_ROUTES.reports, {
          reports: [{ sandboxId: "sbx_1", sessionId: "spoofed-session", at: new Date().toISOString(), reason: "host_not_allowed", host: "evil.example.com", port: 443, method: "CONNECT", message: "evil.example.com is not an allowed host" }],
        });
        expect(reported.status).toBe(204);
        const view = await call("GET", "/v1/sessions/s-coder/network", ALICE);
        expect(view.body).toMatchObject({
          sessionId: "s-coder",
          environment: "coder",
          policy: { access: "restricted" },
          vaults: [{ id: "payments", name: "payments", kind: "apphost" }],
          blocked: [{ reason: "host_not_allowed", host: "evil.example.com", sessionId: "s-coder", sandboxId: "sbx_1" }],
        });
        expect((await call("GET", "/v1/sessions/s-coder/network", BOB)).status).toBe(404);
      });

      it("rotates the credential on every registration and removes it on unregister", async () => {
        const again = await policy().registerSandbox({ sandboxId: "sbx_1", sessionId: "s-coder" });
        expect(again.env.HTTPS_PROXY).not.toBe(env.HTTPS_PROXY);
        expect(again.env.STRIPE_API_KEY).toBe(env.STRIPE_API_KEY);
        const rotated = (await stream.next("upsert", (data: EgressRegistration) => data.sandboxId === "sbx_1" && data.credentialHash !== registration.credentialHash)) as EgressRegistration;
        expect(rotated.revision).toBeGreaterThan(registration.revision);
        policy().unregisterSandbox("sbx_1");
        expect(await stream.next("remove", (data: { sandboxId: string }) => data.sandboxId === "sbx_1")).toEqual({ sandboxId: "sbx_1" });
        const stripe = registration.credentials.find((credential) => credential.placeholder === env.STRIPE_API_KEY)!;
        expect((await egress(EGRESS_ROUTES.secret, { sandboxId: "sbx_1", credentialId: stripe.id, placeholder: stripe.placeholder, host: "api.stripe.com", port: 443, header: "authorization" })).status).toBe(403);
      });

      it("refuses sandboxes for shared or unbound sessions", async () => {
        await expect(policy().registerSandbox({ sandboxId: "sbx_x", sessionId: "never-bound" })).rejects.toThrow(/no network binding/);
        policy().bindSession({ sessionId: "s-shared", owner: ALICE.id, environment: "chat", type: "shared", requested: undefined, vaults: undefined });
        await expect(policy().registerSandbox({ sandboxId: "sbx_y", sessionId: "s-shared" })).rejects.toThrow(/shared session/);
        await expect(policy().registerSandbox({ sandboxId: "bad id!", sessionId: "s-coder" })).rejects.toThrow(/sandboxId/);
      });

      it("lets offline sandboxes start without waiting for egress", async () => {
        const offline = await policy().registerSandbox({ sandboxId: "sbx_off", sessionId: "s-off" });
        expect(offline.policy.access).toBe("disabled");
        expect((await stream.next("upsert", (data: EgressRegistration) => data.sandboxId === "sbx_off")) as EgressRegistration).toMatchObject({ policy: { access: "disabled" }, credentials: [] });
      });

      it("releases everything when the session is deleted", async () => {
        policy().releaseSession("s-off");
        expect(await stream.next("remove", (data: { sandboxId: string }) => data.sandboxId === "sbx_off")).toBeDefined();
        expect(policy().session("s-off")).toBeUndefined();
      });
    });
  });

  it("gives shared sessions vault MCP headers only through the adapter", () => {
    policy().bindSession({ sessionId: "s-chat-mcp", owner: ALICE.id, environment: "chat", type: "shared", requested: undefined, vaults: undefined });
    const vaults = gateway.app.service("vaults");
    expect(vaults.mcpHeaders("s-chat-mcp", "https://mcp.contoso.example/docs", "shared")).toBeUndefined();
    // Sandbox placeholders only exist for isolated sessions, whose sandboxes the egress proxy registers.
    expect(vaults.mcpHeaders("s-chat-mcp", "https://mcp.contoso.example/docs", "sandbox")).toBeUndefined();
    expect(vaults.mcpHeaders("s-chat-mcp", "https://other.example.com/", "sandbox")).toBeUndefined();
  });

  it("advertises the network capabilities", async () => {
    const info = await call("GET", "/v1/info", ALICE);
    expect(info.body?.capabilities).toEqual(expect.arrayContaining(["network.policy", "vaults", "web_fetch"]));
  });

  it("checks for sessions promoted by earlier versions at startup, with core's ledger available", () => {
    expect(getState(gateway.app.db, "legacy_promotions_converted")).toEqual(expect.any(String));
  });
});

describe("policy service across deployment changes", () => {
  const log = createLogger("test", "error");
  const sealer = new Sealer(randomBytes(32));
  const vaults = { payments: [{ env: "STRIPE_API_KEY", value: { secretEnv: "TEST_STRIPE_KEY" }, hosts: ["api.stripe.com"] }] };
  const database = () => {
    const db = openDatabase(":memory:");
    migrateNetwork(db);
    return db;
  };
  /** The policy service as the gateway builds it at startup, over an existing database (a restart with new config). */
  const start = (db: Database, config: { readonly network?: unknown; readonly vaults?: unknown; readonly inline?: unknown; readonly environments: Record<string, unknown> }, pushed: EgressRegistration[] = []) => {
    const deployment = parseConfig({ name: "copilot", vaults, ...config });
    const store = new VaultStore({ db, sealer, deployment, env: { TEST_STRIPE_KEY: "sk_test_stripe_123" }, log });
    const channel = { ready: true, caCertificate: () => "", waitReady: async () => undefined, upsert: (registration: EgressRegistration) => void pushed.push(registration), remove: (_sandboxId: string) => undefined };
    return new PolicyService({ db, deployment, vaults: store, egress: channel, log });
  };

  it("applies a declared environment's own setting even when its name starts with inline-", () => {
    const db = database();
    const policy = start(db, { network: ["example.com"], environments: { "inline-denied": { type: "isolated", network: false }, "inline-open": { type: "isolated", network: true } } });
    const bind = (sessionId: string, environment: string | undefined) => policy.bindSession({ sessionId, owner: 1, environment, type: "isolated", requested: undefined, vaults: undefined });
    expect(bind("s-denied", "inline-denied")).toEqual({ access: "disabled", allowedDomains: [] });
    expect(policy.session("s-denied")).toMatchObject({ environment: "inline-denied", policy: { access: "disabled" } });
    expect(policy.ceiling("inline-denied").access).toBe("disabled");
    expect(bind("s-open", "inline-open").access).toBe("enabled");
    const deploymentDefault = { access: "restricted", allowedDomains: ["example.com"] };
    expect(bind("s-inline", undefined)).toEqual(deploymentDefault);
    expect(bind("s-inline-name", "inline-isolated-small")).toEqual(deploymentDefault);
    expect(policy.session("s-inline-name")?.environment).toBeUndefined();
    expect(policy.ceiling("inline-shared")).toEqual(deploymentDefault);
    expect(() => bind("s-unknown", "unknown")).toThrow(/not declared/);
    // A declared inline-… environment that is later removed means no egress, not the deployment default.
    const restarted = start(db, { network: ["example.com"], environments: { other: { type: "isolated" } } });
    expect(restarted.session("s-open")?.policy.access).toBe("disabled");
    expect(restarted.session("s-inline")?.policy).toEqual(deploymentDefault);
  });

  it("revokes AppHost vault credentials when the environment stops granting the vault", async () => {
    const db = database();
    const before = start(db, { environments: { coder: { type: "isolated", vaults: ["payments"], network: ["api.stripe.com"] } } });
    before.bindSession({ sessionId: "s-vault", owner: 1, environment: "coder", type: "isolated", requested: undefined, vaults: undefined });
    const sandbox = await before.registerSandbox({ sandboxId: "sbx_vault", sessionId: "s-vault" });
    const binding = before.registrations()[0]!.credentials[0]!;
    expect(binding.placeholder).toBe(sandbox.env.STRIPE_API_KEY);
    const use = { sandboxId: "sbx_vault", credentialId: binding.id, placeholder: binding.placeholder, host: "api.stripe.com", port: 443, header: "authorization" };
    expect(before.resolveSecret(use)).toBe("sk_test_stripe_123");

    // Same database, restarted with an AppHost that still declares the vault but no longer grants it to "coder".
    const after = start(db, { environments: { coder: { type: "isolated", network: ["api.stripe.com"] } } });
    expect(after.registrations()).toMatchObject([{ sandboxId: "sbx_vault", credentials: [] }]);
    expect(() => after.resolveSecret(use)).toThrow(/revoked/);
    expect(after.session("s-vault")?.vaults).toEqual([]);
    expect((await after.registerSandbox({ sandboxId: "sbx_vault", sessionId: "s-vault" })).env.STRIPE_API_KEY).toBeUndefined();
  });

  it("promotes from the session's current policy, so a tightened source ceiling survives promotion", () => {
    const db = database();
    const worker = { type: "isolated" };
    start(db, { environments: { helper: { type: "promotable", promoteTo: "worker" }, worker } }).bindSession({ sessionId: "s-promote", owner: 1, environment: "helper", type: "promotable", requested: undefined, vaults: undefined });
    const tightened = start(db, { environments: { helper: { type: "promotable", promoteTo: "worker", network: false }, worker } });
    expect(tightened.session("s-promote")?.policy.access).toBe("disabled");
    expect(tightened.promoteSession("s-promote", "worker").access).toBe("disabled");
    expect(tightened.session("s-promote")).toMatchObject({ environment: "helper", promotedTo: "worker", type: "isolated", policy: { access: "disabled" } });
  });

  it("keeps the source environment's vault grants and ceiling through promotion, narrowed by the target's", async () => {
    const db = database();
    const config = (helper: Record<string, unknown>, worker: Record<string, unknown> | undefined) => ({
      environments: {
        helper: { type: "promotable", promoteTo: worker ? "worker" : "elsewhere", vaults: ["payments"], network: ["api.stripe.com", "pypi.org", "files.pythonhosted.org"], ...helper },
        ...(worker ? { worker: { type: "isolated", network: ["api.stripe.com", "pypi.org", "github.com"], ...worker } } : {}),
        elsewhere: { type: "isolated" },
      },
    });
    const policy = start(db, config({}, {}));
    policy.bindSession({ sessionId: "s-carry", owner: 1, environment: "helper", type: "promotable", requested: undefined, vaults: undefined });
    // The target does not repeat the source's vault, and its ceiling is different: neither may broaden the session.
    expect(policy.promoteSession("s-carry", "worker")).toEqual({ access: "restricted", allowedDomains: ["api.stripe.com", "pypi.org"] });
    expect(policy.session("s-carry")).toMatchObject({ environment: "helper", promotedTo: "worker", type: "isolated", vaults: ["payments"] });
    const sandbox = await policy.registerSandbox({ sandboxId: "sbx_carry", sessionId: "s-carry" });
    expect(sandbox.env.STRIPE_API_KEY).toMatch(/^mcv_placeholder_[0-9a-f]{40}$/);
    const binding = policy.registrations()[0]!.credentials[0]!;
    const use = { sandboxId: "sbx_carry", credentialId: binding.id, placeholder: binding.placeholder, host: "api.stripe.com", port: 443, header: "authorization" };
    expect(policy.resolveSecret(use)).toBe("sk_test_stripe_123");
    policy.commitPromotion("s-carry");

    // Tightening the source after promotion still applies, and so does tightening the target.
    expect(start(db, config({ network: ["api.stripe.com"] }, {})).session("s-carry")?.policy).toEqual({ access: "restricted", allowedDomains: ["api.stripe.com"] });
    expect(start(db, config({}, { network: false })).session("s-carry")?.policy.access).toBe("disabled");
    expect(start(db, config({}, undefined)).session("s-carry")?.policy.access).toBe("disabled");
    // The source keeps owning the vault grant: removing it there revokes the credential.
    const revoked = start(db, config({ vaults: [] }, {}));
    expect(revoked.registrations()[0]!.credentials).toEqual([]);
    expect(() => revoked.resolveSecret(use)).toThrow(/revoked/);
    // Granting a vault only on the target gives the promoted session nothing new.
    const targetOnly = start(db, config({ vaults: [] }, { vaults: ["payments"] }));
    expect(targetOnly.session("s-carry")?.vaults).toEqual([]);
    expect(start(db, config({}, {})).resolveSecret(use)).toBe("sk_test_stripe_123");
  });

  it("reverts an uncommitted promotion exactly, across restarts, and keeps a committed one", async () => {
    const db = database();
    const config = { network: ["example.com", "pypi.org"], environments: { helper: { type: "promotable", promoteTo: "worker" }, worker: { type: "isolated", network: ["pypi.org"] } } };
    const pushed: EgressRegistration[] = [];
    const policy = start(db, config, pushed);
    const source = policy.bindSession({ sessionId: "s-roll", owner: 1, environment: "helper", type: "promotable", requested: undefined, vaults: undefined });
    expect(source).toEqual({ access: "restricted", allowedDomains: ["example.com", "pypi.org"] });
    expect(policy.revertPromotion("s-roll")).toBeUndefined();
    expect(policy.promoteSession("s-roll", "worker")).toEqual({ access: "restricted", allowedDomains: ["pypi.org"] });
    // A retried promotion still reverts to the original source.
    policy.promoteSession("s-roll", "worker");
    await policy.registerSandbox({ sandboxId: "sbx_candidate", sessionId: "s-roll" });
    expect(pushed.at(-1)).toMatchObject({ sandboxId: "sbx_candidate", policy: { allowedDomains: ["pypi.org"] } });

    const restarted = start(db, config, pushed);
    expect(restarted.revertPromotion("s-roll")).toEqual(source);
    expect(restarted.session("s-roll")).toMatchObject({ environment: "helper", type: "promotable", policy: source });
    expect(restarted.session("s-roll")?.promotedTo).toBeUndefined();
    // The candidate sandbox left behind by the rollback gets no egress, and no new sandbox can register.
    expect(pushed.at(-1)).toMatchObject({ sandboxId: "sbx_candidate", policy: { access: "disabled" }, credentials: [] });
    await expect(restarted.registerSandbox({ sandboxId: "sbx_other", sessionId: "s-roll" })).rejects.toThrow(/shared session/);
    expect(restarted.revertPromotion("s-roll")).toBeUndefined();

    restarted.promoteSession("s-roll", "worker");
    restarted.commitPromotion("s-roll");
    expect(restarted.revertPromotion("s-roll")).toBeUndefined();
    expect(restarted.session("s-roll")).toMatchObject({ environment: "helper", promotedTo: "worker", type: "isolated", policy: { allowedDomains: ["pypi.org"] } });
  });

  it("converts sessions promoted by earlier versions, from the pending snapshot or core's ledger, once", () => {
    const db = database();
    new SessionLedger(db);
    new PromotionStore(db);
    const config = (helper: Record<string, unknown> = {}) => ({
      network: ["api.stripe.com", "pypi.org"],
      inline: { types: ["promotable"] },
      environments: {
        helper: { type: "promotable", promoteTo: "worker", vaults: ["payments"], network: ["api.stripe.com", "pypi.org"], ...helper },
        worker: { type: "isolated", network: ["api.stripe.com", "pypi.org", "github.com"] },
        plain: { type: "isolated", network: ["github.com"] },
      },
    });
    const policy = start(db, config());
    const now = new Date().toISOString();
    const core = (id: string, environment: string, request: Record<string, unknown>) =>
      db
        .prepare("INSERT INTO core_sessions (id, owner_id, environment, env_type, placement, state, network, environment_request, admitted, created_at, updated_at) VALUES (?, 1, ?, 'promotable', 'sandbox', 'idle', '{}', ?, '{}', ?, ?)")
        .run(id, environment, JSON.stringify(request), now, now);
    for (const id of ["s-committed", "s-pending", "s-orphan"]) policy.bindSession({ sessionId: id, owner: 1, environment: "helper", type: "promotable", requested: undefined, vaults: undefined });
    policy.bindSession({ sessionId: "s-inline", owner: 1, environment: undefined, type: "promotable", requested: undefined, vaults: undefined });
    policy.bindSession({ sessionId: "s-plain", owner: 1, environment: "plain", type: "isolated", requested: undefined, vaults: undefined });
    // A declared source named "inline-helper", removed from the AppHost later (before the upgrade).
    const declaredThen = start(db, { ...config(), environments: { ...config().environments, "inline-helper": { type: "promotable", promoteTo: "worker", network: true } } });
    declaredThen.bindSession({ sessionId: "s-removed", owner: 1, environment: "inline-helper", type: "promotable", requested: undefined, vaults: undefined });
    // The layout the earlier promoteSession left: the target as the environment, the source only in a pending snapshot.
    const legacy = (id: string, pending: boolean) => {
      const row = db.prepare("SELECT environment, type, policy FROM network_sessions WHERE session_id = ?").get(id) as { environment: string | null; type: string; policy: string };
      db.prepare("UPDATE network_sessions SET environment = 'worker', type = 'isolated', policy = ?, promoted_from = ? WHERE session_id = ?").run(
        JSON.stringify({ access: "restricted", allowedDomains: ["api.stripe.com", "pypi.org"] }),
        pending ? JSON.stringify({ environment: row.environment, type: row.type, policy: row.policy }) : null,
        id,
      );
    };
    legacy("s-committed", false);
    legacy("s-pending", true);
    legacy("s-orphan", false);
    legacy("s-inline", false);
    legacy("s-removed", false);
    core("s-committed", "helper", { name: "helper" });
    core("s-pending", "helper", { name: "helper" });
    core("s-inline", "inline-promotable-small", { type: "promotable" });
    core("s-plain", "plain", { name: "plain" });
    core("s-removed", "inline-helper", { name: "inline-helper" });
    db.prepare("INSERT INTO promotion_operations (id, session_id, owner_id, from_generation, trigger, target, state, created_at, updated_at) VALUES ('prm_1', 's-orphan', 1, 0, 'api', 'worker', 'committed', ?, ?)").run(now, now);
    expect(policy.session("s-committed")).toMatchObject({ environment: "worker", vaults: [] });

    // The declared source "inline-helper" was removed from the AppHost before the upgrade.
    const upgraded = start(db, config());
    expect(upgraded.convertLegacyPromotions()).toBe(5);
    expect(upgraded.session("s-removed")).toMatchObject({ environment: "inline-helper", promotedTo: "worker", policy: { access: "disabled" } });
    expect(policy.session("s-committed")).toMatchObject({ environment: "helper", promotedTo: "worker", type: "isolated", vaults: ["payments"] });
    expect(policy.session("s-pending")).toMatchObject({ environment: "helper", promotedTo: "worker" });
    expect(policy.session("s-inline")).toMatchObject({ promotedTo: "worker", policy: { access: "restricted", allowedDomains: ["api.stripe.com", "pypi.org"] } });
    expect(policy.session("s-inline")?.environment).toBeUndefined();
    expect(policy.session("s-orphan")).toMatchObject({ promotedTo: "worker", policy: { access: "disabled" }, vaults: [] });
    expect(policy.session("s-plain")).toEqual(expect.objectContaining({ environment: "plain", type: "isolated" }));
    expect(policy.session("s-plain")?.promotedTo).toBeUndefined();
    // The source's restrictions and grants apply again, and a pending promotion still reverts to its source.
    expect(start(db, config({ network: false, vaults: [] })).session("s-committed")).toMatchObject({ policy: { access: "disabled" }, vaults: [] });
    policy.revertPromotion("s-pending");
    expect(policy.session("s-pending")).toMatchObject({ environment: "helper", type: "promotable" });
    expect(policy.session("s-pending")?.promotedTo).toBeUndefined();
    // Once per database.
    legacy("s-plain", false);
    expect(policy.convertLegacyPromotions()).toBe(0);
    expect(start(db, config()).convertLegacyPromotions()).toBe(0);
  });

  it("refuses vault secrets to a reverted promotion's candidate sandbox", async () => {
    const db = database();
    const environments = {
      helper: { type: "promotable", promoteTo: "worker", vaults: ["payments"], network: ["api.stripe.com"] },
      worker: { type: "isolated", vaults: ["payments"], network: ["api.stripe.com"] },
    };
    const policy = start(db, { environments });
    policy.bindSession({ sessionId: "s-cand", owner: 1, environment: "helper", type: "promotable", requested: undefined, vaults: undefined });
    policy.promoteSession("s-cand", "worker");
    const candidate = await policy.registerSandbox({ sandboxId: "sbx_cand", sessionId: "s-cand" });
    const binding = policy.registrations().find((registration) => registration.sandboxId === "sbx_cand")!.credentials[0]!;
    expect(binding.placeholder).toBe(candidate.env.STRIPE_API_KEY);
    const use = { sandboxId: "sbx_cand", credentialId: binding.id, placeholder: binding.placeholder, host: "api.stripe.com", port: 443, header: "authorization" };
    expect(policy.resolveSecret(use)).toBe("sk_test_stripe_123");
    policy.revertPromotion("s-cand");
    expect(() => policy.resolveSecret(use)).toThrow(/not running in an isolated sandbox/);
  });

  it("fails fast, without waiting, when the deployment runs no egress proxy", async () => {
    const db = database();
    const deployment = parseConfig({
      name: "copilot",
      vaults,
      environments: { coder: { type: "isolated", network: ["pypi.org"] }, offline: { type: "isolated", network: false }, keyed: { type: "isolated", network: ["api.stripe.com"], vaults: ["payments"] } },
    });
    const store = new VaultStore({ db, sealer, deployment, env: { TEST_STRIPE_KEY: "sk_test_stripe_123" }, log });
    let waited = false;
    const channel = {
      ready: false,
      caCertificate: () => undefined,
      waitReady: () => {
        waited = true;
        return new Promise<void>(() => undefined);
      },
      upsert: (_registration: EgressRegistration) => undefined,
      remove: (_sandboxId: string) => undefined,
    };
    const policy = new PolicyService({ db, deployment, vaults: store, egress: channel, log, egressMode: "off" });
    for (const [sessionId, environment] of [
      ["s-net", "coder"],
      ["s-off", "offline"],
      ["s-keyed", "keyed"],
    ] as const) {
      policy.bindSession({ sessionId, owner: 1, environment, type: "isolated", requested: undefined, vaults: undefined });
    }
    await expect(policy.registerSandbox({ sandboxId: "sbx_net", sessionId: "s-net" })).rejects.toMatchObject({ code: "capability_unavailable", message: expect.stringContaining("MANAGED_COPILOT_EGRESS=off") });
    await expect(policy.registerSandbox({ sandboxId: "sbx_keyed", sessionId: "s-keyed" })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect((await policy.registerSandbox({ sandboxId: "sbx_off", sessionId: "s-off" })).policy.access).toBe("disabled");
    expect(waited).toBe(false);
  });

  it("hands sandboxes MCP placeholders only for destinations the egress proxy substitutes for", async () => {
    const policy = start(database(), {
      vaults: {
        named: [{ mcpServer: "https://mcp.example.com/mcp", header: "x-api-key", value: { secretEnv: "TEST_STRIPE_KEY" } }],
        address: [{ mcpServer: "https://93.184.216.34/mcp", value: { secretEnv: "TEST_STRIPE_KEY" } }],
      },
      environments: { research: { type: "isolated", vaults: ["named", "address"], network: true } },
    });
    policy.bindSession({ sessionId: "s-mcp", owner: 1, environment: "research", type: "isolated", requested: undefined, vaults: undefined });
    await policy.registerSandbox({ sandboxId: "sbx_mcp", sessionId: "s-mcp" });
    const named = policy.mcpHeaders("s-mcp", "https://mcp.example.com/mcp", "sandbox");
    expect(named).toEqual({ "x-api-key": expect.stringMatching(/^mcv_placeholder_[0-9a-f]{40}$/) });
    expect(policy.registrations()[0]!.credentials).toEqual([expect.objectContaining({ placeholder: named!["x-api-key"], destinations: [{ host: "mcp.example.com", port: 443 }], headers: ["x-api-key"] })]);
    expect(() => policy.mcpHeaders("s-mcp", "https://93.184.216.34/mcp", "sandbox")).toThrow(/only for host names on port 443/);
  });

  it("builds proxy URLs for the address a sandbox provider names", async () => {
    const policy = start(database(), { environments: { coder: { type: "isolated", network: true } } });
    policy.bindSession({ sessionId: "s-proxy", owner: 1, environment: "coder", type: "isolated", requested: undefined, vaults: undefined });
    const urlFor = async (proxy?: { host: string; port: number }) => new URL((await policy.registerSandbox({ sandboxId: "sbx_proxy", sessionId: "s-proxy", ...(proxy ? { proxy } : {}) })).proxyUrl);
    expect((await urlFor()).host).toBe("mc-egress:3128");
    expect((await urlFor({ host: "Egress.Internal.Example", port: 8080 })).host).toBe("egress.internal.example:8080");
    expect((await urlFor({ host: "10.0.1.4", port: 3128 })).host).toBe("10.0.1.4:3128");
    expect((await urlFor({ host: "fd00::4", port: 3128 })).host).toBe("[fd00::4]:3128");
    const sandbox = await policy.registerSandbox({ sandboxId: "sbx_proxy", sessionId: "s-proxy", proxy: { host: "10.0.1.4", port: 3128 } });
    expect(sandbox.env.HTTPS_PROXY).toBe(sandbox.proxyUrl);
    for (const proxy of [{ host: "bad host", port: 3128 }, { host: "egress", port: 0 }, { host: "egress", port: 3128.5 }, { host: "a/b", port: 1 }]) {
      await expect(policy.registerSandbox({ sandboxId: "sbx_proxy", sessionId: "s-proxy", proxy }), JSON.stringify(proxy)).rejects.toThrow(/proxy\./);
    }
  });
});
