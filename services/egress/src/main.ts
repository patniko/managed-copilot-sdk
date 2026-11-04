/**
 * Egress proxy entry point. Configuration comes from the environment (set by the gateway's egress supervisor):
 *
 * EGRESS_GATEWAY_URL      Gateway base URL reachable from the container (required)
 * EGRESS_GATEWAY_KEY      Egress-scoped key for the gateway's internal API (required)
 * EGRESS_LISTEN           host:port to listen on (default 0.0.0.0:3128)
 * EGRESS_DATA_DIR         Where a generated CA is persisted, as ca/cert.pem and ca/key.pem; first creation is atomic
 *                         and exclusive, so proxies sharing the directory (NFS) agree on one CA
 *                         (default /var/lib/managed-copilot-egress)
 * EGRESS_CA_CERT_FILE / EGRESS_CA_KEY_FILE   Operator-provided CA instead of a generated one
 * EGRESS_ALLOWED_PORTS    Destination ports workloads may use (default 80,443)
 * EGRESS_PRIVATE_HOSTS    Exact host names allowed to resolve to private addresses (default none)
 * EGRESS_PROTECTED_CIDRS  Never reachable, even for private hosts (default 10.213.0.0/16)
 * EGRESS_BLOCKED_CIDRS    Additional blocked ranges
 * EGRESS_UPSTREAM_CA_FILE / EGRESS_UPSTREAM_CA_B64   Extra CAs trusted for upstream TLS
 * EGRESS_STALE_SECONDS    Fail closed after the gateway link is down this long (default 30)
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { normalizeDestinationHost, parseCidr, type Cidr } from "@managed-copilot/protocol";
import { loadOrCreateCa } from "./ca.js";
import { systemResolver } from "./destination.js";
import { GatewayLink } from "./gateway-link.js";
import { createLogger } from "./log.js";
import { EgressProxy, parseAuthority } from "./proxy.js";
import { Registry } from "./registry.js";

const VERSION = "0.1.0";
const env = process.env;
const log = createLogger("egress");

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(name: string): string {
  const value = env[name];
  if (!value) {
    log.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

/** Subnets of every interface except loopback and the one holding the default route (the Internet side). */
function localProtectedCidrs(): Cidr[] {
  let defaultInterface: string | undefined;
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const [name, destination] = line.trim().split(/\s+/);
      if (destination === "00000000") defaultInterface = name;
    }
  } catch {
    defaultInterface = undefined;
  }
  const cidrs: Cidr[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (name === defaultInterface) continue;
    for (const address of addresses ?? []) {
      if (address.internal || !address.cidr) continue;
      try {
        cidrs.push(parseCidr(address.cidr));
      } catch {
        // Ignore interface addresses that are not plain IPv4/IPv6 (for example with zone IDs).
      }
    }
  }
  return cidrs;
}

let cachedProtected: { at: number; cidrs: readonly Cidr[] } | undefined;
const configuredProtected = list(env.EGRESS_PROTECTED_CIDRS ?? "10.213.0.0/16").map(parseCidr);
function protectedCidrs(): readonly Cidr[] {
  const now = Date.now();
  if (!cachedProtected || now - cachedProtected.at > 5_000) cachedProtected = { at: now, cidrs: [...configuredProtected, ...localProtectedCidrs()] };
  return cachedProtected.cidrs;
}

function upstreamCa(): string[] {
  const out: string[] = [];
  if (env.EGRESS_UPSTREAM_CA_FILE && existsSync(env.EGRESS_UPSTREAM_CA_FILE)) out.push(readFileSync(env.EGRESS_UPSTREAM_CA_FILE, "utf8"));
  if (env.EGRESS_UPSTREAM_CA_B64) out.push(Buffer.from(env.EGRESS_UPSTREAM_CA_B64, "base64").toString("utf8"));
  return out;
}

const gatewayUrl = required("EGRESS_GATEWAY_URL");
const gatewayKey = required("EGRESS_GATEWAY_KEY");
const listen = parseAuthority(env.EGRESS_LISTEN ?? "0.0.0.0:3128");
if (!listen) {
  log.error("EGRESS_LISTEN must be host:port");
  process.exit(2);
}

const { ca, created } = loadOrCreateCa({
  dataDir: env.EGRESS_DATA_DIR ?? "/var/lib/managed-copilot-egress",
  ...(env.EGRESS_CA_CERT_FILE ? { certFile: env.EGRESS_CA_CERT_FILE } : {}),
  ...(env.EGRESS_CA_KEY_FILE ? { keyFile: env.EGRESS_CA_KEY_FILE } : {}),
});

const registry = new Registry({
  staleMs: Number(env.EGRESS_STALE_SECONDS ?? 30) * 1000,
  maxConnectionsPerSandbox: Number(env.EGRESS_MAX_CONNECTIONS_PER_SANDBOX ?? 256),
});

const link = new GatewayLink({
  url: gatewayUrl,
  key: gatewayKey,
  registry,
  hello: { instanceId: randomUUID(), version: VERSION, caCertificate: ca.certPem },
  log,
});

const privateHosts = new Set(list(env.EGRESS_PRIVATE_HOSTS).flatMap((host) => normalizeDestinationHost(host)?.host ?? []));

const proxy = new EgressProxy({
  registry,
  secrets: link,
  reporter: link,
  ca,
  destination: {
    allowedPorts: new Set(list(env.EGRESS_ALLOWED_PORTS ?? "80,443").map(Number).filter((port) => port > 0 && port < 65536)),
    privateHosts,
    protectedCidrs,
    blockedCidrs: list(env.EGRESS_BLOCKED_CIDRS).map(parseCidr),
    resolve: systemResolver,
    dnsTimeoutMs: 5_000,
  },
  upstreamCa: upstreamCa(),
  idleTimeoutMs: Number(env.EGRESS_IDLE_TIMEOUT_SECONDS ?? 900) * 1000,
  log,
});

const address = await proxy.listen(listen.port, listen.host);
log.info("Managed Copilot egress proxy listening", {
  address: `${address.address}:${address.port}`,
  version: VERSION,
  ca: created ? "created" : "loaded",
  caFingerprint: ca.fingerprint,
  privateHosts: [...privateHosts],
});
link.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("Shutting down", { signal });
    void Promise.allSettled([link.stop(), proxy.close()]).finally(() => process.exit(0));
  });
}
