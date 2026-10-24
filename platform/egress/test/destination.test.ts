import { parseCidr } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { normalizeNetwork } from "@managed-copilot/protocol";
import { evaluateDestination, type DestinationOptions } from "../src/destination.js";

const answers: Record<string, string[]> = {
  "pypi.org": ["151.101.0.223", "2a04:4e42::223"],
  "internal.corp.test": ["10.20.30.40"],
  "metadata.google.internal": ["169.254.169.254"],
  "mixed.example.test": ["127.0.0.1", "93.184.216.10"],
  "loopback.example.test": ["127.0.0.1", "::1"],
  "peer.example.test": ["10.213.0.18"],
  "azure.example.test": ["168.63.129.16"],
};

function options(overrides: Partial<DestinationOptions> = {}): DestinationOptions {
  return {
    allowedPorts: new Set([80, 443]),
    privateHosts: new Set(),
    protectedCidrs: () => [parseCidr("10.213.0.0/16")],
    blockedCidrs: [],
    resolve: async (host) => {
      const result = answers[host];
      if (!result) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return result;
    },
    dnsTimeoutMs: 1_000,
    ...overrides,
  };
}

const enabled = normalizeNetwork(true);
const disabled = normalizeNetwork(false);
const pypiOnly = normalizeNetwork(["pypi.org", "*.corp.test"]);

describe("destination decisions", () => {
  it("allows public destinations and returns only validated addresses", async () => {
    const decision = await evaluateDestination(enabled, "PyPI.org.", 443, options());
    expect(decision).toEqual({ ok: true, host: "pypi.org", port: 443, addresses: ["151.101.0.223", "2a04:4e42::223"], ipLiteral: false });
  });

  it("blocks everything when network is false", async () => {
    const decision = await evaluateDestination(disabled, "pypi.org", 443, options());
    expect(decision).toMatchObject({ ok: false, reason: "network_disabled", status: 403 });
  });

  it("enforces host lists, including wildcard apex rules", async () => {
    expect(await evaluateDestination(pypiOnly, "pypi.org", 443, options())).toMatchObject({ ok: true });
    expect(await evaluateDestination(pypiOnly, "files.pythonhosted.org", 443, options())).toMatchObject({ ok: false, reason: "host_not_allowed" });
    expect(await evaluateDestination(pypiOnly, "corp.test", 443, options())).toMatchObject({ ok: false, reason: "host_not_allowed" });
  });

  it("validates ports", async () => {
    expect(await evaluateDestination(enabled, "pypi.org", 22, options())).toMatchObject({ ok: false, reason: "port_not_allowed" });
    expect(await evaluateDestination(enabled, "pypi.org", 0, options())).toMatchObject({ ok: false, reason: "invalid_destination" });
  });

  it("blocks direct IPs under host lists and non-public IPs always", async () => {
    expect(await evaluateDestination(pypiOnly, "151.101.0.223", 443, options())).toMatchObject({ ok: false, reason: "ip_literal_not_allowed" });
    expect(await evaluateDestination(enabled, "151.101.0.223", 443, options())).toMatchObject({ ok: true, ipLiteral: true });
    for (const ip of ["127.0.0.1", "[::1]", "169.254.169.254", "10.213.0.18", "192.168.65.254", "[::ffff:127.0.0.1]", "0.0.0.0", "168.63.129.16"]) {
      expect(await evaluateDestination(enabled, ip, 80, options()), ip).toMatchObject({ ok: false, reason: "address_not_allowed" });
    }
  });

  it("rejects ambiguous numeric hosts before any lookup", async () => {
    for (const host of ["2130706433", "0x7f.1", "127.1", "0177.0.0.1"]) {
      expect(await evaluateDestination(enabled, host, 80, options()), host).toMatchObject({ ok: false, reason: "invalid_destination" });
    }
  });

  it("checks resolved addresses, not names", async () => {
    expect(await evaluateDestination(enabled, "metadata.google.internal", 80, options())).toMatchObject({ ok: false, reason: "address_not_allowed", message: expect.stringContaining("metadata") });
    expect(await evaluateDestination(enabled, "loopback.example.test", 80, options())).toMatchObject({ ok: false, reason: "address_not_allowed" });
    expect(await evaluateDestination(enabled, "azure.example.test", 80, options())).toMatchObject({ ok: false, reason: "address_not_allowed" });
    expect(await evaluateDestination(enabled, "mixed.example.test", 80, options())).toMatchObject({ ok: true, addresses: ["93.184.216.10"] });
  });

  it("lets operators allow named private hosts, but never protected ranges", async () => {
    const allowCorp = options({ privateHosts: new Set(["internal.corp.test", "peer.example.test", "loopback.example.test"]) });
    expect(await evaluateDestination(enabled, "internal.corp.test", 443, options())).toMatchObject({ ok: false, reason: "address_not_allowed" });
    expect(await evaluateDestination(enabled, "internal.corp.test", 443, allowCorp)).toMatchObject({ ok: true, addresses: ["10.20.30.40"] });
    expect(await evaluateDestination(enabled, "peer.example.test", 443, allowCorp)).toMatchObject({ ok: false, reason: "address_not_allowed" });
    expect(await evaluateDestination(enabled, "loopback.example.test", 443, allowCorp)).toMatchObject({ ok: false, reason: "address_not_allowed" });
  });

  it("applies operator block lists to public addresses", async () => {
    const blocked = options({ blockedCidrs: [parseCidr("151.101.0.0/16"), parseCidr("2a04:4e42::/32")] });
    expect(await evaluateDestination(enabled, "pypi.org", 443, blocked)).toMatchObject({ ok: false, reason: "address_not_allowed" });
  });

  it("reports resolution failures and timeouts without treating them as policy blocks", async () => {
    expect(await evaluateDestination(enabled, "missing.example.test", 443, options())).toMatchObject({ ok: false, reason: "dns_failed", status: 502 });
    const slow = options({ resolve: () => new Promise(() => undefined), dnsTimeoutMs: 20 });
    expect(await evaluateDestination(enabled, "pypi.org", 443, slow)).toMatchObject({ ok: false, reason: "dns_failed" });
  });
});
