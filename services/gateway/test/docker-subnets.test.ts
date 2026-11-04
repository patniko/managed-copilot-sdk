import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK_SUBNET_POOL, isSubnetOverlap, sharedNetworkSubnets } from "../src/docker-subnets.js";

describe("sharedNetworkSubnets", () => {
  it("offers every /24 of the pool once, in a stable order per network name", () => {
    const subnets = sharedNetworkSubnets("mc-12345678-edge");
    expect(subnets).toHaveLength(256);
    expect(new Set(subnets).size).toBe(256);
    expect(subnets.every((subnet) => /^10\.214\.\d{1,3}\.0\/24$/.test(subnet))).toBe(true);
    expect(sharedNetworkSubnets("mc-12345678-edge")).toEqual(subnets);
    expect(DEFAULT_NETWORK_SUBNET_POOL).toBe("10.214.0.0");
  });

  it("starts different networks at different places, so instances rarely probe past each other", () => {
    const names = ["edge", "sandboxes", "egress-wan"].flatMap((suffix) => ["mc-aaaaaaaa", "mc-bbbbbbbb", "mc-cccccccc"].map((instance) => `${instance}-${suffix}`));
    const firsts = new Set(names.map((name) => sharedNetworkSubnets(name)[0]));
    expect(firsts.size).toBeGreaterThan(6);
  });

  it("uses a configured pool and refuses one that isn't an IPv4 address", () => {
    expect(sharedNetworkSubnets("mc-x-edge", "172.30.0.0").every((subnet) => subnet.startsWith("172.30."))).toBe(true);
    expect(() => sharedNetworkSubnets("mc-x-edge", "10.214")).toThrowError(/MANAGED_COPILOT_NETWORK_SUBNET_POOL/);
    expect(() => sharedNetworkSubnets("mc-x-edge", "10.300.0.0")).toThrowError(/MANAGED_COPILOT_NETWORK_SUBNET_POOL/);
  });
});

describe("isSubnetOverlap", () => {
  it("recognizes Docker's overlap refusals and nothing else", () => {
    expect(isSubnetOverlap("Error response from daemon: invalid pool request: Pool overlaps with other one on this address space")).toBe(true);
    expect(isSubnetOverlap("Error response from daemon: network with name mc-x-edge already exists")).toBe(false);
    expect(isSubnetOverlap("error during connect: open //./pipe/docker_engine: The system cannot find the file specified.")).toBe(false);
  });
});
