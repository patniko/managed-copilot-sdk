// Incident Commander's deploy pipeline webhook: an approved fix for downhill-shop, signed with the shared secret
// (DOWNHILL_DEPLOY_SECRET). The signature scheme is Managed Copilot's own: `t=<seconds>,v1=<hex HMAC-SHA256 of
// "<t>.<body>">`. Only storefront code may be deployed: .js files under src/ or test/, README.md, and package.json.
import { createHmac, timingSafeEqual } from "node:crypto";
import { DownhillError } from "./errors.js";
import type { DeployInput } from "./storefront.js";
import { clip } from "./support.js";

export const SIGNATURE_HEADER = "x-incident-commander-signature";
export const SERVICE_NAME = "downhill-shop";
/** Request body, bytes. */
export const MAX_DEPLOY_BYTES = 1024 * 1024;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
/** How old (or how far ahead) a signature's timestamp may be. */
const TOLERANCE_SECONDS = 5 * 60;

const CODE_PATH = /^(?:src|test)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const INCIDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

/** Whether a path may be deployed: storefront code and tests, its README, and its package.json. No traversal. */
export function deployablePath(path: string): boolean {
  return path === "README.md" || path === "package.json" || CODE_PATH.test(path);
}

/** Signs a body the way Incident Commander does (for tests and tools). */
export function sign(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
}

/** Checks the signature header: `ok`, `missing`, `stale` (more than 5 minutes off), or `invalid`. */
export function verifySignature(header: string | undefined, body: string, secret: string, now = Date.now()): "ok" | "missing" | "stale" | "invalid" {
  if (!header) return "missing";
  let t: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d{1,12}$/.test(value)) t = Number(value);
    else if (key === "v1" && value && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (t === undefined || signatures.length === 0) return "invalid";
  if (Math.abs(Math.floor(now / 1000) - t) > TOLERANCE_SECONDS) return "stale";
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex"), "utf8");
  return signatures.some((signature) => timingSafeEqual(Buffer.from(signature, "utf8"), expected)) ? "ok" : "invalid";
}

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function invalid(message: string): DownhillError {
  return new DownhillError("invalid_request", message, 400);
}

/** An approved deploy for downhill-shop, checked: anything else is refused in plain words. */
export function parseDeploy(body: unknown): Omit<DeployInput, "idempotencyKey"> {
  const deploy = record(body);
  if (!deploy) throw invalid("Send the deploy as a JSON object.");
  if (deploy["type"] !== "incident.deploy_approved") throw invalid('Downhill only takes approved deploys (type "incident.deploy_approved").');
  if (deploy["service"] !== SERVICE_NAME) throw invalid(`Downhill only deploys ${SERVICE_NAME}; this deploy is for ${typeof deploy["service"] === "string" ? clip(deploy["service"], 60) : "no service"}.`);
  const incident = deploy["incident"];
  if (typeof incident !== "string" || !INCIDENT.test(incident)) throw invalid("Send the incident the deploy fixes, such as INC-1004.");
  const files = deploy["files"];
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw invalid(`Send the fix as files: 1 to ${MAX_FILES} of them.`);
  const seen = new Set<string>();
  const checked = files.map((value) => {
    const file = record(value);
    const path = file?.["path"];
    const content = file?.["content"];
    if (typeof path !== "string" || !deployablePath(path)) {
      throw invalid(`${typeof path === "string" ? `"${clip(path, 120)}"` : "A file"} can't be deployed: only .js files under src/ or test/, README.md, and package.json.`);
    }
    if (typeof content !== "string") throw invalid(`Send ${path}'s content as text.`);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw invalid(`${path} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    if (seen.has(path)) throw invalid(`${path} is in the deploy twice.`);
    if (path === "package.json") {
      try {
        if (!record(JSON.parse(content))) throw new Error();
      } catch {
        throw invalid("package.json isn't valid JSON.");
      }
    }
    seen.add(path);
    return { path, content };
  });
  const text = (key: string, max: number) => {
    const value = deploy[key];
    return typeof value === "string" && value.trim() ? clip(value, max) : undefined;
  };
  const version = typeof deploy["version"] === "string" && SEMVER.test(deploy["version"]) ? deploy["version"] : undefined;
  const approvedAt = typeof deploy["approvedAt"] === "string" && !Number.isNaN(Date.parse(deploy["approvedAt"])) ? new Date(deploy["approvedAt"]).toISOString() : undefined;
  const approvedBy = text("approvedBy", 100);
  const tests = text("tests", 2_000);
  return {
    incident,
    summary: text("summary", 500) ?? `Fix for ${incident}`,
    ...(version ? { version } : {}),
    ...(approvedBy ? { approvedBy } : {}),
    ...(approvedAt ? { approvedAt } : {}),
    ...(tests ? { tests } : {}),
    files: checked,
  };
}
