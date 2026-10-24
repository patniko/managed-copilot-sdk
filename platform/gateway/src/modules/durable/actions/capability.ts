import { createHmac } from "node:crypto";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { VerifiedCapability } from "../contract.js";
import { newId, safeEqual } from "../ids.js";

/** Bearer prefix of webhook action capabilities. GitHub tokens never start with it. */
export const CAPABILITY_PREFIX = "mcc_";

interface CapabilityClaims {
  readonly v: 1;
  /** Session the listed actions belong to. */
  readonly sid: string;
  /** Action IDs this capability may list, claim, and answer. */
  readonly aids: readonly string[];
  /** Deployment base URL; the capability is useless anywhere else. */
  readonly aud: string;
  /** Expiry, epoch milliseconds. */
  readonly exp: number;
  /** Webhook subscription it was minted for. */
  readonly wh: string;
  readonly jti: string;
}

export function isCapabilityToken(token: string): boolean {
  return token.startsWith(CAPABILITY_PREFIX);
}

export function mintCapabilityToken(key: Buffer, claims: Omit<CapabilityClaims, "v" | "jti">): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims, jti: newId("cap", 9) } satisfies CapabilityClaims), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${CAPABILITY_PREFIX}${payload}.${signature}`;
}

/** Verifies signature, audience, and expiry. Failures are `authentication_required` so callers learn nothing else. */
export function verifyCapabilityToken(key: Buffer, token: string, expected: { readonly audience: string; readonly now: number }): VerifiedCapability {
  const invalid = (why: string) => new ManagedCopilotError("authentication_required", `The action capability is not valid: ${why}`);
  if (!isCapabilityToken(token)) throw invalid("unexpected format");
  const [payload, signature, extra] = token.slice(CAPABILITY_PREFIX.length).split(".");
  if (!payload || !signature || extra !== undefined) throw invalid("unexpected format");
  const expectedSignature = createHmac("sha256", key).update(payload).digest("base64url");
  if (!safeEqual(signature, expectedSignature)) throw invalid("bad signature");
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CapabilityClaims;
  } catch {
    throw invalid("unexpected format");
  }
  if (claims.v !== 1 || typeof claims.sid !== "string" || !Array.isArray(claims.aids) || typeof claims.exp !== "number") throw invalid("unexpected format");
  if (claims.aud !== expected.audience) throw invalid("it was issued for a different deployment");
  if (claims.exp <= expected.now) throw invalid("it expired; wait for the next delivery or poll with your own credentials");
  return {
    sessionId: claims.sid,
    actionIds: claims.aids.filter((id): id is string => typeof id === "string"),
    audience: claims.aud,
    expiresAt: new Date(claims.exp).toISOString(),
    webhook: String(claims.wh ?? ""),
  };
}
