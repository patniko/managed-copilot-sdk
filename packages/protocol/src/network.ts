/**
 * Network policy normalization, inheritance, narrowing, and host matching (spec section 7).
 *
 * - Omitted: inherit the containing environment/deployment setting; enabled only if nothing was supplied.
 * - `true`: public outbound access, subject to non-overridable platform protections.
 * - A host list: restricted access. `*.example.com` matches subdomains, not the apex `example.com`.
 * - `false` or an empty host list: no workload outbound access.
 */

export type NetworkAccess = "enabled" | "restricted" | "disabled";

export interface NetworkPolicy {
  readonly access: NetworkAccess;
  /** Normalized lowercase host patterns; non-empty only when `access` is `restricted`. */
  readonly allowedDomains: readonly string[];
}

export type NetworkSetting =
  | boolean
  | readonly string[]
  | { readonly access: NetworkAccess; readonly allowedDomains?: readonly string[] };

export const NETWORK_ENABLED: NetworkPolicy = Object.freeze({ access: "enabled", allowedDomains: Object.freeze([]) });
export const NETWORK_DISABLED: NetworkPolicy = Object.freeze({ access: "disabled", allowedDomains: Object.freeze([]) });

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes one host pattern (`example.com` or `*.example.com`). Throws on schemes, ports, paths, bad labels, and
 * single-label names such as `localhost` or internal container names, which are never valid egress destinations.
 */
export function normalizeHostPattern(pattern: string): string {
  const value = pattern.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = value.startsWith("*.");
  const host = wildcard ? value.slice(2) : value;
  const labels = host.split(".");
  if (!host || labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) {
    throw new TypeError(`Invalid network host pattern "${pattern}". Use a host name such as "example.com" or "*.example.com".`);
  }
  return wildcard ? `*.${host}` : host;
}

/**
 * Normalizes a request host for matching: lowercase, no trailing dots, no `:port`, and IPv6 brackets removed.
 * IP literals never match host patterns.
 */
export function normalizeHostname(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  const withPort = /^([^:]+):\d+$/.exec(value);
  return (withPort ? withPort[1]! : value).replace(/\.+$/, "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function restricted(domains: readonly string[]): NetworkPolicy {
  const allowedDomains = unique(domains.map(normalizeHostPattern));
  return allowedDomains.length === 0 ? NETWORK_DISABLED : { access: "restricted", allowedDomains };
}

/** Resolves a setting against the policy it inherits from when omitted. */
export function normalizeNetwork(setting: NetworkSetting | undefined, inherited: NetworkPolicy = NETWORK_ENABLED): NetworkPolicy {
  if (setting === undefined) return inherited;
  if (setting === true) return NETWORK_ENABLED;
  if (setting === false) return NETWORK_DISABLED;
  if (Array.isArray(setting)) return restricted(setting as readonly string[]);
  const object = setting as { readonly access: NetworkAccess; readonly allowedDomains?: readonly string[] };
  switch (object.access) {
    case "enabled":
      return NETWORK_ENABLED;
    case "disabled":
      return NETWORK_DISABLED;
    case "restricted":
      return restricted(object.allowedDomains ?? []);
    default:
      throw new TypeError(`Unknown network access "${String((object as { access?: unknown }).access)}".`);
  }
}

/** Returns true when `host` (which may carry a port) matches a normalized `pattern`. Wildcards match subdomains only, never the apex. */
export function hostMatches(pattern: string, host: string): boolean {
  const normalizedHost = normalizeHostname(host);
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return normalizedHost.length > suffix.length && normalizedHost.endsWith(suffix);
  }
  return normalizedHost === pattern;
}

/** Host-level decision only; platform protections (metadata, loopback, internals) are enforced separately. */
export function isHostAllowed(policy: NetworkPolicy, host: string): boolean {
  switch (policy.access) {
    case "enabled":
      return true;
    case "disabled":
      return false;
    case "restricted":
      return policy.allowedDomains.some((pattern) => hostMatches(pattern, host));
  }
}

/** The narrower of two normalized patterns when they overlap, otherwise undefined. */
function intersectPatterns(requested: string, ceiling: string): string | undefined {
  const requestedWildcard = requested.startsWith("*.");
  const ceilingWildcard = ceiling.startsWith("*.");
  if (!requestedWildcard && !ceilingWildcard) return requested === ceiling ? requested : undefined;
  if (!requestedWildcard) return hostMatches(ceiling, requested) ? requested : undefined;
  if (!ceilingWildcard) return hostMatches(requested, ceiling) ? ceiling : undefined;
  const requestedSuffix = requested.slice(2);
  const ceilingSuffix = ceiling.slice(2);
  if (requestedSuffix === ceilingSuffix || requestedSuffix.endsWith(`.${ceilingSuffix}`)) return requested;
  if (ceilingSuffix.endsWith(`.${requestedSuffix}`)) return ceiling;
  return undefined;
}

/**
 * Applies a caller's requested setting under an environment ceiling. Callers can only narrow:
 * `network: true` cannot re-enable an environment that is disabled or restricted.
 */
export function narrowNetwork(ceiling: NetworkPolicy, requested: NetworkSetting | undefined): NetworkPolicy {
  if (requested === undefined || ceiling.access === "disabled") return ceiling;
  const wanted = normalizeNetwork(requested, ceiling);
  if (wanted.access === "disabled") return NETWORK_DISABLED;
  if (wanted.access === "enabled") return ceiling;
  if (ceiling.access === "enabled") return wanted;
  const overlap: string[] = [];
  for (const requestedPattern of wanted.allowedDomains) {
    for (const ceilingPattern of ceiling.allowedDomains) {
      const narrower = intersectPatterns(requestedPattern, ceilingPattern);
      if (narrower) overlap.push(narrower);
    }
  }
  return restricted(overlap);
}

/** One-line description of a policy for messages, e.g. `restricted to github.com, *.githubusercontent.com`. */
export function describeNetwork(policy: NetworkPolicy): string {
  switch (policy.access) {
    case "enabled":
      return "public outbound access";
    case "disabled":
      return "no outbound access (network: false)";
    case "restricted":
      return `restricted to ${policy.allowedDomains.join(", ")}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Addresses: non-overridable platform protections (spec section 7). Every destination is checked after DNS
// resolution, and connections go to the validated address only.
// ---------------------------------------------------------------------------------------------------------------

/** Why an address is (or is not) reachable from workloads. Only `public` addresses are ever allowed by default. */
export type AddressClass =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "shared"
  | "link_local"
  | "metadata"
  | "multicast"
  | "broadcast"
  | "documentation"
  | "benchmark"
  | "reserved"
  | "ipv6_transition";

export interface ParsedAddress {
  readonly version: 4 | 6;
  readonly bytes: Uint8Array;
}

const IPV4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

function parseIpv4(text: string): Uint8Array | undefined {
  if (!IPV4.test(text)) return undefined;
  const parts = text.split(".").map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return Uint8Array.from(parts);
}

function parseIpv6(text: string): Uint8Array | undefined {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.length > 45) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (piece.includes(".")) {
        if (i !== pieces.length - 1) return undefined;
        const v4 = parseIpv4(piece);
        if (!v4) return undefined;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/**
 * Parses a canonical IPv4 dotted quad or an IPv6 address (optionally in brackets). Zone IDs, octal/hex/integer
 * IPv4 forms, and anything else are rejected (`undefined`).
 */
export function parseIpAddress(text: string): ParsedAddress | undefined {
  const value = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const v4 = parseIpv4(value);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIpv6(value);
  return v6 ? { version: 6, bytes: v6 } : undefined;
}

/** Formats parsed bytes back to a canonical string (IPv6 without zero compression). */
export function formatIpAddress(address: ParsedAddress): string {
  if (address.version === 4) return [...address.bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((address.bytes[i]! << 8) | address.bytes[i + 1]!).toString(16));
  return groups.join(":");
}

export interface Cidr {
  readonly version: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

/** Parses `10.0.0.0/8`, `fd00::/8`, or a bare address (a host route). */
export function parseCidr(text: string): Cidr {
  const [addressText, prefixText] = text.trim().split("/");
  const address = parseIpAddress(addressText ?? "");
  const max = address?.version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (!address || !(prefix >= 0 && prefix <= max)) throw new TypeError(`Invalid CIDR "${text}"`);
  return { version: address.version, bytes: address.bytes, prefix };
}

function prefixMatches(bytes: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const whole = Math.floor(prefix / 8);
  for (let i = 0; i < whole; i++) if (bytes[i] !== network[i]) return false;
  const rest = prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((bytes[whole] ?? 0) & mask) === ((network[whole] ?? 0) & mask);
}

export function cidrContains(cidr: Cidr, address: ParsedAddress): boolean {
  return cidr.version === address.version && prefixMatches(address.bytes, cidr.bytes, cidr.prefix);
}

const V4_RANGES: readonly (readonly [string, AddressClass])[] = [
  ["168.63.129.16/32", "metadata"], // Azure platform (WireServer, DNS, health probes)
  ["169.254.169.254/32", "metadata"], // AWS, Azure, GCP, OCI instance metadata
  ["169.254.169.253/32", "metadata"], // AWS VPC DNS
  ["169.254.170.2/32", "metadata"], // AWS ECS task metadata
  ["100.100.100.200/32", "metadata"], // Alibaba Cloud metadata
  ["192.0.0.192/32", "metadata"], // Oracle Cloud metadata
  ["0.0.0.0/8", "unspecified"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "shared"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link_local"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "reserved"],
  ["192.0.2.0/24", "documentation"],
  ["192.88.99.0/24", "reserved"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "benchmark"],
  ["198.51.100.0/24", "documentation"],
  ["203.0.113.0/24", "documentation"],
  ["224.0.0.0/4", "multicast"],
  ["255.255.255.255/32", "broadcast"],
  ["240.0.0.0/4", "reserved"],
];

const V6_RANGES: readonly (readonly [string, AddressClass])[] = [
  ["fd00:ec2::254/128", "metadata"], // AWS instance metadata over IPv6
  ["::/128", "unspecified"],
  ["::1/128", "loopback"],
  ["64:ff9b:1::/48", "ipv6_transition"],
  ["100::/64", "reserved"],
  ["2001::/32", "ipv6_transition"], // Teredo
  ["2001:db8::/32", "documentation"],
  ["2001::/23", "reserved"],
  ["2002::/16", "ipv6_transition"], // 6to4
  ["3fff::/20", "documentation"],
  ["fc00::/7", "private"],
  ["fe80::/10", "link_local"],
  ["fec0::/10", "reserved"],
  ["ff00::/8", "multicast"],
];

const V4_TABLE = V4_RANGES.map(([cidr, kind]) => [parseCidr(cidr), kind] as const);
const V6_TABLE = V6_RANGES.map(([cidr, kind]) => [parseCidr(cidr), kind] as const);
const V4_MAPPED = parseCidr("::ffff:0:0/96");
const NAT64 = parseCidr("64:ff9b::/96");
const V4_COMPATIBLE = parseCidr("::/96");
const GLOBAL_UNICAST = parseCidr("2000::/3");

function classifyParsed(address: ParsedAddress): AddressClass {
  if (address.version === 4) {
    for (const [cidr, kind] of V4_TABLE) if (cidrContains(cidr, address)) return kind;
    return "public";
  }
  // IPv4 embedded in IPv6 (mapped or NAT64) is judged by the IPv4 address it reaches.
  if (cidrContains(V4_MAPPED, address) || cidrContains(NAT64, address)) {
    return classifyParsed({ version: 4, bytes: address.bytes.slice(12) });
  }
  for (const [cidr, kind] of V6_TABLE) if (cidrContains(cidr, address)) return kind;
  if (cidrContains(V4_COMPATIBLE, address)) return "reserved";
  return cidrContains(GLOBAL_UNICAST, address) ? "public" : "reserved";
}

/** Classifies an IP address string. Unparseable input is `reserved` (never reachable). */
export function classifyAddress(ip: string): AddressClass {
  const parsed = parseIpAddress(ip);
  return parsed ? classifyParsed(parsed) : "reserved";
}

export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === "public";
}

/** Human-readable reason for a non-public address class, for block messages. */
export function describeAddressClass(kind: AddressClass): string {
  const text: Record<AddressClass, string> = {
    public: "a public address",
    unspecified: "an unspecified address",
    loopback: "a loopback address",
    private: "a private network address",
    shared: "a carrier-grade NAT address",
    link_local: "a link-local address",
    metadata: "a cloud metadata or platform address",
    multicast: "a multicast address",
    broadcast: "a broadcast address",
    documentation: "a documentation address",
    benchmark: "a benchmarking address",
    reserved: "a reserved address",
    ipv6_transition: "an IPv6 transition address",
  };
  return text[kind];
}

/**
 * Validates a destination host from a request (URL host, CONNECT authority, or SNI): lowercase, no trailing dot,
 * DNS-name characters only. IP literals are returned in canonical form with `ip` set. Returns `undefined` for
 * anything ambiguous, such as non-canonical numeric forms (`0x7f.1`, `2130706433`) that some resolvers would
 * silently turn into addresses.
 */
export function normalizeDestinationHost(host: string): { readonly host: string; readonly ip?: ParsedAddress } | undefined {
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253) return undefined;
  const ip = parseIpAddress(value);
  if (ip) return { host: formatIpAddress(ip), ip };
  if (value.startsWith("[")) return undefined;
  const labels = value.split(".");
  if (!labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return undefined;
  // Every-label-numeric or hex-looking final labels are not DNS names; resolvers may parse them as addresses.
  const last = labels[labels.length - 1]!;
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return undefined;
  return { host: value };
}

// ---------------------------------------------------------------------------------------------------------------
// Destination decisions shared by the egress proxy and gateway-side fetches (web_fetch, the MCP adapter): session
// policy, ports, and platform protections, evaluated on the addresses DNS actually returned. Callers must connect
// only to the returned addresses so that a later DNS answer (rebinding) cannot redirect the connection.
// ---------------------------------------------------------------------------------------------------------------

export type DestinationResolver = (host: string) => Promise<string[]>;

export interface DestinationCheckOptions {
  readonly allowedPorts: ReadonlySet<number>;
  /** Exact host names the operator allows to resolve to private (RFC 1918 / ULA / CGNAT) addresses. */
  readonly privateHosts: ReadonlySet<string>;
  /** Never reachable, even for `privateHosts` (sandbox networks, platform services). Evaluated per decision. */
  readonly protectedCidrs: () => readonly Cidr[];
  /** Additional operator blocks. */
  readonly blockedCidrs: readonly Cidr[];
  readonly resolve: DestinationResolver;
  readonly dnsTimeoutMs: number;
}

export type DestinationDecision =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly addresses: readonly string[]; readonly ipLiteral: boolean }
  | {
      readonly ok: false;
      /** Policy blocks are reported to the session; resolution failures (`dns_failed`) are not. */
      readonly reason: EgressBlockReason | "dns_failed";
      readonly status: number;
      readonly message: string;
      readonly host?: string;
      readonly port?: number;
    };

function inAnyCidr(cidrs: readonly Cidr[], address: string): boolean {
  const parsed = parseIpAddress(address);
  return parsed !== undefined && cidrs.some((cidr) => cidrContains(cidr, parsed));
}

function addressAllowed(host: string, address: string, options: DestinationCheckOptions): { ok: true } | { ok: false; why: string } {
  const kind = classifyAddress(address);
  if (inAnyCidr(options.blockedCidrs, address)) return { ok: false, why: "an address blocked by the operator" };
  if (kind === "public") return { ok: true };
  if ((kind === "private" || kind === "shared") && options.privateHosts.has(host) && !inAnyCidr(options.protectedCidrs(), address)) return { ok: true };
  return { ok: false, why: describeAddressClass(kind) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
    }),
  ]);
}

/** Decides whether a workload with `policy` may connect to `rawHost:port`, and to which addresses. */
export async function evaluateDestination(policy: NetworkPolicy, rawHost: string, port: number, options: DestinationCheckOptions): Promise<DestinationDecision> {
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
    const decision = addressAllowed(host, host, options);
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
    return { ok: false, reason: "dns_failed", status: 502, message: `Could not resolve ${host}: ${(error as { code?: string }).code ?? (error as Error).message}.`, host, port };
  }
  const allowed: string[] = [];
  let firstBlocked: { address: string; why: string } | undefined;
  for (const address of resolved) {
    if (!parseIpAddress(address)) continue;
    const decision = addressAllowed(host, address, options);
    if (decision.ok) {
      if (!allowed.includes(address)) allowed.push(address);
    } else {
      firstBlocked ??= { address, why: decision.why };
    }
  }
  if (allowed.length === 0) {
    if (!firstBlocked) return { ok: false, reason: "dns_failed", status: 502, message: `Could not resolve ${host}: no addresses.`, host, port };
    return { ok: false, reason: "address_not_allowed", status: 403, message: `${host} resolves to ${firstBlocked.address}, ${firstBlocked.why}, which workloads cannot reach.`, host, port };
  }
  return { ok: true, host, port, addresses: allowed, ipLiteral: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Vault placeholders and destinations (spec section 8).
// ---------------------------------------------------------------------------------------------------------------

/** Sandbox credentials are opaque per-session placeholders such as `mcv_placeholder_6f1c…` (40 hex digits). */
export const VAULT_PLACEHOLDER_PREFIX = "mcv_placeholder_";
const PLACEHOLDER_SOURCE = `${VAULT_PLACEHOLDER_PREFIX}[0-9a-f]{40}`;

export function isVaultPlaceholder(value: string): boolean {
  return new RegExp(`^${PLACEHOLDER_SOURCE}$`).test(value);
}

/** Every placeholder-shaped token in `text`, in order of appearance (duplicates included). */
export function findVaultPlaceholders(text: string): string[] {
  return text.match(new RegExp(PLACEHOLDER_SOURCE, "g")) ?? [];
}

export interface VaultDestination {
  /** Exact lowercase host name; wildcards, IP literals, and single-label names are not allowed. */
  readonly host: string;
  /** Always 443: vault credentials are only substituted over HTTPS on the default port. */
  readonly port: number;
}

/** Parses a vault credential destination: an exact HTTPS host name such as `api.stripe.com`. */
export function parseVaultDestination(value: string): VaultDestination {
  let pattern: string | undefined;
  try {
    pattern = value.trim().startsWith("*.") ? undefined : normalizeHostPattern(value);
  } catch {
    pattern = undefined;
  }
  if (!pattern || /^[\d.]+$/.test(pattern) || !normalizeDestinationHost(pattern)) {
    throw new TypeError(`Invalid vault host "${value}". Use an exact HTTPS host name such as "api.stripe.com"; wildcards, ports, and IP addresses are not allowed.`);
  }
  return { host: pattern, port: 443 };
}

/** Header names the proxy never substitutes into (framing, routing, and proxy control). */
export const VAULT_FORBIDDEN_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "expect",
];

/** Environment variables a vault credential cannot use (sandbox identity, proxy, trust, and runtime settings). */
export function isReservedEnvName(name: string): boolean {
  return (
    /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|FTP_PROXY|PATH|HOME|USER|SHELL|PWD|HOSTNAME|LANG|TZ|TERM|TMPDIR|LD_PRELOAD|LD_LIBRARY_PATH)$/i.test(name) ||
    /^(NODE_|NPM_CONFIG_|PIP_|PYTHON|SSL_|REQUESTS_|CURL_|GIT_|COPILOT_|MANAGED_COPILOT_|GITHUB_|GH_)/i.test(name)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Egress proxy contract: the gateway's internal API that the egress proxy (platform/egress) calls. Authenticated
// with `EGRESS_KEY_HEADER`, never exposed to workloads.
// ---------------------------------------------------------------------------------------------------------------

/** Name and port sandboxes use to reach the egress proxy on the internal sandbox network. */
export const EGRESS_PROXY_HOST = "mc-egress";
export const EGRESS_PROXY_PORT = 3128;
export const EGRESS_KEY_HEADER = "x-managed-copilot-egress-key";

export const EGRESS_ROUTES = {
  /** `POST` EgressHello → EgressHelloResponse. The proxy announces itself and publishes its CA certificate. */
  hello: "/internal/egress/v1/hello",
  /** `GET` server-sent events: `snapshot` (EgressSnapshot), `upsert` (EgressRegistration), `remove` ({ sandboxId }), `ping`. */
  stream: "/internal/egress/v1/stream",
  /** `POST` EgressSecretRequest → EgressSecretResponse. Authorizes one use of a vault credential. */
  secret: "/internal/egress/v1/secrets/resolve",
  /** `POST` { reports: EgressReport[] } → 204. Blocked attempts and credential misuse, never credentials. */
  reports: "/internal/egress/v1/reports",
} as const;

export interface EgressHello {
  readonly instanceId: string;
  readonly version: string;
  /** PEM of the CA the proxy uses for vault TLS termination. Its private key never leaves the proxy. */
  readonly caCertificate: string;
}

export interface EgressHelloResponse {
  readonly deployment: string;
  /** The gateway pings the stream at this interval; the proxy treats silence beyond twice this as disconnection. */
  readonly heartbeatSeconds: number;
}

/** One vault credential bound to a sandbox: the placeholder the proxy may substitute, and where. */
export interface EgressCredentialBinding {
  readonly id: string;
  readonly placeholder: string;
  readonly destinations: readonly VaultDestination[];
  /** Lowercase request header names eligible for substitution. */
  readonly headers: readonly string[];
}

/** Everything the proxy needs to authenticate a sandbox and enforce its effective policy. */
export interface EgressRegistration {
  readonly sandboxId: string;
  readonly sessionId: string;
  /** Hex SHA-256 of the proxy password; the password itself is only in the sandbox environment. */
  readonly credentialHash: string;
  /** When set, the proxy accepts this credential only from this source address. */
  readonly address?: string;
  readonly policy: NetworkPolicy;
  readonly credentials: readonly EgressCredentialBinding[];
  readonly revision: number;
}

export interface EgressSnapshot {
  readonly registrations: readonly EgressRegistration[];
  readonly issuedAt: string;
}

export interface EgressSecretRequest {
  readonly sandboxId: string;
  readonly credentialId: string;
  readonly placeholder: string;
  readonly host: string;
  readonly port: number;
  readonly header: string;
}

export interface EgressSecretResponse {
  readonly value: string;
}

export type EgressBlockReason =
  | "network_disabled"
  | "host_not_allowed"
  | "ip_literal_not_allowed"
  | "port_not_allowed"
  | "address_not_allowed"
  | "invalid_destination"
  | "sni_mismatch"
  | "non_tls_tunnel"
  | "authority_mismatch"
  | "credential_misuse"
  | "credential_revoked"
  | "tls_client_untrusted"
  | "upstream_tls_failed"
  | "unsupported_request"
  | "policy_unavailable";

/** A blocked or rejected attempt, reported for the owning session. Never carries credentials or query strings. */
export interface EgressReport {
  readonly sandboxId: string;
  readonly sessionId?: string;
  readonly at: string;
  readonly reason: EgressBlockReason;
  readonly host?: string;
  readonly port?: number;
  readonly method?: string;
  /** Request path without the query string. */
  readonly path?: string;
  readonly message: string;
}

/** Platform event type published when a session's egress is blocked. */
export const NETWORK_BLOCKED_EVENT = "network.blocked";

/** `GET /v1/sessions/:id/network`: a session's effective policy, bound vaults (no values), and recent blocks. */
export interface SessionNetworkInfo {
  readonly sessionId: string;
  /** Declared environment the policy derives from; absent for inline environments. */
  readonly environment?: string;
  readonly policy: NetworkPolicy;
  readonly vaults: readonly { readonly id: string; readonly name: string; readonly kind: "apphost" | "user" }[];
  /** Newest first. */
  readonly blocked: readonly EgressReport[];
}

export const NETWORK_ROUTES = {
  sessionNetwork: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/network`,
} as const;
