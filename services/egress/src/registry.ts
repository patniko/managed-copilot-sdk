/**
 * Sandbox registrations pushed by the gateway: proxy credentials, effective policy, and vault bindings. Tracks open
 * connections per sandbox so revocation or a narrower policy also closes tunnels that are already open.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { formatIpAddress, isHostAllowed, parseIpAddress, type EgressRegistration } from "@managed-copilot/protocol";

export type AuthResult =
  | { readonly ok: true; readonly registration: EgressRegistration }
  | { readonly ok: false; readonly status: 407 | 403 | 503; readonly message: string };

export type TrackResult = { readonly ok: true; readonly untrack: () => void } | { readonly ok: false; readonly status: 403 | 429 | 503; readonly message: string };

const STALE_MESSAGE = "The egress proxy cannot reach the Managed Copilot gateway, so outbound access is paused.";

export interface TrackedConnection {
  readonly host: string;
  readonly ipLiteral: boolean;
  readonly credentialHash: string;
  /** Closes the connection; called when the sandbox is unregistered or its policy no longer allows `host`. */
  close(reason: string): void;
}

export interface RegistryOptions {
  /** Fail closed after the gateway stream has been down this long. */
  readonly staleMs: number;
  readonly maxConnectionsPerSandbox: number;
  readonly now?: () => number;
}

/** Canonical form of a socket address, unwrapping IPv4-mapped IPv6 (`::ffff:10.0.0.5` → `10.0.0.5`). */
export function canonicalAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const parsed = parseIpAddress(address);
  if (!parsed) return undefined;
  const bytes = parsed.bytes;
  if (parsed.version === 6 && bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return formatIpAddress({ version: 4, bytes: bytes.slice(12) });
  }
  return formatIpAddress(parsed);
}

export function hashCredential(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

export function parseProxyAuthorization(header: string | undefined): { readonly user: string; readonly secret: string } | undefined {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header ?? "");
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  return { user: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

export class Registry {
  readonly #options: RegistryOptions;
  readonly #registrations = new Map<string, EgressRegistration>();
  readonly #connections = new Map<string, Set<TrackedConnection>>();
  #synced = false;
  #connected = false;
  #disconnectedAt = 0;
  #staleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RegistryOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** True once a snapshot arrived and the gateway stream has not been down longer than `staleMs`. */
  get ready(): boolean {
    if (!this.#synced) return false;
    return this.#connected || this.#now() - this.#disconnectedAt < this.#options.staleMs;
  }

  get size(): number {
    return this.#registrations.size;
  }

  markConnected(): void {
    this.#connected = true;
    this.#clearStaleTimer();
  }

  /** Starts the stale deadline: if the gateway stream is still down when it expires, every open connection closes. */
  markDisconnected(): void {
    if (this.#connected) {
      this.#disconnectedAt = this.#now();
      this.#clearStaleTimer();
      this.#staleTimer = setTimeout(() => {
        this.#staleTimer = undefined;
        if (this.#connected) return;
        for (const set of [...this.#connections.values()]) {
          for (const connection of [...set]) connection.close("the egress proxy lost contact with the Managed Copilot gateway");
        }
      }, this.#options.staleMs);
      this.#staleTimer.unref?.();
    }
    this.#connected = false;
  }

  #clearStaleTimer(): void {
    if (this.#staleTimer) clearTimeout(this.#staleTimer);
    this.#staleTimer = undefined;
  }

  /** Replaces every registration with a fresh snapshot. */
  replaceAll(registrations: readonly EgressRegistration[]): void {
    const incoming = new Map(registrations.map((registration) => [registration.sandboxId, registration]));
    for (const sandboxId of [...this.#registrations.keys()]) {
      if (!incoming.has(sandboxId)) this.remove(sandboxId);
    }
    for (const registration of registrations) this.upsert(registration);
    this.#synced = true;
    this.markConnected();
  }

  upsert(registration: EgressRegistration): void {
    const previous = this.#registrations.get(registration.sandboxId);
    if (previous && previous.revision > registration.revision) return;
    this.#registrations.set(registration.sandboxId, registration);
    for (const connection of [...(this.#connections.get(registration.sandboxId) ?? [])]) {
      if (connection.credentialHash !== registration.credentialHash) connection.close("the sandbox's proxy credential was rotated");
      else if (!this.allows(registration, connection.host, connection.ipLiteral)) connection.close("the session's network policy no longer allows this host");
    }
  }

  remove(sandboxId: string): void {
    this.#registrations.delete(sandboxId);
    for (const connection of [...(this.#connections.get(sandboxId) ?? [])]) connection.close("the sandbox's egress registration was revoked");
    this.#connections.delete(sandboxId);
  }

  get(sandboxId: string): EgressRegistration | undefined {
    return this.#registrations.get(sandboxId);
  }

  allows(registration: EgressRegistration, host: string, ipLiteral: boolean): boolean {
    if (registration.policy.access === "disabled") return false;
    if (ipLiteral) return registration.policy.access === "enabled";
    return isHostAllowed(registration.policy, host);
  }

  authenticate(header: string | undefined, remoteAddress: string | undefined): AuthResult {
    const credentials = parseProxyAuthorization(header);
    if (!credentials) return { ok: false, status: 407, message: "Proxy authentication is required. Use the HTTP_PROXY/HTTPS_PROXY values the platform set for this sandbox." };
    if (!this.ready) return { ok: false, status: 503, message: STALE_MESSAGE };
    const registration = this.#registrations.get(credentials.user);
    if (!registration || !sameHash(hashCredential(credentials.secret), registration.credentialHash)) {
      return { ok: false, status: 407, message: "The proxy credential is not valid. It may belong to a stopped sandbox." };
    }
    if (registration.address !== undefined && canonicalAddress(registration.address) !== canonicalAddress(remoteAddress)) {
      return { ok: false, status: 403, message: "This proxy credential belongs to a different sandbox." };
    }
    return { ok: true, registration };
  }

  /**
   * Re-checks, synchronously, that the sandbox may still reach `host` under its current registration. Registrations
   * can be revoked, rotated, or narrowed while a request awaits DNS, a dial, or the gateway.
   */
  check(sandboxId: string, credentialHash: string, host: string, ipLiteral: boolean): { readonly ok: true; readonly registration: EgressRegistration } | { readonly ok: false; readonly status: 403 | 503; readonly message: string } {
    if (!this.ready) return { ok: false, status: 503, message: STALE_MESSAGE };
    const registration = this.#registrations.get(sandboxId);
    if (!registration || registration.credentialHash !== credentialHash) return { ok: false, status: 403, message: "This sandbox's egress registration is no longer active." };
    if (!this.allows(registration, host, ipLiteral)) return { ok: false, status: 403, message: `${host} is no longer an allowed destination for this session.` };
    return { ok: true, registration };
  }

  /** Admits an open connection after `check` passes, so a later revocation, rotation, narrowing, or stale gateway link closes it. */
  track(sandboxId: string, connection: TrackedConnection): TrackResult {
    const checked = this.check(sandboxId, connection.credentialHash, connection.host, connection.ipLiteral);
    if (!checked.ok) return checked;
    let set = this.#connections.get(sandboxId);
    if (!set) {
      set = new Set();
      this.#connections.set(sandboxId, set);
    }
    if (set.size >= this.#options.maxConnectionsPerSandbox) return { ok: false, status: 429, message: "Too many concurrent connections from this sandbox." };
    set.add(connection);
    const tracked = set;
    return {
      ok: true,
      untrack: () => {
        tracked.delete(connection);
        if (tracked.size === 0 && this.#connections.get(sandboxId) === tracked) this.#connections.delete(sandboxId);
      },
    };
  }

  connectionCount(sandboxId: string): number {
    return this.#connections.get(sandboxId)?.size ?? 0;
  }
}
