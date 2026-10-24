// Unit tests for promotion's session-state export: lock files skipped, platform paths rewritten (raw and JSON-escaped,
// customizations, punctuation, nested escapes), GitHub tokens refused, unsupported entries, limits, and write failures.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError } from "@managed-copilot/protocol";
import { exportSessionState, pathRewriter, SANDBOX_CUSTOMIZATIONS_MOUNT } from "../src/modules/promotion/export.js";

const SESSION = "0b6f3c55-7a1e-4bb4-9a51-3f4f0e6d1c2a";
let temp: string;
let dataDir: string;
let source: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "mc-promo-export-"));
  dataDir = join(temp, "data");
  source = join(dataDir, "runtime", "shared", "copilot-home", "session-state", SESSION);
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
  const windows = process.platform === "win32";
  const sep = windows ? "\\" : "/";
  const root = windows ? "C:\\data\\mc" : "/var/data/mc";
  const at = (...segments: string[]) => [root, ...segments].join(sep);
  const { rewrite } = pathRewriter([root], SESSION);

  it("maps the session's workspace, the customizations bundle, and other platform paths", () => {
    expect(rewrite(`cwd: ${at("runtime", "shared", "workspaces", SESSION)}`)).toBe("cwd: /workspace");
    expect(rewrite(`${at("runtime", "shared", "workspaces", SESSION, "notes", "a.txt")} is here`)).toBe("/workspace/notes/a.txt is here");
    expect(rewrite(at("customizations", "helper", "3f9a2c", "skills", "refund", "SKILL.md"))).toBe(`${SANDBOX_CUSTOMIZATIONS_MOUNT}/skills/refund/SKILL.md`);
    expect(rewrite(`state in ${at("runtime", "shared", "copilot-home", "session-state")}`)).toBe("state in /platform/copilot-home/session-state");
    expect(rewrite(at("runtime", "shared", "workspaces", "someone-else"))).toBe("/platform/workspaces/someone-else");
    expect(rewrite(at("ledger.db"))).toBe("/platform/ledger.db");
  });

  it("keeps punctuation outside paths and leaves sibling directories alone", () => {
    expect(rewrite(`(cwd: ${at("runtime", "shared", "workspaces", SESSION)})`)).toBe("(cwd: /workspace)");
    expect(rewrite(`Saved under ${at("runtime", "shared", "workspaces", SESSION)}.`)).toBe("Saved under /workspace.");
    expect(rewrite(`[${at("runtime", "shared")}], ok`)).toBe("[/platform], ok");
    expect(rewrite(`${root}.bak${sep}x`)).toBe(`${root}.bak${sep}x`);
    expect(rewrite(`${root}-other${sep}x`)).toBe(`${root}-other${sep}x`);
  });

  it("handles JSON-escaped, forward-slash, and differently cased spellings, and never eats a nested escape", () => {
    if (!windows) return;
    expect(rewrite(String.raw`"C:\\data\\mc\\runtime\\shared\\workspaces\\${SESSION}"`)).toBe('"/workspace"');
    expect(rewrite("C:/data/mc/runtime/shared/home")).toBe("/platform/home");
    expect(rewrite("c:\\DATA\\mc\\runtime\\shared\\home")).toBe("/platform/home");
    // A nested JSON string keeps its `\n` escape after the path.
    expect(rewrite(String.raw`{"cmd":"cat C:\\data\\mc\\runtime\\shared\\workspaces\\${SESSION}\\a.txt\nls"}`)).toBe(String.raw`{"cmd":"cat /workspace/a.txt\nls"}`);
  });
});

describe("exportSessionState", () => {
  it("copies the runtime state, skips locks, and rewrites platform paths", async () => {
    const workspace = join(dataDir, "runtime", "shared", "workspaces", SESSION);
    const skill = join(dataDir, "customizations", "helper", "abc123", "skills", "csv", "SKILL.md");
    const start = { type: "session.start", id: "e1", data: { context: { cwd: workspace, gitRoot: null }, tokens: 42, ratio: 0.5 } };
    const loaded = { type: "session.skills_loaded", id: "e2", data: { skills: [{ name: "csv", path: skill }] } };
    const message = { type: "user.message", id: "e3", data: { content: "Hello ü \u2028 ok", messageId: "m1" } };
    writeFileSync(join(source, "events.jsonl"), `${JSON.stringify(start)}\n${JSON.stringify(loaded)}\n${JSON.stringify(message)}\n`);
    writeFileSync(join(source, "workspace.yaml"), `id: ${SESSION}\ncwd: ${workspace}\nclient_name: sdk\n`);
    writeFileSync(join(source, "checkpoints", "index.md"), "# Checkpoints\n");
    writeFileSync(join(source, ".workspace-fork.lock"), "");
    mkdirSync(join(source, "events.jsonl.lock"));

    const target = join(temp, "staging", SESSION);
    const result = await exportSessionState({ sourceDir: source, targetDir: target, sessionId: SESSION, platformRoots: [dataDir] });

    expect(files(target).sort()).toEqual(["checkpoints/index.md", "events.jsonl", "workspace.yaml"]);
    expect(result).toMatchObject({ files: 3, rewritten: 2 });
    const text = readFileSync(join(target, "events.jsonl"), "utf8");
    const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ ...start, data: { ...start.data, context: { cwd: "/workspace", gitRoot: null } } });
    expect(lines[1]).toEqual({ ...loaded, data: { skills: [{ name: "csv", path: `${SANDBOX_CUSTOMIZATIONS_MOUNT}/skills/csv/SKILL.md` }] } });
    expect(lines[2]).toEqual(message);
    // Lines without platform paths are copied byte for byte.
    expect(text.split("\n")[2]).toBe(JSON.stringify(message));
    expect(text).not.toContain(dataDir.replace(/\\/g, "\\\\"));
    expect(readFileSync(join(target, "workspace.yaml"), "utf8")).toBe(`id: ${SESSION}\ncwd: /workspace\nclient_name: sdk\n`);
    expect(readFileSync(join(target, "checkpoints", "index.md"), "utf8")).toBe("# Checkpoints\n");
  });

  it("refuses state that contains a GitHub token, including Markdown-wrapped ones", async () => {
    for (const content of [`use ghp_${"a".repeat(36)} please`, `_ghp_${"B".repeat(36)}_`, `__github_pat_${"x".repeat(30)}__`]) {
      writeFileSync(join(source, "events.jsonl"), `${JSON.stringify({ type: "user.message", data: { content } })}\n`);
      const error = await exportSessionState({ sourceDir: source, targetDir: join(temp, `out-${content.length}`), sessionId: SESSION, platformRoots: [dataDir] }).catch((caught: unknown) => caught);
      expect(isManagedCopilotError(error, "policy_violation"), content).toBe(true);
      expect(String((error as Error).message)).toContain("events.jsonl");
      expect(String((error as Error).message)).not.toMatch(/ghp_|github_pat_/);
    }
  });

  it("refuses the owner's literal token in any file, including unknown file types", async () => {
    const secret = "test-owner-token-0123456789abcdef";
    writeFileSync(join(source, "events.jsonl"), "{}\n");
    writeFileSync(join(source, "session.db"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(secret), Buffer.from([3])]));
    const error = await exportSessionState({ sourceDir: source, targetDir: join(temp, "out"), sessionId: SESSION, platformRoots: [dataDir], secrets: [secret] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "policy_violation")).toBe(true);
  });

  it("enforces file and size limits", async () => {
    writeFileSync(join(source, "a.txt"), "a");
    writeFileSync(join(source, "b.txt"), "b");
    const tooMany = await exportSessionState({ sourceDir: source, targetDir: join(temp, "o1"), sessionId: SESSION, platformRoots: [dataDir], limits: { files: 1 } }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(tooMany, "capability_unavailable")).toBe(true);
    writeFileSync(join(source, "events.jsonl"), `${"x".repeat(100)}\n`);
    const tooBig = await exportSessionState({ sourceDir: source, targetDir: join(temp, "o2"), sessionId: SESSION, platformRoots: [dataDir], limits: { bytes: 50 } }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(tooBig, "capability_unavailable")).toBe(true);
  });

  it("fails the export when the journal cannot be written", async () => {
    writeFileSync(join(source, "events.jsonl"), '{"type":"user.message"}\n');
    const target = join(temp, "o3");
    // A directory where the journal should go makes the write stream fail.
    mkdirSync(join(target, "events.jsonl"), { recursive: true });
    const error = await exportSessionState({ sourceDir: source, targetDir: target, sessionId: SESSION, platformRoots: [dataDir] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "state_restore_failed")).toBe(true);
  });

  it("fails clearly when the session has no runtime state", async () => {
    const error = await exportSessionState({ sourceDir: join(dataDir, "missing"), targetDir: join(temp, "o"), sessionId: SESSION, platformRoots: [dataDir] }).catch((caught: unknown) => caught);
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
    const error = await exportSessionState({ sourceDir: source, targetDir: join(temp, "o"), sessionId: SESSION, platformRoots: [dataDir] }).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "state_restore_failed")).toBe(true);
  });
});
