// Sealing keys at rest. A gateway without a configured key generates one into its data directory. Once a key is
// configured (for example from a deployment's secret parameters), a key file that still seals stored data is wrapped
// under the configured key, so the data directory alone no longer opens what it sealed, and values sealed before the
// key was configured stay readable.
//
// The plaintext file is retired only by a later deployment (a different MANAGED_COPILOT_LEASE_STAMP) than the one that
// wrapped it: until then the previous revision, which reads only the plaintext file, may still reclaim the lease.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ManagedCopilotError } from "@managed-copilot/protocol";

const WRAPPED_PREFIX = "wrapped:v1:";

export interface ConfiguredKey {
  /** The decoded configured key (32 bytes). */
  readonly key: Buffer;
  /** The environment variable it came from, named in errors. */
  readonly variable: string;
}

export interface KeyFileOptions {
  readonly keyFile: string;
  readonly configured?: ConfiguredKey;
  readonly decodeFile: (text: string) => Buffer;
  /** Whether a candidate key opens data already sealed: `undefined` when nothing is sealed yet. */
  readonly opens: (key: Buffer) => boolean | undefined;
  /** This deployment's `MANAGED_COPILOT_LEASE_STAMP`; without one (no lease supervisor) a later start retires the file. */
  readonly stamp?: string;
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * Resolves the key that seals data:
 * - Not configured: `undefined` (the caller reads or creates the plaintext file); a wrapped file fails explicitly.
 * - Configured, with a wrapped file: the wrapped key (the configured key must open it).
 * - Configured, with a plaintext file that seals the stored data: that key, wrapped under the configured key.
 * - Configured, with no key file: the configured key, recorded as a wrapped file so another key (or none) fails later.
 * - Otherwise the configured key, as before wrapping existed (a plaintext file it replaced is left in place).
 */
export function resolveKeyFile(options: KeyFileOptions): Buffer | undefined {
  const { keyFile, configured } = options;
  const wrappedFile = `${keyFile}.wrapped`;
  if (!configured) {
    if (existsSync(wrappedFile)) {
      throw new ManagedCopilotError("capability_unavailable", `${wrappedFile} is wrapped under a configured key. Set the key this deployment uses.`);
    }
    return undefined;
  }
  const context = `managed-copilot/wrapped-key/${basename(keyFile)}`;
  const stamp = options.stamp ?? "";

  if (existsSync(wrappedFile)) {
    const wrapped = unwrap(configured, readFileSync(wrappedFile, "utf8").trim(), context, wrappedFile);
    if (existsSync(keyFile)) {
      if (!options.decodeFile(readFileSync(keyFile, "utf8")).equals(wrapped.key)) {
        throw new ManagedCopilotError("capability_unavailable", `${keyFile} and ${wrappedFile} hold different keys. Remove the one this deployment did not use.`);
      }
      if (options.stamp === undefined || wrapped.stamp !== stamp) rmSync(keyFile, { force: true });
    }
    return wrapped.key;
  }

  if (!existsSync(keyFile)) {
    // Record the configured key, so a later start with another key, or none, fails here rather than sealing anew.
    mkdirSync(dirname(wrappedFile), { recursive: true });
    writeAtomically(wrappedFile, wrap(configured.key, configured.key, context, stamp));
    return configured.key;
  }
  const fileKey = options.decodeFile(readFileSync(keyFile, "utf8"));
  if (options.opens(fileKey) !== true) {
    // Nothing the file sealed is stored (the configured key already replaced it, or nothing is sealed yet).
    options.warn?.("A key file in the data directory seals no stored data; the configured key is used. Delete the file once no older deployment needs it.", { keyFile });
    return configured.key;
  }
  writeAtomically(wrappedFile, wrap(configured.key, fileKey, context, stamp));
  if (!unwrap(configured, readFileSync(wrappedFile, "utf8").trim(), context, wrappedFile).key.equals(fileKey)) {
    throw new ManagedCopilotError("internal", `${wrappedFile} could not be verified after it was written.`);
  }
  return fileKey;
}

function writeAtomically(file: string, text: string): void {
  const staging = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(staging, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(staging, 0o600);
  } catch {
    // Windows ignores POSIX modes; the data directory's ACLs apply.
  }
  try {
    renameSync(staging, file);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

function aad(context: string, stamp: string): Buffer {
  return Buffer.from(`${context}\n${stamp}`, "utf8");
}

function wrap(kek: Buffer, key: Buffer, context: string, stamp: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(aad(context, stamp));
  const body = Buffer.concat([cipher.update(key), cipher.final()]);
  return `${WRAPPED_PREFIX}${Buffer.from(stamp, "utf8").toString("base64url")}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

function unwrap(configured: ConfiguredKey, text: string, context: string, file: string): { key: Buffer; stamp: string } {
  const refuse = () =>
    new ManagedCopilotError("capability_unavailable", `${configured.variable} does not open ${file}. Set the key this deployment was configured with.`);
  if (!text.startsWith(WRAPPED_PREFIX)) throw refuse();
  const [stampText, payload, extra] = text.slice(WRAPPED_PREFIX.length).split(":");
  if (stampText === undefined || !payload || extra !== undefined) throw refuse();
  const stamp = Buffer.from(stampText, "base64url").toString("utf8");
  const raw = Buffer.from(payload, "base64url");
  let key: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", configured.key, raw.subarray(0, 12));
    decipher.setAAD(aad(context, stamp));
    decipher.setAuthTag(raw.subarray(12, 28));
    key = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  } catch {
    throw refuse();
  }
  if (key.length !== 32) throw refuse();
  return { key, stamp };
}
