import { normalizeNetwork, type EgressRegistration } from "@managed-copilot/protocol";
import { describe, expect, it, vi } from "vitest";
import { canonicalAddress, hashCredential, parseProxyAuthorization, Registry } from "../src/registry.js";

const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

function registration(overrides: Partial<EgressRegistration> = {}): EgressRegistration {
  return {
    sandboxId: "sbx_1",
    sessionId: "ses_1",
    credentialHash: hashCredential("s3cret"),
    policy: normalizeNetwork(["github.com", "*.githubusercontent.com"]),
    credentials: [],
    revision: 1,
    ...overrides,
  };
}

describe("registry", () => {
  it("authenticates proxy credentials and pins source addresses", () => {
    const registry = new Registry({ staleMs: 1_000, maxConnectionsPerSandbox: 2 });
    registry.replaceAll([registration({ address: "10.213.0.18" })]);
    expect(registry.authenticate(undefined, "10.213.0.18")).toMatchObject({ ok: false, status: 407 });
    expect(registry.authenticate(basic("sbx_1", "wrong"), "10.213.0.18")).toMatchObject({ ok: false, status: 407 });
    expect(registry.authenticate(basic("sbx_2", "s3cret"), "10.213.0.18")).toMatchObject({ ok: false, status: 407 });
    expect(registry.authenticate(basic("sbx_1", "s3cret"), "10.213.0.34")).toMatchObject({ ok: false, status: 403 });
    expect(registry.authenticate(basic("sbx_1", "s3cret"), "::ffff:10.213.0.18")).toMatchObject({ ok: true });
    expect(registry.authenticate(basic("sbx_1", "s3cret"), "10.213.0.18")).toMatchObject({ ok: true, registration: { sessionId: "ses_1" } });
  });

  it("fails closed before the first snapshot and after the gateway link is stale", () => {
    let now = 0;
    const registry = new Registry({ staleMs: 1_000, maxConnectionsPerSandbox: 2, now: () => now });
    expect(registry.authenticate(basic("sbx_1", "s3cret"), "10.0.0.1")).toMatchObject({ ok: false, status: 503 });
    registry.replaceAll([registration()]);
    expect(registry.ready).toBe(true);
    registry.markDisconnected();
    now = 999;
    expect(registry.ready).toBe(true);
    now = 1_001;
    expect(registry.ready).toBe(false);
    expect(registry.authenticate(basic("sbx_1", "s3cret"), "10.0.0.1")).toMatchObject({ ok: false, status: 503 });
    registry.markConnected();
    expect(registry.ready).toBe(true);
  });

  it("closes open connections on revocation, credential rotation, and narrowing", () => {
    const registry = new Registry({ staleMs: 1_000, maxConnectionsPerSandbox: 10 });
    registry.replaceAll([registration()]);
    const github = { host: "github.com", ipLiteral: false, credentialHash: hashCredential("s3cret"), close: vi.fn() };
    const raw = { host: "raw.githubusercontent.com", ipLiteral: false, credentialHash: hashCredential("s3cret"), close: vi.fn() };
    registry.track("sbx_1", github);
    registry.track("sbx_1", raw);
    registry.upsert(registration({ policy: normalizeNetwork(["github.com"]), revision: 2 }));
    expect(raw.close).toHaveBeenCalledOnce();
    expect(github.close).not.toHaveBeenCalled();
    registry.upsert(registration({ policy: normalizeNetwork(["github.com"]), revision: 1 }));
    expect(registry.get("sbx_1")?.revision).toBe(2);
    registry.upsert(registration({ credentialHash: hashCredential("rotated"), revision: 3 }));
    expect(github.close).toHaveBeenCalledOnce();
    const again = { host: "github.com", ipLiteral: false, credentialHash: hashCredential("rotated"), close: vi.fn() };
    registry.track("sbx_1", again);
    registry.replaceAll([]);
    expect(again.close).toHaveBeenCalledOnce();
    expect(registry.get("sbx_1")).toBeUndefined();
  });

  it("limits concurrent connections per sandbox", () => {
    const registry = new Registry({ staleMs: 1_000, maxConnectionsPerSandbox: 1 });
    registry.replaceAll([registration()]);
    const connection = { host: "github.com", ipLiteral: false, credentialHash: hashCredential("s3cret"), close: vi.fn() };
    const first = registry.track("sbx_1", connection);
    expect(first).toMatchObject({ ok: true });
    expect(registry.track("sbx_1", { ...connection })).toMatchObject({ ok: false, status: 429 });
    if (first.ok) first.untrack();
    expect(registry.connectionCount("sbx_1")).toBe(0);
  });

  it("re-checks the registration when admitting a connection", () => {
    const registry = new Registry({ staleMs: 1_000, maxConnectionsPerSandbox: 10 });
    const connection = (host: string, credentialHash = hashCredential("s3cret"), ipLiteral = false) => ({ host, ipLiteral, credentialHash, close: vi.fn() });
    expect(registry.track("sbx_1", connection("github.com"))).toMatchObject({ ok: false, status: 503 });
    registry.replaceAll([registration()]);
    expect(registry.track("sbx_1", connection("github.com"))).toMatchObject({ ok: true });
    expect(registry.track("sbx_1", connection("example.com"))).toMatchObject({ ok: false, status: 403 });
    expect(registry.track("sbx_1", connection("93.184.216.34", hashCredential("s3cret"), true))).toMatchObject({ ok: false, status: 403 });
    expect(registry.track("sbx_1", connection("github.com", hashCredential("rotated")))).toMatchObject({ ok: false, status: 403 });
    expect(registry.track("sbx_2", connection("github.com"))).toMatchObject({ ok: false, status: 403 });
    registry.remove("sbx_1");
    expect(registry.track("sbx_1", connection("github.com"))).toMatchObject({ ok: false, status: 403 });
    expect(registry.connectionCount("sbx_1")).toBe(0);
  });

  it("closes open connections when the gateway link stays down past the stale deadline", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const registry = new Registry({ staleMs: 60, maxConnectionsPerSandbox: 10 });
    registry.replaceAll([registration()]);
    const open = { host: "github.com", ipLiteral: false, credentialHash: hashCredential("s3cret"), close: vi.fn() };
    expect(registry.track("sbx_1", open)).toMatchObject({ ok: true });
    registry.markDisconnected();
    registry.replaceAll([registration()]);
    await sleep(120);
    expect(open.close).not.toHaveBeenCalled();
    registry.markDisconnected();
    await sleep(120);
    expect(open.close).toHaveBeenCalledOnce();
    expect(registry.ready).toBe(false);
  });

  it("parses credentials and addresses", () => {
    expect(parseProxyAuthorization(basic("sbx_1", "a:b"))).toEqual({ user: "sbx_1", secret: "a:b" });
    expect(parseProxyAuthorization("Bearer x")).toBeUndefined();
    expect(canonicalAddress("::ffff:172.18.0.2")).toBe("172.18.0.2");
    expect(canonicalAddress("fd00::1")).toBe("fd00:0:0:0:0:0:0:1");
  });
});
