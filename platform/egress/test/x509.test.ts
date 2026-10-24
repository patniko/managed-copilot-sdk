import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { loadOrCreateCa } from "../src/ca.js";
import { CertificateAuthority, createCaMaterial } from "../src/x509.js";

describe("certificate authority", () => {
  const ca = new CertificateAuthority(createCaMaterial({ commonName: "Test Egress CA" }));

  it("creates a constrained CA certificate", () => {
    const certificate = new X509Certificate(ca.certPem);
    expect(certificate.ca).toBe(true);
    expect(certificate.subject).toContain("CN=Test Egress CA");
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(Date.now() + 5 * 365 * 24 * 3600_000);
  });

  it("issues server certificates for exact hosts", () => {
    const issued = ca.issue("api.vault.test");
    const leaf = new X509Certificate(issued.certPem);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.certificate.publicKey)).toBe(true);
    expect(leaf.checkIssued(ca.certificate)).toBe(true);
    expect(leaf.checkHost("api.vault.test")).toBe("api.vault.test");
    expect(leaf.checkHost("other.vault.test")).toBeUndefined();
    expect(leaf.subjectAltName).toBe("DNS:api.vault.test");
    expect(leaf.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
    expect(leaf.serialNumber).not.toBe(new X509Certificate(ca.issue("api.vault.test").certPem).serialNumber);
  });

  it("completes a real TLS handshake that clients verify against the CA", async () => {
    const issued = ca.issue("api.vault.test");
    const server: Server = createServer({ key: issued.keyPem, cert: issued.certPem }, (_req, res) => res.end("hello over tls"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const authorized = await new Promise<boolean>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port, servername: "api.vault.test", ca: ca.certPem }, () => {
          resolve(socket.authorized);
          socket.end();
        });
        socket.on("error", reject);
      });
      expect(authorized).toBe(true);
      const wrongName = await new Promise<string>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port, servername: "evil.vault.test", ca: ca.certPem }, () => resolve("connected"));
        socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      });
      expect(wrongName).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    } finally {
      server.close();
    }
  });

  it("caches secure contexts per host", () => {
    expect(ca.contextFor("a.vault.test")).toBe(ca.contextFor("a.vault.test"));
    expect(ca.contextFor("a.vault.test")).not.toBe(ca.contextFor("b.vault.test"));
  });

  it("uses RFC 5280 key identifiers", () => {
    const jwk = ca.certificate.publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    const expected = createHash("sha1").update(point).digest();
    expect(ca.certificate.raw.includes(Buffer.concat([Buffer.from([0x04, 0x14]), expected]))).toBe(true);
  });

  it("chains leaves to CAs whose subject key identifier uses another method", async () => {
    const operator = new CertificateAuthority(createCaMaterial({ commonName: "Operator CA", keyIdentifier: randomBytes(20) }));
    const issued = operator.issue("api.vault.test");
    expect(new X509Certificate(issued.certPem).checkIssued(operator.certificate)).toBe(true);
    const server: Server = createServer({ key: issued.keyPem, cert: issued.certPem }, (_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port, servername: "api.vault.test", ca: operator.certPem }, () => {
          resolve(socket.authorized ? "authorized" : "unauthorized");
          socket.end();
        });
        socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      });
      expect(outcome).toBe("authorized");
    } finally {
      server.close();
    }
  });

  it("rejects mismatched key material", () => {
    const one = createCaMaterial({ commonName: "One" });
    const two = createCaMaterial({ commonName: "Two" });
    expect(() => new CertificateAuthority({ certPem: one.certPem, keyPem: two.keyPem })).toThrow(/does not match/);
  });
});

describe("CA persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-egress-ca-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("creates once and reloads the same CA", () => {
    const first = loadOrCreateCa({ dataDir: dir });
    expect(first.created).toBe(true);
    const second = loadOrCreateCa({ dataDir: dir });
    expect(second.created).toBe(false);
    expect(second.ca.fingerprint).toBe(first.ca.fingerprint);
    expect(readFileSync(join(dir, "ca-cert.pem"), "utf8")).toBe(first.ca.certPem);
    if (process.platform !== "win32") expect(statSync(join(dir, "ca-key.pem")).mode & 0o777).toBe(0o600);
  });

  it("requires both operator CA files", () => {
    expect(() => loadOrCreateCa({ dataDir: dir, certFile: join(dir, "ca-cert.pem") })).toThrow(/both/);
  });
});
