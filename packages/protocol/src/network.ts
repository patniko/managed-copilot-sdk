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
