// Sealing keys at rest. A gateway without a configured key generates one into its data directory. Once a key is
// configured (for example from a deployment's secret parameters), a key file that still seals stored data is wrapped
// under the configured key, so the data directory alone no longer opens what it sealed, and values sealed before the
// key was configured stay readable.
//
// The plaintext file is retired only once a gateway that reads the wrapped key has served a deployment for a while
// (recorded in `<file>.served`) and a later deployment starts: until then the previous revision, which reads only the
// plaintext file, may still be the one that reclaims the lease after a failed rollout.
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
  /** How long this gateway must run before its deployment counts as served (default 15 minutes). */
  readonly servedAfterMs?: number;
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
}

const SERVED_AFTER_MS = 15 * 60_000;

/** Records that a gateway reading the wrapped key served `stamp`, so a later deployment may retire the plaintext. */
export function markKeyFileServed(keyFile: string, stamp: string): void {
  if (!existsSync(`${keyFile}.wrapped`) || !existsSync(keyFile)) return;
  const served = servedStamps(keyFile);
  if (served.includes(stamp)) return;
  writeAtomically(`${keyFile}.served`, [...served, stamp].join("\n"));
}

function servedStamps(keyFile: string): string[] {
  const file = `${keyFile}.served`;
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function scheduleServed(options: KeyFileOptions): void {
  const stamp = options.stamp;
  if (stamp === undefined) return;
  const timer = setTimeout(() => {
    try {
      markKeyFileServed(options.keyFile, stamp);
    } catch (error) {
      options.warn?.("Could not record that this deployment can read the wrapped key", { keyFile: options.keyFile, error: (error as Error).message });
    }
  }, options.servedAfterMs ?? SERVED_AFTER_MS);
  timer.unref();
}

/**
 * Resolves the key that seals data:
 * - Not configured: `undefined` (the caller reads or creates the plaintext file); a wrapped file fails explicitly.
 * - Configured, with a wrapped file: the wrapped key (the configured key must open it).
 * - Configured, with a plaintext file that seals the stored data (or nothing is sealed yet): that key, wrapped.
 * - Configured, with no key file: the configured key, recorded as a wrapped file so another key (or none) fails later.
 * - Configured, with a stale plaintext file (the configured key opens the stored data): the configured key, recorded;
 *   the stale file is renamed `<file>.replaced`.
 * - Neither key opens the stored data: an explicit failure.
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
        // A stale file whose setting-aside was interrupted: the wrapped key is the one that opens the stored data.
        if (options.opens(wrapped.key) !== true) {
          throw new ManagedCopilotError("capability_unavailable", `${keyFile} and ${wrappedFile} hold different keys. Remove the one this deployment did not use.`);
        }
        renameSync(keyFile, `${keyFile}.replaced`);
        return wrapped.key;
      }
      const retire = options.stamp === undefined || servedStamps(keyFile).some((served) => served !== stamp);
      if (retire) {
        rmSync(keyFile, { force: true });
        rmSync(`${keyFile}.served`, { force: true });
      } else {
        scheduleServed(options);
      }
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
  const configuredOpens = fileKey.equals(configured.key) ? undefined : options.opens(configured.key);
  if (configuredOpens === true) {
    // The configured key already replaced the file before wrapping existed: record it, and set the stale file aside.
    writeAtomically(wrappedFile, wrap(configured.key, configured.key, context, stamp));
    renameSync(keyFile, `${keyFile}.replaced`);
    options.warn?.("A key file in the data directory was not the key in use; it was renamed. Delete it once nothing needs the values it sealed.", { keyFile: `${keyFile}.replaced` });
    return configured.key;
  }
  if (options.opens(fileKey) === false) {
    throw new ManagedCopilotError("capability_unavailable", `Neither ${configured.variable} nor ${keyFile} opens the secrets stored in the data directory. Set the key this deployment was configured with.`);
  }
  // The file seals the stored data, or nothing is sealed yet (the previous revision keeps using the file either way).
  writeAtomically(wrappedFile, wrap(configured.key, fileKey, context, stamp));
  if (!unwrap(configured, readFileSync(wrappedFile, "utf8").trim(), context, wrappedFile).key.equals(fileKey)) {
    throw new ManagedCopilotError("internal", `${wrappedFile} could not be verified after it was written.`);
  }
  scheduleServed(options);
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
