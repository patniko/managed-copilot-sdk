import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Random, URL-safe identifier with a readable prefix, e.g. `act_3kq9...`. No `-`, so IDs survive word-boundary parsing. */
export function newId(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url").replace(/-/g, "0")}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stored form of a bearer secret (claim tokens): never persist the token itself. */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** A UUID (version 8, RFC 9562 "custom") derived from a namespace and name, so retries reproduce the same ID. */
export function deterministicUuid(namespace: string, name: string): string {
  const bytes = createHash("sha256").update(`${namespace}\u0000${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JSON with sorted object keys, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = sortKeys(item);
  }
  return out;
}

export function toIso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : new Date(ms).toISOString();
}

export function parseJson<T = unknown>(text: string | null | undefined): T | undefined {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * The incarnation of a session as core reports it: its immutable `incarnation`, or (until core provides one) its
 * creation time, which also changes whenever a deleted session's ID is reused.
 */
export function incarnationOf(view: { readonly incarnation?: string; readonly createdAt?: string }): string {
  return view.incarnation ?? (view.createdAt ? `created:${view.createdAt}` : "");
}

/** A session that is being or has been deleted accepts no new work. */
export function isGone(view: { readonly state: string } | undefined): boolean {
  return view === undefined || view.state === "deleting" || view.state === "deleted";
}
