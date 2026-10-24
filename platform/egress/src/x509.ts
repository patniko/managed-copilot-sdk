/**
 * Minimal X.509 issuance for vault TLS termination: an ECDSA P-256 certificate authority and short-lived server
 * certificates for exact vault hosts. Node can parse and verify certificates but not create them, so this module
 * encodes the few DER structures it needs. Keys never leave the egress process.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";

// --- DER encoding -------------------------------------------------------------------------------------------------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octetString = (value: Buffer): Buffer => tlv(0x04, value);
const bitString = (value: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, "utf8"));
const explicit = (tagNumber: number, value: Buffer): Buffer => tlv(0xa0 | tagNumber, value);

function integer(value: Buffer | number): Buffer {
  let bytes = typeof value === "number" ? Buffer.from([value]) : value;
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  bytes = bytes.subarray(start);
  if ((bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function objectId(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const group = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) group.unshift((value & 0x7f) | 0x80);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, "ascii")) : tlv(0x18, Buffer.from(`${year}${rest}`, "ascii"));
}

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

const SIGNATURE_ALGORITHM = sequence(objectId(OID.ecdsaWithSha256));

function name(commonName: string, organization: string): Buffer {
  return sequence(set(sequence(objectId(OID.organization), utf8String(organization))), set(sequence(objectId(OID.commonName), utf8String(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(objectId(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function spki(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: "spki", format: "der" });
}

interface DerNode {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}

function readNode(der: Buffer, offset: number): DerNode {
  const tag = der[offset]!;
  const first = der[offset + 1]!;
  if (first < 0x80) return { tag, start: offset, contentStart: offset + 2, end: offset + 2 + first };
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + der[offset + 2 + i]!;
  return { tag, start: offset, contentStart: offset + 2 + count, end: offset + 2 + count + length };
}

function children(der: Buffer, node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  for (let offset = node.contentStart; offset < node.end; ) {
    const child = readNode(der, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

/** RFC 5280 section 4.2.1.2 method (1): SHA-1 of the subjectPublicKey bits, without the BIT STRING's tag, length, or unused-bits count. */
function keyIdentifier(publicKey: KeyObject): Buffer {
  const der = spki(publicKey);
  const bits = children(der, readNode(der, 0))[1]!;
  return createHash("sha1").update(der.subarray(bits.contentStart + 1, bits.end)).digest();
}

function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01; // positive and non-zero
  return bytes;
}

function toPem(der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

interface CertificateFields {
  readonly subject: Buffer;
  readonly issuer: Buffer;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly publicKey: KeyObject;
  readonly extensions: readonly Buffer[];
  readonly signingKey: KeyObject;
}

function buildCertificate(fields: CertificateFields): Buffer {
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serialNumber()),
    SIGNATURE_ALGORITHM,
    fields.issuer,
    sequence(time(fields.notBefore), time(fields.notAfter)),
    fields.subject,
    spki(fields.publicKey),
    explicit(3, sequence(...fields.extensions)),
  );
  const signature = sign("sha256", tbs, fields.signingKey);
  return sequence(tbs, SIGNATURE_ALGORITHM, bitString(signature));
}

// --- Certificate authority ----------------------------------------------------------------------------------------

export interface CaMaterial {
  readonly certPem: string;
  readonly keyPem: string;
}

const ORGANIZATION = "Managed Copilot";

/**
 * Creates a new self-signed CA (ECDSA P-256) allowed to issue server certificates only (pathLen 0). `keyIdentifier`
 * overrides the subject key identifier, as CAs from other tooling may use a different method.
 */
export function createCaMaterial(options: { commonName: string; validDays?: number; now?: Date; keyIdentifier?: Buffer }): CaMaterial {
  const now = options.now ?? new Date();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const subject = name(options.commonName, ORGANIZATION);
  const keyId = options.keyIdentifier ?? keyIdentifier(publicKey);
  const der = buildCertificate({
    subject,
    issuer: subject,
    notBefore: new Date(now.getTime() - 24 * 3600_000),
    notAfter: new Date(now.getTime() + (options.validDays ?? 3650) * 24 * 3600_000),
    publicKey,
    signingKey: privateKey,
    extensions: [
      extension(OID.basicConstraints, true, sequence(boolean(true), integer(0))),
      extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)), // keyCertSign, cRLSign
      extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
      extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, keyId))),
    ],
  });
  return { certPem: toPem(der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

interface CachedContext {
  readonly context: SecureContext;
  readonly expiresAt: number;
}

export interface IssuedCertificate {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Issues and caches server certificates for exact host names, signed by the platform CA. */
export class CertificateAuthority {
  readonly certPem: string;
  readonly certificate: X509Certificate;
  readonly #caKey: KeyObject;
  readonly #caKeyId: Buffer;
  readonly #issuer: Buffer;
  readonly #leafPublicKey: KeyObject;
  readonly #leafKeyId: Buffer;
  readonly #leafKeyPem: string;
  readonly #contexts = new Map<string, CachedContext>();
  readonly #maxContexts: number;

  constructor(material: CaMaterial, options: { maxCachedContexts?: number } = {}) {
    this.certificate = new X509Certificate(material.certPem);
    this.#caKey = createPrivateKey(material.keyPem);
    if (!this.certificate.ca) throw new Error("The egress CA certificate is not a CA certificate");
    if (!this.certificate.checkPrivateKey(this.#caKey)) throw new Error("The egress CA private key does not match its certificate");
    this.certPem = this.certificate.toString();
    // Leaf authority key identifiers must equal the CA's own subject key identifier, whichever method produced it.
    this.#caKeyId = subjectKeyIdentifierOf(this.certificate) ?? keyIdentifier(this.certificate.publicKey);
    this.#issuer = Buffer.from(subjectDer(this.certificate));
    // One leaf key pair per process; each host gets its own certificate for that key.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#leafPublicKey = createPublicKey(privateKey);
    this.#leafKeyId = keyIdentifier(this.#leafPublicKey);
    this.#leafKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.#maxContexts = options.maxCachedContexts ?? 512;
  }

  /** SHA-256 fingerprint of the CA certificate, for logs and diagnostics. */
  get fingerprint(): string {
    return this.certificate.fingerprint256;
  }

  issue(host: string, options: { validHours?: number; now?: Date } = {}): IssuedCertificate {
    const now = options.now ?? new Date();
    const der = buildCertificate({
      subject: name(host, ORGANIZATION),
      issuer: this.#issuer,
      notBefore: new Date(now.getTime() - 3600_000),
      notAfter: new Date(now.getTime() + (options.validHours ?? 72) * 3600_000),
      publicKey: this.#leafPublicKey,
      signingKey: this.#caKey,
      extensions: [
        extension(OID.basicConstraints, true, sequence()),
        extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
        extension(OID.extKeyUsage, false, sequence(objectId(OID.serverAuth))),
        extension(OID.subjectAltName, false, sequence(tlv(0x82, Buffer.from(host, "ascii")))),
        extension(OID.subjectKeyIdentifier, false, octetString(this.#leafKeyId)),
        extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, this.#caKeyId))),
      ],
    });
    return { certPem: toPem(der), keyPem: this.#leafKeyPem };
  }

  /** A TLS server context presenting a certificate for `host`, cached for a day. */
  contextFor(host: string): SecureContext {
    const now = Date.now();
    const cached = this.#contexts.get(host);
    if (cached && cached.expiresAt > now) return cached.context;
    const issued = this.issue(host);
    const context = createSecureContext({ key: issued.keyPem, cert: issued.certPem, minVersion: "TLSv1.2" });
    if (this.#contexts.size >= this.#maxContexts) {
      const oldest = this.#contexts.keys().next().value;
      if (oldest !== undefined) this.#contexts.delete(oldest);
    }
    this.#contexts.delete(host);
    this.#contexts.set(host, { context, expiresAt: now + 24 * 3600_000 });
    return context;
  }
}

/** The fields of a certificate's TBSCertificate: [0] version, serial, signature, issuer, validity, subject, spki, ..., [3] extensions. */
function tbsFields(der: Buffer): DerNode[] {
  return children(der, children(der, readNode(der, 0))[0]!);
}

/** Extracts the DER-encoded subject Name from a certificate (the issuer of certificates it signs). */
function subjectDer(certificate: X509Certificate): Buffer {
  const der = certificate.raw;
  const fields = tbsFields(der);
  const subject = fields[(fields[0]!.tag === 0xa0 ? 1 : 0) + 4]!;
  return Buffer.from(der.subarray(subject.start, subject.end));
}

/** The certificate's subject key identifier extension value, if it has one. */
function subjectKeyIdentifierOf(certificate: X509Certificate): Buffer | undefined {
  const der = certificate.raw;
  const extensions = tbsFields(der).find((field) => field.tag === 0xa3);
  const list = extensions ? children(der, extensions)[0] : undefined;
  if (!list) return undefined;
  const oid = objectId(OID.subjectKeyIdentifier);
  for (const entry of children(der, list)) {
    const parts = children(der, entry);
    if (!der.subarray(parts[0]!.start, parts[0]!.end).equals(oid)) continue;
    const value = parts[parts.length - 1]!;
    const keyId = readNode(der, value.contentStart);
    return keyId.tag === 0x04 ? Buffer.from(der.subarray(keyId.contentStart, keyId.end)) : undefined;
  }
  return undefined;
}
