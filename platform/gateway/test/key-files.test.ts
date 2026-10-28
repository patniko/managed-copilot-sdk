import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sealer } from "../src/modules/network/sealing.js";

describe("sealing key files", () => {
  let dir: string;
  let keyFile: string;
  const configured = Buffer.alloc(32, 7).toString("base64");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-key-files-"));
    keyFile = join(dir, "network", "vault.key");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("wraps a generated key file once a key is configured, so earlier values stay readable", () => {
    const sealed = Sealer.load({ keyFile }).seal("secret", "row-1");
    const plaintext = readFileSync(keyFile, "utf8");

    const adopted = Sealer.load({ envKey: configured, keyFile });
    expect(adopted.unseal(sealed, "row-1")).toBe("secret");
    expect(existsSync(keyFile)).toBe(false);
    expect(readFileSync(`${keyFile}.wrapped`, "utf8")).not.toContain(plaintext.trim());

    expect(Sealer.load({ envKey: configured, keyFile }).unseal(sealed, "row-1")).toBe("secret");
    expect(() => Sealer.load({ keyFile })).toThrow(/wrapped under a configured key/);
    expect(() => Sealer.load({ envKey: Buffer.alloc(32, 8).toString("base64"), keyFile })).toThrow(/MANAGED_COPILOT_VAULT_KEY does not open/);
  });

  it("finishes an interrupted adoption and refuses a plaintext file that disagrees", () => {
    const sealed = Sealer.load({ keyFile }).seal("secret", "row-1");
    const plaintext = readFileSync(keyFile, "utf8");
    Sealer.load({ envKey: configured, keyFile });

    writeFileSync(keyFile, plaintext);
    expect(Sealer.load({ envKey: configured, keyFile }).unseal(sealed, "row-1")).toBe("secret");
    expect(existsSync(keyFile)).toBe(false);

    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"));
    expect(() => Sealer.load({ envKey: configured, keyFile })).toThrow(/hold different keys/);
  });

  it("uses the configured key directly when no key file exists", () => {
    const sealed = Sealer.load({ envKey: configured, keyFile }).seal("secret", "row-1");
    expect(existsSync(keyFile) || existsSync(`${keyFile}.wrapped`)).toBe(false);
    expect(new Sealer(Buffer.from(configured, "base64")).unseal(sealed, "row-1")).toBe("secret");
  });
});
