import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { listHostFiles, readHostFile, writeHostFile } from "../src/modules/sandbox/host-files.js";

async function text(body: Readable): Promise<string> {
  let result = "";
  for await (const chunk of body) result += chunk;
  return result;
}

describe("host workspace files (unsafeHostTools)", () => {
  it("writes, lists, and reads workspace-relative paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-files-"));
    const written = await writeHostFile(root, "uploads/a.txt", Readable.from(["hello"]), true);
    expect(written).toMatchObject({ path: "uploads/a.txt", type: "file", size: 5 });
    expect((await listHostFiles(root, "", true)).map((entry) => entry.path).sort()).toEqual(["uploads", "uploads/a.txt"]);
    expect(await text((await readHostFile(root, "/workspace/uploads/a.txt")).body)).toBe("hello");
  });

  it("refuses overwrites when asked and paths outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-files-"));
    await writeHostFile(root, "a.txt", Readable.from(["1"]), true);
    await expect(writeHostFile(root, "a.txt", Readable.from(["2"]), false)).rejects.toMatchObject({ code: "conflict" });
    await expect(readHostFile(root, "../outside.txt")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readHostFile(root, "missing.txt")).rejects.toMatchObject({ code: "not_found" });
  });
});
