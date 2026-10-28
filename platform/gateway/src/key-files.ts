// Sealing keys at rest. A gateway without a configured key generates one into its data directory. Once a key is
// configured (for example from a deployment's secret parameters), that file is wrapped under the configured key and
// the plaintext is deleted, so the data directory alone no longer opens what the key sealed, and values sealed
// before the key was configured stay readable.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { ManagedCopilotError } from "@managed-copilot/protocol";

const WRAPPED_PREFIX = "wrapped:v1:";

export interface ConfiguredKey {
  /** The decoded configured key (32 bytes). */
  readonly key: Buffer;
  /** The environment variable it came from, named in errors. */
  readonly variable: string;
}

/**
 * Resolves the key that seals data, given an optional configured key and the data directory's key file.
 * - Configured, with a wrapped file: the wrapped key (the configured key must open it; a leftover plaintext file
 *   holding the same key is deleted).
 * - Configured, with a plaintext file: the file's key, wrapped under the configured key; the plaintext is deleted.
 * - Configured, no file: the configured key.
 * - Not configured: `undefined` (the caller reads or creates the plaintext file); a wrapped file then fails.
 */
export function resolveKeyFile(keyFile: string, configured: ConfiguredKey | undefined, decodeFile: (text: string) => Buffer): Buffer | undefined {
  const wrappedFile = `${keyFile}.wrapped`;
  const context = `managed-copilot/wrapped-key/${basename(keyFile)}`;
  if (!configured) {
    if (existsSync(wrappedFile)) {
      throw new ManagedCopilotError("capability_unavailable", `${wrappedFile} is wrapped under a configured key. Set the key this deployment uses.`);
    }
    return undefined;
  }
  if (existsSync(wrappedFile)) {
    const key = unwrap(configured, readFileSync(wrappedFile, "utf8").trim(), context, wrappedFile);
    if (existsSync(keyFile)) {
      if (!decodeFile(readFileSync(keyFile, "utf8")).equals(key)) {
        throw new ManagedCopilotError("capability_unavailable", `${keyFile} and ${wrappedFile} hold different keys. Remove the one this deployment did not use.`);
      }
      rmSync(keyFile, { force: true });
    }
    return key;
  }
  if (existsSync(keyFile)) {
    const key = decodeFile(readFileSync(keyFile, "utf8"));
    writeFileSync(wrappedFile, wrap(configured.key, key, context), { mode: 0o600, flag: "wx" });
    try {
      chmodSync(wrappedFile, 0o600);
    } catch {
      // Windows ignores POSIX modes; the data directory's ACLs apply.
    }
    if (!unwrap(configured, readFileSync(wrappedFile, "utf8").trim(), context, wrappedFile).equals(key)) {
      throw new ManagedCopilotError("internal", `${wrappedFile} could not be verified after it was written.`);
    }
    rmSync(keyFile, { force: true });
    return key;
  }
  return configured.key;
}

function wrap(kek: Buffer, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(key), cipher.final()]);
  return `${WRAPPED_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

function unwrap(configured: ConfiguredKey, text: string, context: string, file: string): Buffer {
  const refuse = () =>
    new ManagedCopilotError("capability_unavailable", `${configured.variable} does not open ${file}. Set the key this deployment was configured with.`);
  if (!text.startsWith(WRAPPED_PREFIX)) throw refuse();
  const raw = Buffer.from(text.slice(WRAPPED_PREFIX.length), "base64url");
  try {
    const decipher = createDecipheriv("aes-256-gcm", configured.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    const key = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    if (key.length !== 32) throw refuse();
    return key;
  } catch {
    throw refuse();
  }
}
