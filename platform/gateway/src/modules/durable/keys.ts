import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import { resolveKeyFile } from "../../key-files.js";

/** Base64-encoded 32-byte master key; set it from a secret store (Key Vault in Azure). */
export const DURABLE_KEY_ENV = "MANAGED_COPILOT_DURABLE_KEY";
const KEY_FILE = "durable.key";
const SEALED_PREFIX = "sealed:v1:";

export interface DurableKeys {
  /** AES-256-GCM key for credentials sealed at rest. */
  readonly seal: Buffer;
  /** HMAC key for webhook action capabilities. */
  readonly capability: Buffer;
}

/**
 * Loads the module's master key from `MANAGED_COPILOT_DURABLE_KEY`, or from `<dataDir>/durable.key` (created on first
 * use, owner-only permissions). Purpose-specific keys are derived with HKDF so one key never serves two uses.
 */
export function loadDurableKeys(dataDir: string, env: Readonly<Record<string, string | undefined>>): DurableKeys {
  const master = readMasterKey(dataDir, env);
  const derive = (purpose: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `managed-copilot/durable/${purpose}`, 32));
  return { seal: derive("seal"), capability: derive("capability") };
}

function readMasterKey(dataDir: string, env: Readonly<Record<string, string | undefined>>): Buffer {
  const fromEnv = env[DURABLE_KEY_ENV];
  const file = join(dataDir, KEY_FILE);
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new ManagedCopilotError("invalid_request", `${DURABLE_KEY_ENV} must be 32 bytes, base64 encoded`);
    return resolveKeyFile(file, { key, variable: DURABLE_KEY_ENV }, (text) => decodeKeyFile(text, file))!;
  }
  resolveKeyFile(file, undefined, (text) => decodeKeyFile(text, file));
  if (existsSync(file)) return decodeKeyFile(readFileSync(file, "utf8"), file);
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key.toString("base64"), { mode: 0o600, flag: "wx" });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the data directory's ACLs apply.
  }
  return key;
}

function decodeKeyFile(text: string, file: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new ManagedCopilotError("internal", `The durable key file ${file} is corrupt`);
  return key;
}

/** Encrypts a secret for storage. `context` binds the ciphertext to its row (e.g. the account ID). */
export function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${SEALED_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export function unseal(key: Buffer, sealed: string, context: string): string {
  if (!sealed.startsWith(SEALED_PREFIX)) throw new ManagedCopilotError("internal", "Stored secret has an unknown format");
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new ManagedCopilotError("internal", "Stored secret could not be unsealed (wrong key or tampered data)");
  }
}
