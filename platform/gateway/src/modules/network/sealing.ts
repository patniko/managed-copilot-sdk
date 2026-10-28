/**
 * Seals secrets at rest (vault values) with AES-256-GCM. The key comes from `MANAGED_COPILOT_VAULT_KEY` (32 bytes,
 * base64 or base64url; for example from Key Vault in Azure) or a key file created once in the data directory.
 * Every sealed value is bound to its row with additional authenticated data, so values cannot be swapped between
 * rows or vaults.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import { resolveKeyFile } from "../../key-files.js";

const VERSION = "v1";

function decodeKey(text: string): Buffer {
  const key = Buffer.from(text.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("The vault key must be 32 bytes, base64 encoded");
  return key;
}

export class Sealer {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("The vault key must be 32 bytes");
    this.#key = Buffer.from(key);
  }

  /**
   * `MANAGED_COPILOT_VAULT_KEY`, else a key file under `keyFile` created on first use (mode 0600). With a configured
   * key, an existing key file is wrapped under it and its plaintext removed (`resolveKeyFile`).
   */
  static load(options: { readonly envKey?: string; readonly keyFile: string }): Sealer {
    if (options.envKey) {
      const configured = { key: decodeKey(options.envKey), variable: "MANAGED_COPILOT_VAULT_KEY" };
      return new Sealer(resolveKeyFile(options.keyFile, configured, decodeKey)!);
    }
    resolveKeyFile(options.keyFile, undefined, decodeKey);
    if (existsSync(options.keyFile)) return new Sealer(decodeKey(readFileSync(options.keyFile, "utf8")));
    mkdirSync(dirname(options.keyFile), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(options.keyFile, key.toString("base64"), { mode: 0o600 });
    chmodSync(options.keyFile, 0o600);
    return new Sealer(key);
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  unseal(sealed: string, aad: string): string {
    const [version, payload] = sealed.split(".", 2);
    if (version !== VERSION || !payload) throw new ManagedCopilotError("internal", "A sealed value has an unknown format");
    const raw = Buffer.from(payload, "base64url");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new ManagedCopilotError("internal", "A sealed value could not be opened; the vault key may have changed");
    }
  }
}
