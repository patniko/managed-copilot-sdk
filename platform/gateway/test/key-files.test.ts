import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sealer } from "../src/modules/network/sealing.js";

describe("sealing key files", () => {
  let dir: string;
  let keyFile: string;
  let stored: { value: string; aad: string }[];
  const configured = Buffer.alloc(32, 7).toString("base64");
  const load = (envKey?: string, stamp?: string) =>
    Sealer.load({ keyFile, sealed: () => stored, ...(envKey ? { envKey } : {}), ...(stamp !== undefined ? { stamp } : {}) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-key-files-"));
    keyFile = join(dir, "network", "vault.key");
    stored = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("wraps a key file that seals stored data, keeps it until a later deployment, then retires it", () => {
    stored.push({ value: load().seal("secret", "row-1"), aad: "row-1" });
    const plaintext = readFileSync(keyFile, "utf8");

    // First deployment with a configured key: wrapped, plaintext kept for the previous revision.
    expect(load(configured, "100").unseal(stored[0]!.value, "row-1")).toBe("secret");
    expect(readFileSync(`${keyFile}.wrapped`, "utf8")).not.toContain(plaintext.trim());
    expect(readFileSync(keyFile, "utf8")).toBe(plaintext);
    // The previous revision (no configured key, no wrapped support) still reads the plaintext file.
    expect(new Sealer(Buffer.from(plaintext, "base64")).unseal(stored[0]!.value, "row-1")).toBe("secret");
    // A restart of the same deployment keeps it too.
    load(configured, "100");
    expect(existsSync(keyFile)).toBe(true);

    // The next deployment retires the plaintext; the data stays readable.
    expect(load(configured, "200").unseal(stored[0]!.value, "row-1")).toBe("secret");
    expect(existsSync(keyFile)).toBe(false);
    // Falling back to the wrapping deployment still works without the plaintext.
    expect(load(configured, "100").unseal(stored[0]!.value, "row-1")).toBe("secret");

    expect(() => load()).toThrow(/wrapped under a configured key/);
    expect(() => load(Buffer.alloc(32, 8).toString("base64"), "200")).toThrow(/MANAGED_COPILOT_VAULT_KEY does not open/);
    expect(readdirSync(dirname(keyFile)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps using an already-configured key when a stale key file no longer seals anything", () => {
    load();
    const stale = readFileSync(keyFile, "utf8");
    stored.push({ value: load(configured).seal("secret", "row-1"), aad: "row-1" });

    expect(load(configured, "100").unseal(stored[0]!.value, "row-1")).toBe("secret");
    expect(existsSync(`${keyFile}.wrapped`)).toBe(false);
    expect(readFileSync(keyFile, "utf8")).toBe(stale);
  });

  it("uses the configured key when nothing is sealed yet, and when no key file exists", () => {
    load();
    expect(load(configured, "100").seal("x", "a")).toBeTruthy();
    expect(existsSync(`${keyFile}.wrapped`)).toBe(false);

    rmSync(dirname(keyFile), { recursive: true, force: true });
    const sealed = load(configured, "100").seal("secret", "row-1");
    expect(existsSync(keyFile)).toBe(false);
    expect(new Sealer(Buffer.from(configured, "base64")).unseal(sealed, "row-1")).toBe("secret");
    // The configured key is recorded: a start with another key, or none, fails instead of sealing with a new one.
    expect(load(configured, "200").unseal(sealed, "row-1")).toBe("secret");
    expect(() => load()).toThrow(/wrapped under a configured key/);
    expect(existsSync(keyFile)).toBe(false);
    expect(() => load(Buffer.alloc(32, 8).toString("base64"), "200")).toThrow(/does not open/);
  });

  it("ignores interrupted staging files and refuses a plaintext file that disagrees with the wrapped key", () => {
    stored.push({ value: load().seal("secret", "row-1"), aad: "row-1" });
    writeFileSync(`${keyFile}.wrapped.abcdef.tmp`, "");
    expect(load(configured, "100").unseal(stored[0]!.value, "row-1")).toBe("secret");

    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"));
    expect(() => load(configured, "200")).toThrow(/hold different keys/);
  });

  it("refuses a wrapped file whose recorded deployment was altered", () => {
    stored.push({ value: load().seal("secret", "row-1"), aad: "row-1" });
    load(configured, "100");
    const wrapped = readFileSync(`${keyFile}.wrapped`, "utf8");
    const [prefix, version, , payload] = wrapped.split(":");
    writeFileSync(`${keyFile}.wrapped`, [prefix, version, Buffer.from("200").toString("base64url"), payload].join(":"));
    expect(() => load(configured, "200")).toThrow(/does not open/);
  });
});
