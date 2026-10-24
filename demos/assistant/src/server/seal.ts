import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "v1";
const SALT = Buffer.from("managed-copilot-assistant", "utf8");
const INFO = Buffer.from("token-sealing-v1", "utf8");

/**
 * Seals small secrets (OAuth refresh/access tokens, PKCE verifiers) at rest with AES-256-GCM.
 * Each sealed value is bound to its purpose with associated data, so a ciphertext copied into another row fails to open.
 */
export class Sealer {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Sealing key must be 32 bytes");
    this.#key = key;
  }

  /** Derives the AES key from a configured secret (for example the `assistant-sealing-key` AppHost parameter). */
  static fromSecret(secret: string): Sealer {
    if (secret.length < 16) throw new Error("ASSISTANT_SEALING_KEY must be at least 16 characters");
    return new Sealer(Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, INFO, 32)));
  }

  seal(plaintext: string, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  open(sealed: string, purpose: string): string {
    const [version, ivText, bodyText] = sealed.split(".");
    if (version !== VERSION || !ivText || !bodyText) throw new Error("Unrecognized sealed value");
    const body = Buffer.from(bodyText, "base64url");
    if (body.length < 16) throw new Error("Sealed value is truncated");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  }
}

/**
 * Local-development fallback when `ASSISTANT_SEALING_KEY` is not configured: a random key in the data directory.
 * `aspire run` always supplies the generated AppHost parameter instead.
 */
export function loadOrCreateDevSealingKey(dataDir: string): string {
  const file = join(dataDir, "sealing.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString("base64url");
  writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on Windows, where POSIX modes do not apply.
  }
  return key;
}
