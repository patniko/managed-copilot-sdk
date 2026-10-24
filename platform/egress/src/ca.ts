/** Loads the egress CA from operator-provided files, or creates one and persists it in the data directory. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CertificateAuthority, createCaMaterial, type CaMaterial } from "./x509.js";

export interface CaOptions {
  readonly dataDir: string;
  /** Operator-provided CA (for example from Key Vault); both files must be set together. */
  readonly certFile?: string;
  readonly keyFile?: string;
  readonly commonName?: string;
}

export function loadOrCreateCa(options: CaOptions): { ca: CertificateAuthority; created: boolean } {
  if (options.certFile || options.keyFile) {
    if (!options.certFile || !options.keyFile) throw new Error("Set both EGRESS_CA_CERT_FILE and EGRESS_CA_KEY_FILE, or neither");
    return { ca: new CertificateAuthority({ certPem: readFileSync(options.certFile, "utf8"), keyPem: readFileSync(options.keyFile, "utf8") }), created: false };
  }
  const certPath = join(options.dataDir, "ca-cert.pem");
  const keyPath = join(options.dataDir, "ca-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { ca: new CertificateAuthority({ certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") }), created: false };
  }
  mkdirSync(options.dataDir, { recursive: true });
  const material: CaMaterial = createCaMaterial({ commonName: options.commonName ?? "Managed Copilot Egress CA" });
  writeFileSync(keyPath, material.keyPem, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(certPath, material.certPem);
  return { ca: new CertificateAuthority(material), created: true };
}
