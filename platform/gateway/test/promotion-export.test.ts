// Unit tests for promotion's session-state export: lock files skipped, platform paths rewritten (raw and JSON-escaped),
// GitHub tokens refused, unsupported entries and limits enforced.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError } from "@managed-copilot/protocol";
import { exportSessionState, pathRewriter } from "../src/modules/promotion/export.js";

const SESSION = "0b6f3c55-7a1e-4bb4-9a51-3f4f0e6d1c2a";
let temp: string;
let root: string;
let source: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "mc-promo-export-"));
  root = join(temp, "runtime", "shared");
  source = join(root, "copilot-home", "session-state", SESSION);
  mkdirSync(join(source, "checkpoints"), { recursive: true });
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

describe("pathRewriter", () => {
  const rewriter = () => pathRewriter([join(tempRoot(), "runtime", "shared")], SESSION);
  const tempRoot = () => (process.platform === "win32" ? "C:\\data\\mc" : "/var/data/mc");

  it("maps the session's working directory to /workspace and other platform paths to /platform", () => {
    const sep = process.platform === "win32" ? "\\" : "/";
    const base = `${tempRoot()}${sep}runtime${sep}shared`;
    const { rewrite } = rewriter();
    expect(rewrite(`cwd: ${base}${sep}workspaces${sep}${SESSION}`)).toBe("cwd: /workspace");
    expect(rewrite(`${base}${sep}workspaces${sep}${SESSION}${sep}notes${sep}a.txt is here`)).toBe("/workspace/notes/a.txt is here");
    expect(rewrite(`state in ${base}${sep}copilot-home${sep}session-state`)).toBe("state in /platform/copilot-home/session-state");
    expect(rewrite(`${base}${sep}workspaces${sep}someone-else`)).toBe("/platform/workspaces/someone-else");
    // A sibling directory whose name merely starts with the root is not the root.
    expect(rewrite(`${base}-other${sep}file`)).toBe(`${base}-other${sep}file`);
  });

  it("handles JSON-escaped and forward-slash spellings", () => {
    if (process.platform !== "win32") return;
    const { rewrite } = rewriter();
    expect(rewrite(String.raw`"C:\\data\\mc\\runtime\\shared\\workspaces\\${SESSION}"`)).toBe('"/workspace"');
    expect(rewrite(`C:/data/mc/runtime/shared/home`)).toBe("/platform/home");
    expect(rewrite(`c:\\DATA\\mc\\runtime\\shared\\home`)).toBe("/platform/home");
  });
});

describe("exportSessionState", () => {
  it("copies the runtime state, skips locks, and rewrites platform paths", async () => {
    const workspace = join(root, "workspaces", SESSION);
    const start = { type: "session.start", id: "e1", data: { context: { cwd: workspace, gitRoot: null }, tokens: 42, ratio: 0.5 } };
    const message = { type: "user.message", id: "e2", data: { content: "Hello ü \u2028 ok", messageId: "m1" } };
    writeFileSync(join(source, "events.jsonl"), `${JSON.stringify(start)}\n${JSON.stringify(message)}\n`);
    writeFileSync(join(source, "workspace.yaml"), `id: ${SESSION}\ncwd: ${workspace}\nclient_name: sdk\n`);
    writeFileSync(join(source, "checkpoints", "index.md"), "# Checkpoints\n");
    writeFileSync(join(source, ".workspace-fork.lock"), "");
    mkdirSync(join(source, "events.jsonl.lock"));

    const target = join(temp, "staging", SESSION);
    const result = await exportSessionState({ sourceDir: source, targetDir: target, sessionId: SESSION, platformRoots: [root] });

    expect(files(target).sort()).toEqual(["checkpoints/index.md", "events.jsonl", "workspace.yaml"]);
    expect(result).toMatchObject({ files: 3, rewritten: 2 });
    const lines = readFileSync(join(target, "events.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ ...start, data: { ...start.data, context: { cwd: "/workspace", gitRoot: null } } });
    expect(lines[1]).toEqual(message);
    // Lines without platform paths are copied byte for byte.
    expect(readFileSync(join(target, "events.jsonl"), "utf8").split("\n")[1]).toBe(JSON.stringify(message));
    expect(readFileSync(join(target, "workspace.yaml"), "utf8")).toBe(`id: ${SESSION}\ncwd: /workspace\nclient_name: sdk\n`);
    expect(readFileSync(join(target, "checkpoints", "index.md"), "utf8")).toBe("# Checkpoints\n");
  });

  it("refuses state that contains a GitHub token", async () => {
    writeFileSync(join(source, "events.jsonl"), `${JSON.stringify({ type: "user.message", data: { content: `use ghp_${"a".repeat(36)} please` } })}\n`);
    const error = await exportSessionState({ sourceDir: source, targetDir: join(temp, "out"), sessionId: SESSION, platformRoots: [root] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "policy_violation")).toBe(true);
    expect(String((error as Error).message)).toContain("events.jsonl");
    expect(String((error as Error).message)).not.toContain("ghp_");
  });

  it("refuses the owner's literal token in any file, including unknown file types", async () => {
    const secret = "test-owner-token-0123456789abcdef";
    writeFileSync(join(source, "events.jsonl"), "{}\n");
    writeFileSync(join(source, "session.db"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(secret), Buffer.from([3])]));
    const error = await exportSessionState({ sourceDir: source, targetDir: join(temp, "out"), sessionId: SESSION, platformRoots: [root], secrets: [secret] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "policy_violation")).toBe(true);
  });

  it("enforces file and size limits", async () => {
    writeFileSync(join(source, "a.txt"), "a");
    writeFileSync(join(source, "b.txt"), "b");
    const tooMany = await exportSessionState({ sourceDir: source, targetDir: join(temp, "o1"), sessionId: SESSION, platformRoots: [root], limits: { files: 1 } }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(tooMany, "capability_unavailable")).toBe(true);
    const tooBig = await exportSessionState({ sourceDir: source, targetDir: join(temp, "o2"), sessionId: SESSION, platformRoots: [root], limits: { bytes: 1 } }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(tooBig, "capability_unavailable")).toBe(true);
  });

  it("fails clearly when the session has no runtime state", async () => {
    const error = await exportSessionState({ sourceDir: join(root, "missing"), targetDir: join(temp, "o"), sessionId: SESSION, platformRoots: [root] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "state_restore_failed")).toBe(true);
  });

  it("refuses symbolic links", async (context) => {
    writeFileSync(join(temp, "outside.txt"), "outside");
    try {
      symlinkSync(join(temp, "outside.txt"), join(source, "link.txt"));
    } catch {
      context.skip(); // creating symlinks needs privileges on Windows
      return;
    }
    const error = await exportSessionState({ sourceDir: source, targetDir: join(temp, "o"), sessionId: SESSION, platformRoots: [root] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "state_restore_failed")).toBe(true);
  });
});
