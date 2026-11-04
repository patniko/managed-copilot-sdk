import { createHash } from "node:crypto";

/**
 * Docker's default address pools hold only about thirty bridge networks, so a few local platforms on one engine
 * (separate checkouts, `MANAGED_COPILOT_PORT_OFFSET` copies, end-to-end tests) exhaust them and Docker refuses new
 * networks ("all predefined address pools have been fully subnetted"). The platform therefore gives every network it
 * creates an explicit subnet: each sandbox's own network a /28 from `MANAGED_COPILOT_SANDBOX_SUBNET_POOL`, and each
 * instance's shared networks (edge, sandboxes, egress WAN) a /24 from `MANAGED_COPILOT_NETWORK_SUBNET_POOL`.
 */
export const DEFAULT_NETWORK_SUBNET_POOL = "10.214.0.0";

/** Candidate /24 subnets for one shared network, in a stable order that starts at a position derived from its name. */
export function sharedNetworkSubnets(name: string, pool: string = DEFAULT_NETWORK_SUBNET_POOL): string[] {
  const octets = pool.split(".").map(Number);
  const [a, b] = octets;
  if (octets.length !== 4 || a === undefined || b === undefined || !octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    throw new Error(`MANAGED_COPILOT_NETWORK_SUBNET_POOL must be an IPv4 address such as ${DEFAULT_NETWORK_SUBNET_POOL} (got "${pool}")`);
  }
  const start = parseInt(createHash("sha256").update(name).digest("hex").slice(0, 4), 16) % 256;
  return Array.from({ length: 256 }, (_, attempt) => `${a}.${b}.${(start + attempt) % 256}.0/24`);
}

/** True when Docker refused an explicit subnet because another network already uses it (try the next candidate). */
export function isSubnetOverlap(message: string): boolean {
  return /overlap/i.test(message);
}
