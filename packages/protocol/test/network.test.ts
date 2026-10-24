import { describe, expect, it } from "vitest";
import {
  cidrContains,
  classifyAddress,
  describeNetwork,
  findVaultPlaceholders,
  formatIpAddress,
  isPublicAddress,
  isReservedEnvName,
  isVaultPlaceholder,
  normalizeDestinationHost,
  normalizeNetwork,
  parseCidr,
  parseIpAddress,
  parseVaultDestination,
} from "../src/network.js";

describe("IP parsing", () => {
  it("parses canonical IPv4 and IPv6, including brackets and embedded IPv4", () => {
    expect(parseIpAddress("10.1.2.3")).toEqual({ version: 4, bytes: Uint8Array.from([10, 1, 2, 3]) });
    expect(formatIpAddress(parseIpAddress("[::1]")!)).toBe("0:0:0:0:0:0:0:1");
    expect(formatIpAddress(parseIpAddress("::ffff:127.0.0.1")!)).toBe("0:0:0:0:0:ffff:7f00:1");
    expect(formatIpAddress(parseIpAddress("2001:DB8::8:800:200C:417A")!)).toBe("2001:db8:0:0:8:800:200c:417a");
    expect(parseIpAddress("1:2:3:4:5:6:7:8")?.version).toBe(6);
  });

  it("rejects ambiguous or malformed forms", () => {
    for (const text of ["0177.0.0.1", "0x7f.0.0.1", "2130706433", "127.1", "1.2.3.256", "fe80::1%eth0", "1:2:3:4:5:6:7:8:9", "1::2::3", "::ffff:1.2.3", ""]) {
      expect(parseIpAddress(text), text).toBeUndefined();
    }
  });

  it("matches CIDR ranges", () => {
    expect(cidrContains(parseCidr("172.16.0.0/12"), parseIpAddress("172.31.255.255")!)).toBe(true);
    expect(cidrContains(parseCidr("172.16.0.0/12"), parseIpAddress("172.32.0.1")!)).toBe(false);
    expect(cidrContains(parseCidr("fc00::/7"), parseIpAddress("fd12::1")!)).toBe(true);
    expect(cidrContains(parseCidr("10.0.0.0/8"), parseIpAddress("::ffff:10.0.0.1")!)).toBe(false);
    expect(() => parseCidr("10.0.0.0/33")).toThrow(/Invalid CIDR/);
  });
});

describe("address classification", () => {
  const cases: [string, string][] = [
    ["8.8.8.8", "public"],
    ["140.82.112.3", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.8", "private"],
    ["172.18.0.2", "private"],
    ["192.168.65.254", "private"],
    ["100.64.0.1", "shared"],
    ["169.254.169.254", "metadata"],
    ["169.254.170.2", "metadata"],
    ["168.63.129.16", "metadata"],
    ["100.100.100.200", "metadata"],
    ["192.0.0.192", "metadata"],
    ["169.254.10.10", "link_local"],
    ["224.0.0.251", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["240.1.2.3", "reserved"],
    ["198.18.5.5", "benchmark"],
    ["203.0.113.9", "documentation"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::808:808", "public"],
    ["::127.0.0.1", "reserved"],
    ["fd00:ec2::254", "metadata"],
    ["fdc4:f303:9324::254", "private"],
    ["fe80::1", "link_local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2001:0:4136:e378::1", "ipv6_transition"],
    ["2002:7f00:1::1", "ipv6_transition"],
    ["2606:4700:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
    ["4000::1", "reserved"],
    ["not-an-ip", "reserved"],
  ];
  it.each(cases)("%s is %s", (ip, kind) => {
    expect(classifyAddress(ip)).toBe(kind);
  });

  it("only public addresses are public", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
  });
});

describe("destination hosts", () => {
  it("normalizes host names and IP literals", () => {
    expect(normalizeDestinationHost("API.Example.com.")).toEqual({ host: "api.example.com" });
    expect(normalizeDestinationHost("[::1]")?.host).toBe("0:0:0:0:0:0:0:1");
    expect(normalizeDestinationHost("10.0.0.1")?.ip?.version).toBe(4);
    expect(normalizeDestinationHost("echo")).toEqual({ host: "echo" });
  });

  it("rejects names resolvers could turn into addresses, and junk", () => {
    for (const host of ["2130706433", "0x7f.1", "127.1", "0177.0.0.1", "a..b", "-a.com", "evil.com\u0000.x", "a b", "", "[1.2.3.4]x"]) {
      expect(normalizeDestinationHost(host), host).toBeUndefined();
    }
  });
});

describe("vault helpers", () => {
  const placeholder = `mcv_placeholder_${"ab12".repeat(10)}`;

  it("recognizes placeholders", () => {
    expect(isVaultPlaceholder(placeholder)).toBe(true);
    expect(isVaultPlaceholder(`${placeholder}0`)).toBe(false);
    expect(findVaultPlaceholders(`Bearer ${placeholder} and ${placeholder}`)).toEqual([placeholder, placeholder]);
    expect(findVaultPlaceholders("Bearer sk_live_123")).toEqual([]);
  });

  it("parses exact HTTPS destinations", () => {
    expect(parseVaultDestination("api.stripe.com")).toEqual({ host: "api.stripe.com", port: 443 });
    expect(parseVaultDestination("API.example.com:8443")).toEqual({ host: "api.example.com", port: 8443 });
    for (const bad of ["*.stripe.com", "https://api.stripe.com", "10.0.0.1", "api.stripe.com:0", "api.stripe.com:99999", "api.stripe.com/v1"]) {
      expect(() => parseVaultDestination(bad), bad).toThrow(/Invalid vault host/);
    }
  });

  it("reserves platform environment names", () => {
    expect(isReservedEnvName("HTTPS_PROXY")).toBe(true);
    expect(isReservedEnvName("NODE_EXTRA_CA_CERTS")).toBe(true);
    expect(isReservedEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isReservedEnvName("STRIPE_API_KEY")).toBe(false);
  });

  it("describes policies", () => {
    expect(describeNetwork(normalizeNetwork(["github.com"]))).toBe("restricted to github.com");
    expect(describeNetwork(normalizeNetwork(false))).toMatch(/network: false/);
  });
});
