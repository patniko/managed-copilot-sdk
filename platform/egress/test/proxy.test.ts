import { normalizeNetwork, type EgressRegistration, type EgressReport, type EgressSecretRequest } from "@managed-copilot/protocol";
import { parseCidr } from "@managed-copilot/protocol";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretUnavailableError } from "../src/gateway-link.js";
import { silentLogger } from "../src/log.js";
import { EgressProxy } from "../src/proxy.js";
import { hashCredential, Registry } from "../src/registry.js";
import {
  basic,
  bearer,
  closed,
  forward,
  httpEcho,
  httpOver,
  httpsEcho,
  listen,
  openTunnel,
  routedDialer,
  sha256,
  tableResolver,
  testCa,
  tlsOver,
  type EchoRecord,
} from "./fixtures.js";

const placeholder = (seed: string) => `mcv_placeholder_${seed.repeat(40).slice(0, 40)}`;
const STRIPE = placeholder("5a");
const BAD = placeholder("6b");
const PEER = placeholder("7c");
const SECRETS = new Map([
  [STRIPE, "sk_test_51abcdef"],
  [BAD, "sk_bad_value_123"],
  [PEER, "sk_peer_value_456"],
]);

const platformCa = testCa("Platform Egress CA");
const upstreamCa = testCa("Upstream Test CA");
const secretOf = (sandboxId: string) => `pw-${sandboxId}`;
const auth = (sandboxId: string) => basic(sandboxId, secretOf(sandboxId));

function registration(sandboxId: string, network: Parameters<typeof normalizeNetwork>[0], extra: Partial<EgressRegistration> = {}): EgressRegistration {
  return { sandboxId, sessionId: `ses_${sandboxId}`, credentialHash: hashCredential(secretOf(sandboxId)), policy: normalizeNetwork(network), credentials: [], revision: 1, ...extra };
}

const REGISTRATIONS: EgressRegistration[] = [
  registration("sbx_off", false),
  registration("sbx_list", ["plain.example.test", "other.example.test", "internal.example.test", "meta.example.test", "mixed.example.test", "rebind.example.test"]),
  registration("sbx_on", true),
  registration("sbx_vault", ["vault.example.test", "badvault.example.test", "other.example.test", "plain.example.test"], {
    credentials: [
      { id: "cred_stripe", placeholder: STRIPE, destinations: [{ host: "vault.example.test", port: 443 }], headers: ["authorization"] },
      { id: "cred_bad", placeholder: BAD, destinations: [{ host: "badvault.example.test", port: 443 }], headers: ["authorization"] },
    ],
  }),
  registration("sbx_peer", ["vault.example.test"], {
    credentials: [{ id: "cred_peer", placeholder: PEER, destinations: [{ host: "vault.example.test", port: 443 }], headers: ["authorization"] }],
  }),
  registration("sbx_pinned", true, { address: "10.9.9.9" }),
];

describe("egress proxy", () => {
  const plainRecords: EchoRecord[] = [];
  const vaultRecords: EchoRecord[] = [];
  const otherRecords: EchoRecord[] = [];
  const badRecords: EchoRecord[] = [];
  const servers: Server[] = [];
  const attempts: string[] = [];
  const lookups: string[] = [];
  const reports: EgressReport[] = [];
  const secretRequests: EgressSecretRequest[] = [];
  const revoked = new Set<string>();
  let rebindCount = 0;
  let registry: Registry;
  let proxy: EgressProxy;
  let port: number;

  beforeAll(async () => {
    const plain = httpEcho(plainRecords);
    const vault = httpsEcho(upstreamCa, "vault.example.test", vaultRecords);
    const other = httpsEcho(upstreamCa, "other.example.test", otherRecords);
    const bad = httpsEcho(upstreamCa, "wrong.example.test", badRecords);
    servers.push(plain, vault, other, bad);
    const routes = new Map([
      ["93.184.216.10:80", await listen(plain)],
      ["93.184.216.11:443", await listen(vault)],
      ["93.184.216.12:443", await listen(other)],
      ["93.184.216.13:443", await listen(bad)],
    ]);
    registry = new Registry({ staleMs: 30_000, maxConnectionsPerSandbox: 32 });
    registry.replaceAll(REGISTRATIONS);
    proxy = new EgressProxy({
      registry,
      ca: platformCa,
      log: silentLogger,
      reporter: { report: (report) => reports.push(report) },
      secrets: {
        resolveSecret: async (request) => {
          secretRequests.push(request);
          if (revoked.has(request.placeholder)) throw new SecretUnavailableError("credential_revoked", "This vault was deleted.");
          const value = SECRETS.get(request.placeholder);
          if (!value) throw new SecretUnavailableError("credential_revoked", "Unknown credential.");
          return value;
        },
      },
      destination: {
        allowedPorts: new Set([80, 443]),
        privateHosts: new Set(),
        protectedCidrs: () => [parseCidr("10.213.0.0/16")],
        blockedCidrs: [],
        dnsTimeoutMs: 1_000,
        resolve: tableResolver(
          {
            "plain.example.test": ["93.184.216.10"],
            "vault.example.test": ["93.184.216.11"],
            "other.example.test": ["93.184.216.12"],
            "badvault.example.test": ["93.184.216.13"],
            "internal.example.test": ["10.0.0.5"],
            "meta.example.test": ["169.254.169.254"],
            "mixed.example.test": ["127.0.0.1", "93.184.216.10"],
            "rebind.example.test": () => (rebindCount++ === 0 ? ["93.184.216.10"] : ["127.0.0.1"]),
          },
          lookups,
        ),
      },
      dial: routedDialer(routes, attempts),
      upstreamCa: [upstreamCa.certPem],
      helloTimeoutMs: 1_000,
    });
    port = (await proxy.listen(0, "127.0.0.1")).port;
  });

  afterAll(async () => {
    await proxy.close();
    for (const server of servers) server.close();
  });

  beforeEach(() => {
    reports.length = 0;
    attempts.length = 0;
    secretRequests.length = 0;
  });

  const waitForReport = async (reason: string) => {
    for (let i = 0; i < 50 && !reports.some((report) => report.reason === reason); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return reports.find((report) => report.reason === reason);
  };

  async function vaultRequest(sandboxId: string, host: string, path: string, headers: Record<string, string>) {
    const tunnel = await openTunnel(port, `${host}:443`, auth(sandboxId));
    expect(tunnel.status).toBe(200);
    const tls = await tlsOver(tunnel.socket!, host, platformCa.certPem);
    try {
      return await httpOver(tls, path, { host, ...headers });
    } finally {
      tls.destroy();
    }
  }

  describe("authentication", () => {
    it("requires the sandbox's proxy credential", async () => {
      const missing = await forward(port, "http://plain.example.test/");
      expect(missing.status).toBe(407);
      expect(missing.headers["proxy-authenticate"]).toMatch(/^Basic/);
      const wrong = await openTunnel(port, "other.example.test:443", basic("sbx_list", "nope"));
      expect(wrong.status).toBe(407);
    });

    it("rejects a credential used from another source address", async () => {
      const response = await forward(port, "http://plain.example.test/", { "proxy-authorization": auth("sbx_pinned") });
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/different sandbox/);
    });

    it("serves health and the CA certificate without credentials", async () => {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await health.json()).toMatchObject({ status: "ok", ready: true });
      expect(await (await fetch(`http://127.0.0.1:${port}/ca.pem`)).text()).toBe(platformCa.certPem);
    });
  });

  describe("plain HTTP", () => {
    it("forwards to allowed hosts without proxy credentials", async () => {
      const response = await forward(port, "http://plain.example.test/hello?x=1", { "proxy-authorization": auth("sbx_list") });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ url: "/hello?x=1", host: "plain.example.test", proxyAuthorization: null });
    });

    it("blocks everything when network is false, and reports it", async () => {
      const response = await forward(port, "http://plain.example.test/", { "proxy-authorization": auth("sbx_off") });
      expect(response.status).toBe(403);
      expect(response.headers["x-managed-copilot-egress"]).toBe("blocked");
      expect(response.body).toMatch(/network: false/);
      expect(await waitForReport("network_disabled")).toMatchObject({ sandboxId: "sbx_off", sessionId: "ses_sbx_off", host: "plain.example.test", port: 80, method: "GET", path: "/" });
    });

    it("blocks hosts outside the list without resolving them", async () => {
      const response = await forward(port, "http://evil.example.test/steal", { "proxy-authorization": auth("sbx_list") });
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/not an allowed host/);
      expect(lookups).not.toContain("evil.example.test");
      expect(await waitForReport("host_not_allowed")).toMatchObject({ host: "evil.example.test", path: "/steal" });
    });

    it("blocks private, loopback, and metadata destinations by address and by name", async () => {
      for (const [sandbox, url] of [
        ["sbx_on", "http://10.0.0.5/"],
        ["sbx_on", "http://169.254.169.254/latest/meta-data/"],
        ["sbx_on", "http://[::1]/"],
        ["sbx_on", "http://[::ffff:127.0.0.1]/"],
        ["sbx_list", "http://meta.example.test/"],
        ["sbx_list", "http://internal.example.test/"],
        ["sbx_list", "http://93.184.216.10/"],
      ] as const) {
        const response = await forward(port, url, { "proxy-authorization": auth(sandbox) });
        expect(response.status, url).toBe(403);
      }
      expect(attempts).toEqual([]);
    });

    it("validates ports", async () => {
      const response = await forward(port, "http://plain.example.test:8080/", { "proxy-authorization": auth("sbx_list") });
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/Port 8080/);
    });

    it("connects only to the validated address (mixed answers and DNS rebinding)", async () => {
      expect((await forward(port, "http://mixed.example.test/", { "proxy-authorization": auth("sbx_list") })).status).toBe(200);
      expect((await forward(port, "http://rebind.example.test/", { "proxy-authorization": auth("sbx_list") })).status).toBe(200);
      expect((await forward(port, "http://rebind.example.test/", { "proxy-authorization": auth("sbx_list") })).status).toBe(403);
      expect(attempts).toEqual(["93.184.216.10:80", "93.184.216.10:80"]);
    });

    it("never sends vault placeholders over plain HTTP", async () => {
      const before = plainRecords.length;
      const response = await forward(port, `http://plain.example.test/?key=${STRIPE}`, { "proxy-authorization": auth("sbx_vault") });
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/only substituted in HTTPS/);
      expect(plainRecords.length).toBe(before);
      expect(secretRequests).toEqual([]);
    });
  });

  describe("CONNECT tunnels", () => {
    it("tunnels TLS end to end to allowed hosts without interception", async () => {
      const tunnel = await openTunnel(port, "other.example.test:443", auth("sbx_list"));
      expect(tunnel.status).toBe(200);
      const tls = await tlsOver(tunnel.socket!, "other.example.test", upstreamCa.certPem);
      expect(tls.getPeerCertificate().issuer.CN).toBe("Upstream Test CA");
      const response = await httpOver(tls, "/tunnel", { host: "other.example.test" });
      expect(JSON.parse(response.body)).toMatchObject({ url: "/tunnel" });
      tls.destroy();
    });

    it("explains blocks in the CONNECT status line", async () => {
      const blocked = await openTunnel(port, "github.com:443", auth("sbx_list"));
      expect(blocked.status).toBe(403);
      expect(blocked.statusMessage).toMatch(/github\.com is not an allowed host/);
      expect(blocked.body).toMatch(/Managed Copilot egress/);
      expect((await openTunnel(port, "127.0.0.1:443", auth("sbx_on"))).status).toBe(403);
      expect((await openTunnel(port, "other.example.test:22", auth("sbx_list"))).status).toBe(403);
    });

    it("requires the TLS server name to match the authorized host", async () => {
      const tunnel = await openTunnel(port, "other.example.test:443", auth("sbx_list"));
      await expect(tlsOver(tunnel.socket!, "evil.example.test", upstreamCa.certPem)).rejects.toThrow();
      expect(await waitForReport("sni_mismatch")).toMatchObject({ host: "other.example.test", message: expect.stringContaining("evil.example.test") });
    });

    it("refuses tunnels that do not carry TLS", async () => {
      const tunnel = await openTunnel(port, "other.example.test:443", auth("sbx_list"));
      tunnel.socket!.write("SSH-2.0-OpenSSH_9.6\r\n");
      await closed(tunnel.socket!);
      expect(await waitForReport("non_tls_tunnel")).toMatchObject({ host: "other.example.test" });
      expect(otherRecords.every((record) => record.url !== "")).toBe(true);
    });

    it("closes open tunnels when the sandbox is revoked or its policy narrows", async () => {
      const tunnel = await openTunnel(port, "other.example.test:443", auth("sbx_list"));
      const tls = await tlsOver(tunnel.socket!, "other.example.test", upstreamCa.certPem);
      const original = registry.get("sbx_list")!;
      registry.upsert({ ...original, policy: normalizeNetwork(["plain.example.test"]), revision: original.revision + 1 });
      await closed(tunnel.socket!);
      tls.destroy();
      registry.upsert({ ...original, revision: original.revision + 2 });

      const second = await openTunnel(port, "other.example.test:443", auth("sbx_list"));
      registry.remove("sbx_list");
      await closed(second.socket!);
      registry.upsert({ ...original, revision: original.revision + 3 });
    });
  });

  describe("vault credentials", () => {
    it("substitutes the placeholder only in the named header, over verified TLS", async () => {
      const before = vaultRecords.length;
      const response = await vaultRequest("sbx_vault", "vault.example.test", "/v1/balance", { authorization: bearer(STRIPE) });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.authorizationSha256).toBe(sha256(bearer("sk_test_51abcdef")));
      expect(vaultRecords.length).toBe(before + 1);
      expect(vaultRecords.at(-1)!.headers.authorization).toBe(bearer("sk_test_51abcdef"));
      expect(body.authorization).toBe(bearer("[redacted]"));
      expect(response.headers["x-echo-authorization"]).toBe(bearer("[redacted]"));
      expect(body.acceptEncoding).toBe("identity");
      expect(secretRequests).toEqual([{ sandboxId: "sbx_vault", credentialId: "cred_stripe", placeholder: STRIPE, host: "vault.example.test", port: 443, header: "authorization" }]);
    });

    it("presents a platform CA certificate for vault hosts", async () => {
      const tunnel = await openTunnel(port, "vault.example.test:443", auth("sbx_vault"));
      const tls = await tlsOver(tunnel.socket!, "vault.example.test", platformCa.certPem);
      expect(tls.getPeerCertificate().issuer.CN).toBe("Platform Egress CA");
      tls.destroy();
    });

    it("passes requests without placeholders through unchanged", async () => {
      const response = await vaultRequest("sbx_vault", "vault.example.test", "/public", {});
      expect(JSON.parse(response.body)).toMatchObject({ url: "/public", authorization: null });
      expect(secretRequests).toEqual([]);
    });

    it("rejects unsupported and foreign uses without contacting the destination", async () => {
      const before = vaultRecords.length;
      const cases: [string, Record<string, string>, number, RegExp][] = [
        [`/v1/balance?key=${STRIPE}`, {}, 403, /not in URLs/],
        ["/", { authorization: `Basic ${Buffer.from(`${STRIPE}:`).toString("base64")}` }, 403, /Basic authentication/],
        ["/", { "x-api-key": STRIPE }, 403, /only be sent in the authorization header/],
        ["/", { authorization: bearer(PEER) }, 403, /does not belong to this session/],
        ["/", { authorization: bearer(BAD) }, 403, /only valid for badvault\.example\.test/],
      ];
      for (const [path, headers, status, message] of cases) {
        const response = await vaultRequest("sbx_vault", "vault.example.test", path, headers);
        expect(response.status, path).toBe(status);
        expect(response.body).toMatch(message);
      }
      expect(vaultRecords.length).toBe(before);
      expect(secretRequests).toEqual([]);
      expect(reports.filter((report) => report.reason === "credential_misuse")).toHaveLength(cases.length);
      expect(JSON.stringify(reports)).not.toContain("sk_");
    });

    it("re-checks the HTTP authority on every request", async () => {
      const tunnel = await openTunnel(port, "vault.example.test:443", auth("sbx_vault"));
      const tls = await tlsOver(tunnel.socket!, "vault.example.test", platformCa.certPem);
      const response = await httpOver(tls, "/", { host: "other.example.test", authorization: bearer(STRIPE) });
      expect(response.status).toBe(421);
      expect(secretRequests).toEqual([]);
      tls.destroy();
    });

    it("forwards exactly one Host header, the authorized one", async () => {
      const tunnel = await openTunnel(port, "vault.example.test:443", auth("sbx_vault"));
      const tls = await tlsOver(tunnel.socket!, "vault.example.test", platformCa.certPem);
      const before = vaultRecords.length;
      tls.write(`GET /dup HTTP/1.1\r\nHost: vault.example.test\r\nHost: evil.example.test\r\nAuthorization: ${bearer(STRIPE)}\r\nConnection: close\r\n\r\n`);
      const raw = await new Promise<string>((resolve) => {
        let data = "";
        tls.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        tls.on("close", () => resolve(data));
        tls.on("end", () => resolve(data));
      });
      expect(raw).toMatch(/^HTTP\/1\.1 200/);
      expect(vaultRecords.length).toBe(before + 1);
      expect(vaultRecords.at(-1)!.headers.host).toBe("vault.example.test");
      tls.destroy();
    });

    it("stops new uses after revocation", async () => {
      revoked.add(STRIPE);
      try {
        const before = vaultRecords.length;
        const response = await vaultRequest("sbx_vault", "vault.example.test", "/v1/balance", { authorization: bearer(STRIPE) });
        expect(response.status).toBe(403);
        expect(response.body).toMatch(/deleted/);
        expect(vaultRecords.length).toBe(before);
        expect(await waitForReport("credential_revoked")).toBeDefined();
      } finally {
        revoked.delete(STRIPE);
      }
    });

    it("never sends a secret to a destination whose certificate does not verify", async () => {
      const response = await vaultRequest("sbx_vault", "badvault.example.test", "/", { authorization: bearer(BAD) });
      expect(response.status).toBe(502);
      expect(response.body).toMatch(/could not be verified/);
      expect(badRecords).toEqual([]);
      expect(await waitForReport("upstream_tls_failed")).toMatchObject({ host: "badvault.example.test" });
    });

    it("fails visibly when a client does not trust the platform CA", async () => {
      const tunnel = await openTunnel(port, "vault.example.test:443", auth("sbx_vault"));
      await expect(tlsOver(tunnel.socket!, "vault.example.test", upstreamCa.certPem)).rejects.toThrow(/certificate/i);
      tunnel.socket!.destroy();
      expect(await waitForReport("tls_client_untrusted")).toMatchObject({ host: "vault.example.test", message: expect.stringContaining("platform CA") });
    });
  });

  it("fails closed until the gateway has sent a snapshot", async () => {
    const cold = new EgressProxy({
      registry: new Registry({ staleMs: 30_000, maxConnectionsPerSandbox: 4 }),
      ca: platformCa,
      log: silentLogger,
      reporter: { report: () => undefined },
      secrets: { resolveSecret: async () => "" },
      destination: { allowedPorts: new Set([80]), privateHosts: new Set(), protectedCidrs: () => [], blockedCidrs: [], dnsTimeoutMs: 100, resolve: async () => [] },
    });
    const coldPort = (await cold.listen(0, "127.0.0.1")).port;
    try {
      const response = await forward(coldPort, "http://plain.example.test/", { "proxy-authorization": auth("sbx_on") });
      expect(response.status).toBe(503);
    } finally {
      await cold.close();
    }
  });
});
