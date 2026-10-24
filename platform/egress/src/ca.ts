/**
 * Loads the egress CA from operator-provided files, or creates one and persists it in the data directory.
 *
 * Creation is atomic and exclusive, so proxies that start together on shared storage (replicas or revisions on NFS)
 * agree on one CA, and a crash never leaves half a pair: the pair is written and flushed in a private staging
 * directory that is then renamed into place in one step. The first rename wins; the others load the winner's pair. A
 * persisted pair that cannot be used fails loudly instead of being replaced, which would silently split trust.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CertificateAuthority, createCaMaterial } from "./x509.js";

export interface CaOptions {
  readonly dataDir: string;
  /** Operator-provided CA (for example from Key Vault); both files must be set together. */
  readonly certFile?: string;
  readonly keyFile?: string;
  readonly commonName?: string;
}

/** The persisted pair: `<dataDir>/ca/cert.pem` and `<dataDir>/ca/key.pem`. */
export const CA_DIRECTORY = "ca";

function load(certPath: string, keyPath: string): CertificateAuthority {
  try {
    return new CertificateAuthority({ certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") });
  } catch (error) {
    throw new Error(`The egress CA in ${certPath} and ${keyPath} cannot be used (${(error as Error).message}). Restore it, or remove it to create a new CA (sandboxes must then trust the new one).`);
  }
}

function writeFlushed(path: string, data: string, mode: number): void {
  const bytes = Buffer.from(data, "utf8");
  const fd = openSync(path, "wx", mode);
  try {
    // A write may accept only part of the data: keep going until all of it is on disk, never publish a short file.
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!(written > 0)) throw new Error(`Could not write ${path}: the file system accepted no data`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function flushDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directories cannot be flushed everywhere (Windows); the rename is atomic regardless.
  }
}

export function loadOrCreateCa(options: CaOptions, internals: { readonly rename?: (from: string, to: string) => void } = {}): { ca: CertificateAuthority; created: boolean } {
  if (options.certFile || options.keyFile) {
    if (!options.certFile || !options.keyFile) throw new Error("Set both EGRESS_CA_CERT_FILE and EGRESS_CA_KEY_FILE, or neither");
    return { ca: load(options.certFile, options.keyFile), created: false };
  }
  const directory = join(options.dataDir, CA_DIRECTORY);
  const persisted = () => load(join(directory, "cert.pem"), join(directory, "key.pem"));
  if (existsSync(directory)) return { ca: persisted(), created: false };
  // Data directories from earlier versions hold the pair as two files.
  const legacyCert = join(options.dataDir, "ca-cert.pem");
  const legacyKey = join(options.dataDir, "ca-key.pem");
  if (existsSync(legacyCert) && existsSync(legacyKey)) return { ca: load(legacyCert, legacyKey), created: false };

  mkdirSync(options.dataDir, { recursive: true });
  const material = createCaMaterial({ commonName: options.commonName ?? "Managed Copilot Egress CA" });
  const staging = join(options.dataDir, `.ca-staging-${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeFlushed(join(staging, "key.pem"), material.keyPem, 0o600);
    writeFlushed(join(staging, "cert.pem"), material.certPem, 0o644);
    flushDirectory(staging);
    (internals.rename ?? renameSync)(staging, directory);
    flushDirectory(options.dataDir);
    // Use what was published, as every other proxy will, so damage fails here rather than on the next start.
    return { ca: persisted(), created: true };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(directory)) return { ca: persisted(), created: false };
    throw error;
  }
}
