import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CA_DIRECTORY, loadOrCreateCa } from "../src/ca.js";

/** How the file system accepts writes in this file: at most `max` bytes per call, or nothing at all. */
const writes = vi.hoisted(() => ({ max: Number.POSITIVE_INFINITY, stalled: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (fd: number, buffer: Buffer, offset = 0, length = buffer.length - offset, position?: number | null) =>
      writes.stalled ? 0 : actual.writeSync(fd, buffer, offset, Math.min(length, writes.max), position),
  };
});

describe("CA creation on file systems that accept partial writes", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-egress-ca-writes-"));
  let count = 0;
  const fresh = () => join(root, `data-${++count}`);
  afterEach(() => {
    writes.max = Number.POSITIVE_INFINITY;
    writes.stalled = false;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes the whole pair when each write accepts only part of it", () => {
    const dir = fresh();
    writes.max = 100;
    const created = loadOrCreateCa({ dataDir: dir });
    expect(created.created).toBe(true);
    expect(readFileSync(join(dir, CA_DIRECTORY, "key.pem"), "utf8")).toMatch(/-----END PRIVATE KEY-----\s*$/);
    writes.max = Number.POSITIVE_INFINITY;
    expect(loadOrCreateCa({ dataDir: dir }).ca.fingerprint).toBe(created.ca.fingerprint);
  });

  it("publishes nothing when the file system stops accepting data", () => {
    const dir = fresh();
    writes.stalled = true;
    expect(() => loadOrCreateCa({ dataDir: dir })).toThrow(/accepted no data/);
    expect(existsSync(join(dir, CA_DIRECTORY))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
