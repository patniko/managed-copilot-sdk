/**
 * Destination checks shared by every request path: session policy, ports, and the non-overridable platform
 * protections, evaluated on the addresses DNS actually returned. Callers connect only to the returned addresses,
 * so a later DNS answer (rebinding) cannot redirect the connection.
 */
import { lookup } from "node:dns/promises";
import { connect, type Socket } from "node:net";
import {
  cidrContains,
  classifyAddress,
  describeAddressClass,
  describeNetwork,
  isHostAllowed,
  normalizeDestinationHost,
  parseIpAddress,
  type Cidr,
  type EgressBlockReason,
  type NetworkPolicy,
} from "@managed-copilot/protocol";

export type Resolver = (host: string) => Promise<string[]>;
export type Dialer = (address: string, port: number) => Socket;

export interface DestinationOptions {
  readonly allowedPorts: ReadonlySet<number>;
  /** Exact host names the operator allows to resolve to private (RFC 1918 / ULA / CGNAT) addresses. */
  readonly privateHosts: ReadonlySet<string>;
  /** Never reachable, even for `privateHosts` (sandbox networks, platform services). Evaluated per decision. */
  readonly protectedCidrs: () => readonly Cidr[];
  /** Additional operator blocks. */
  readonly blockedCidrs: readonly Cidr[];
  readonly resolve: Resolver;
  readonly dnsTimeoutMs: number;
}

export type Decision =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly addresses: readonly string[]; readonly ipLiteral: boolean }
  | {
      readonly ok: false;
      /** Policy blocks are reported to the session; resolution failures are not. */
      readonly reason: EgressBlockReason | "dns_failed";
      readonly status: number;
      readonly message: string;
      readonly host?: string;
      readonly port?: number;
    };

export const systemResolver: Resolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

export const systemDialer: Dialer = (address, port) => connect({ host: address, port });

function inAny(cidrs: readonly Cidr[], address: string): boolean {
  const parsed = parseIpAddress(address);
  return parsed !== undefined && cidrs.some((cidr) => cidrContains(cidr, parsed));
}

function addressDecision(host: string, address: string, options: DestinationOptions): { ok: true } | { ok: false; why: string } {
  const kind = classifyAddress(address);
  if (inAny(options.blockedCidrs, address)) return { ok: false, why: "an address blocked by the operator" };
  if (kind === "public") return { ok: true };
  if ((kind === "private" || kind === "shared") && options.privateHosts.has(host) && !inAny(options.protectedCidrs(), address)) return { ok: true };
  return { ok: false, why: describeAddressClass(kind) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
    }),
  ]);
}

/** Decides whether a sandbox with `policy` may connect to `rawHost:port`, and to which addresses. */
export async function evaluateDestination(policy: NetworkPolicy, rawHost: string, port: number, options: DestinationOptions): Promise<Decision> {
  const normalized = normalizeDestinationHost(rawHost);
  const shown = normalized?.host ?? rawHost.slice(0, 100);
  if (!normalized || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "invalid_destination", status: 400, message: `"${shown}" is not a valid destination host.`, host: shown, port };
  }
  const host = normalized.host;
  if (policy.access === "disabled") {
    return { ok: false, reason: "network_disabled", status: 403, message: `Outbound network access is disabled for this session (network: false), so ${host} is unreachable.`, host, port };
  }
  if (!options.allowedPorts.has(port)) {
    const ports = [...options.allowedPorts].sort((a, b) => a - b).join(", ");
    return { ok: false, reason: "port_not_allowed", status: 403, message: `Port ${port} is not allowed for outbound connections (allowed ports: ${ports}).`, host, port };
  }
  if (normalized.ip) {
    if (policy.access === "restricted") {
      return { ok: false, reason: "ip_literal_not_allowed", status: 403, message: `Direct IP connections are not allowed when network access is ${describeNetwork(policy)}.`, host, port };
    }
    const decision = addressDecision(host, host, options);
    if (!decision.ok) return { ok: false, reason: "address_not_allowed", status: 403, message: `${host} is ${decision.why}, which workloads cannot reach.`, host, port };
    return { ok: true, host, port, addresses: [host], ipLiteral: true };
  }
  if (!isHostAllowed(policy, host)) {
    return { ok: false, reason: "host_not_allowed", status: 403, message: `${host} is not an allowed host for this session (network access is ${describeNetwork(policy)}).`, host, port };
  }
  let resolved: string[];
  try {
    resolved = await withTimeout(options.resolve(host), options.dnsTimeoutMs);
  } catch (error) {
    return { ok: false, reason: "dns_failed", status: 502, message: `Could not resolve ${host}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.`, host, port };
  }
  const allowed: string[] = [];
  let firstBlocked: { address: string; why: string } | undefined;
  for (const address of resolved) {
    const canonical = parseIpAddress(address) ? address : undefined;
    if (!canonical) continue;
    const decision = addressDecision(host, canonical, options);
    if (decision.ok) {
      if (!allowed.includes(canonical)) allowed.push(canonical);
    } else {
      firstBlocked ??= { address: canonical, why: decision.why };
    }
  }
  if (allowed.length === 0) {
    if (!firstBlocked) return { ok: false, reason: "dns_failed", status: 502, message: `Could not resolve ${host}: no addresses.`, host, port };
    return {
      ok: false,
      reason: "address_not_allowed",
      status: 403,
      message: `${host} resolves to ${firstBlocked.address}, ${firstBlocked.why}, which workloads cannot reach.`,
      host,
      port,
    };
  }
  return { ok: true, host, port, addresses: allowed, ipLiteral: false };
}

/** Connects to the first reachable validated address. Never resolves names. */
export function dialValidated(addresses: readonly string[], port: number, dial: Dialer, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let index = 0;
    let lastError: Error | undefined;
    const attempt = () => {
      const address = addresses[index++];
      if (address === undefined) {
        reject(lastError ?? new Error("No address to connect to"));
        return;
      }
      const socket = dial(address, port);
      const timer = setTimeout(() => socket.destroy(new Error(`Connection to ${address}:${port} timed out`)), timeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        lastError = error;
        socket.destroy();
        attempt();
      };
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        // Keep the process alive if the socket errors before the caller attaches its own handlers.
        socket.on("error", () => undefined);
        resolve(socket);
      });
      socket.once("error", onError);
    };
    attempt();
  });
}
