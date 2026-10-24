import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_SUMMARY_MARKER, type OutputManifest, type TestReport } from "../src/shared/types.js";

const check = fileURLToPath(new URL("../customizations/workshop/skills/factory-check/check.mjs", import.meta.url));
const hasGit = spawnSync("git", ["--version"]).status === 0;
const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string | Buffer>;

function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "factory-kit-")));
  workspaces.push(dir);
  return dir;
}

function workspace(files: Files): string {
  const dir = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function harness(dir: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FACTORY_CHECK_TIMEOUT_MS;
  delete env.FACTORY_DEBUG;
  Object.assign(env, options.env);
  const result = spawnSync(process.execPath, [check, ...args], { cwd: options.cwd ?? dir, encoding: "utf8", env, timeout: 60_000 });
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lastLine: lines.at(-1) ?? "" };
}

function readOutput(dir: string, rel: string): Buffer {
  return fs.readFileSync(path.join(dir, "outputs", ...rel.split("/")));
}

function report(dir: string): TestReport {
  return JSON.parse(readOutput(dir, "test-report.json").toString("utf8")) as TestReport;
}

function manifest(dir: string): OutputManifest {
  return JSON.parse(readOutput(dir, "manifest.json").toString("utf8")) as OutputManifest;
}

function marker(line: string): Record<string, number> {
  expect(line.startsWith(`${TEST_SUMMARY_MARKER} `)).toBe(true);
  return JSON.parse(line.slice(TEST_SUMMARY_MARKER.length + 1)) as Record<string, number>;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const passingTest = 'require("node:test")("passes", () => {});\n';
const failingTest = 'require("node:test")("must never run", () => { throw new Error("ran an ignored test"); });\n';

describe("factory-check builder mode", () => {
  it("runs passing tests and publishes only new or changed files", () => {
    const pkg = '{"name":"demo","type":"module"}\n';
    const seededReadme = "# Demo\n";
    const dir = workspace({
      "package.json": pkg,
      "README.md": "# Demo\n\nNow with sums.\n",
      "src/sum.js": "export const sum = (a, b) => a + b;\n",
      "src/extra.js": "export const extra = true;\n",
      "test/sum.test.js": [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { sum } from "../src/sum.js";',
        'test("adds", () => assert.equal(sum(1, 2), 3));',
        'test("adds negatives", () => assert.equal(sum(-1, -2), -3));',
        'test("adds strings", { skip: "not yet" }, () => {});',
        "",
      ].join("\n"),
      ".factory/task.json": JSON.stringify({ id: "sum", title: "Sum", files: ["src/sum.js", "./test/sum.test.js"] }),
      ".factory/seed.json": JSON.stringify({ files: { "package.json": sha256(pkg), "README.md": sha256(seededReadme) } }),
      "outputs/NOTES.md": "Agent notes\n",
      "outputs/files/stale.js": "from an earlier run\n",
    });

    const result = harness(dir);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    const testReport = report(dir);
    expect(testReport).toMatchObject({
      schema: "factory.test-report/v1",
      mode: "task",
      taskId: "sum",
      command: "node --test test/sum.test.js",
      exitCode: 0,
      summary: { total: 3, passed: 2, failed: 0, skipped: 1 },
      files: ["test/sum.test.js"],
    });
    expect(testReport.tests.map((test) => [test.name, test.status, test.file])).toEqual([
      ["adds", "passed", "test/sum.test.js"],
      ["adds negatives", "passed", "test/sum.test.js"],
      ["adds strings", "skipped", "test/sum.test.js"],
    ]);
    expect(testReport.tests.every((test) => typeof test.durationMs === "number" && test.error === undefined)).toBe(true);
    expect(Number.isNaN(Date.parse(testReport.startedAt))).toBe(false);
    expect(testReport.output).toContain("adds negatives");

    const published = manifest(dir);
    expect(published).toMatchObject({ schema: "factory.manifest/v1", mode: "task", taskId: "sum" });
    expect(published.files.map((file) => [file.path, file.owned])).toEqual([
      ["README.md", false],
      ["src/extra.js", false],
      ["src/sum.js", true],
      ["test/sum.test.js", true],
    ]);
    for (const file of published.files) {
      const content = fs.readFileSync(path.join(dir, file.path));
      expect(file.size).toBe(content.length);
      expect(file.sha256).toBe(sha256(content));
      expect(readOutput(dir, `files/${file.path}`).equals(content)).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, "outputs", "files", "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "outputs", "files", "stale.js"))).toBe(false);
    expect(readOutput(dir, "NOTES.md").toString()).toBe("Agent notes\n");

    expect(result.stdout).toContain("✔ 2 passed · ✖ 0 failed · 1 skipped");
    expect(result.stdout).toContain("Published 4 files to outputs/files");
    expect(marker(result.lastLine)).toEqual({ total: 3, passed: 2, failed: 0, skipped: 1, durationMs: testReport.durationMs });
  });

  it("reports failing tests with their error messages", () => {
    const dir = workspace({
      "test/math.test.js": [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        'test("adds", () => assert.equal(1 + 1, 2));',
        'test("adds wrong", () => assert.equal(1 + 1, 3));',
        'test("explains at length", () => assert.fail("x".repeat(5000)));',
        "",
      ].join("\n"),
      ".factory/task.json": JSON.stringify({ id: "math", title: "Math", files: ["test/math.test.js"] }),
    });

    // Run from elsewhere to prove --workspace sets the project root for discovery, paths, and outputs.
    const result = harness(dir, ["--workspace", dir], { cwd: os.tmpdir() });

    expect(result.status, result.stdout + result.stderr).toBe(1);
    const testReport = report(dir);
    expect(testReport.exitCode).toBe(1);
    expect(testReport.summary).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
    const wrong = testReport.tests.find((test) => test.name === "adds wrong");
    expect(wrong).toMatchObject({ status: "failed", file: "test/math.test.js" });
    expect(wrong?.error).toContain("2 !== 3");
    const long = testReport.tests.find((test) => test.name === "explains at length");
    expect(long?.error?.length).toBe(2000);
    expect(marker(result.lastLine)).toMatchObject({ total: 3, passed: 1, failed: 2, skipped: 0 });
  });

  it("counts a test file that fails to load as a failed test", () => {
    const dir = workspace({
      "test/good.test.js": passingTest,
      "test/broken.test.js": "const x = ;\n",
      "test/missing.test.mjs": 'import "./nope.mjs";\n',
      ".factory/task.json": JSON.stringify({ id: "broken", title: "Broken", files: [] }),
    });

    const result = harness(dir);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    const testReport = report(dir);
    expect(testReport.summary).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
    const broken = testReport.tests.find((test) => test.file === "test/broken.test.js");
    expect(broken).toMatchObject({ name: "test/broken.test.js", status: "failed" });
    expect(broken?.error).toContain("SyntaxError");
    const missing = testReport.tests.find((test) => test.file === "test/missing.test.mjs");
    expect(missing).toMatchObject({ name: "test/missing.test.mjs", status: "failed" });
    expect(missing?.error).toContain("ERR_MODULE_NOT_FOUND");
    expect(marker(result.lastLine)).toMatchObject({ failed: 2 });
  });

  it("exits 2 when the project has no test files", () => {
    const dir = workspace({
      "package.json": "{}\n",
      "src/index.js": "export {};\n",
      "src/notes.test.txt": "not a test file\n",
      "node_modules/dep/dep.test.js": failingTest,
      "outputs/files/test/old.test.js": failingTest,
      ".factory/task.json": JSON.stringify({ id: "empty", title: "Empty", files: ["src/index.js"] }),
      ".factory/hidden.test.js": failingTest,
    });

    const result = harness(dir);

    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("No test files found. Name test files like test/<name>.test.js.");
    expect(report(dir)).toMatchObject({
      mode: "task",
      taskId: "empty",
      command: "node --test",
      durationMs: 0,
      exitCode: 2,
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      files: [],
      tests: [],
    });
    expect(manifest(dir).files.map((file) => file.path)).toEqual(["package.json", "src/index.js", "src/notes.test.txt"]);
    expect(fs.existsSync(path.join(dir, "outputs", "files", "test"))).toBe(false);
    expect(marker(result.lastLine)).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 });
  });

  it("exits 2 when test files exist but no test runs", () => {
    const dir = workspace({
      "test/skipped.test.js": 'require("node:test")("later", { skip: true }, () => {});\n',
      "test/empty.test.js": "// no tests yet\n",
    });

    const result = harness(dir);

    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("No tests ran");
    const testReport = report(dir);
    expect(testReport.summary).toEqual({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(testReport.tests.map((test) => test.name)).toEqual(["later"]);
  });

  it("never runs or publishes ignored directories, symlinks, or files over 1 MiB", () => {
    const dir = workspace({
      "test/ok.test.js": passingTest,
      "lib/util.js": "module.exports = 1;\n",
      "big.bin": Buffer.alloc(1024 * 1024 + 1),
      "node_modules/dep/dep.test.js": failingTest,
      "lib/node_modules/nested/nested.test.js": failingTest,
      "outputs/stale.test.js": failingTest,
      ".factory/task.json": JSON.stringify({ id: "ok", title: "OK", files: ["test/ok.test.js"] }),
      ".factory/evil.test.js": failingTest,
      ".git/hook.test.js": failingTest,
      "src/.cache/cached.test.js": failingTest,
    });
    let linked = true;
    try {
      fs.symlinkSync(path.join(dir, "node_modules", "dep"), path.join(dir, "linked"), "junction");
    } catch {
      linked = false; // symlinks may be unavailable; the other ignore rules still get checked
    }

    const result = harness(dir);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    const testReport = report(dir);
    expect(testReport.files).toEqual(["test/ok.test.js"]);
    expect(testReport.summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(manifest(dir).files.map((file) => file.path)).toEqual(["lib/util.js", "test/ok.test.js"]);
    expect(fs.readdirSync(path.join(dir, "outputs", "files")).sort()).toEqual(["lib", "test"]);
    expect(result.stdout).toMatch(/⚠ Skipped big\.bin: larger than 1 MiB/);
    if (linked) expect(fs.existsSync(path.join(dir, "linked", "dep.test.js"))).toBe(true);
  });

  it("stops a test run that never finishes", () => {
    const dir = workspace({
      "test/hang.test.js": 'require("node:test")("hangs", () => new Promise((resolve) => setTimeout(resolve, 20_000)));\n',
    });

    const started = Date.now();
    const result = harness(dir, [], { env: { FACTORY_CHECK_TIMEOUT_MS: "1500" } });

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    const testReport = report(dir);
    expect(testReport.exitCode).not.toBe(0);
    expect(testReport.tests).toContainEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining("did not finish within 1.5 seconds") }));
    expect(marker(result.lastLine).failed).toBeGreaterThanOrEqual(1);
  });

  it("fails with a one-line friendly error on unexpected problems", () => {
    const dir = workspace({ ".factory/task.json": "{ not json" });

    const broken = harness(dir);
    expect(broken.status).toBe(3);
    expect(broken.stderr.trim().split(/\r?\n/)).toHaveLength(1);
    expect(broken.stderr).toContain(".factory/task.json is not valid JSON");

    const usage = harness(dir, ["--bogus"]);
    expect(usage.status).toBe(3);
    expect(usage.stderr).toContain("Usage: node check.mjs [--release] [--workspace <dir>]");
    expect(usage.stderr).not.toMatch(/^\s+at /m);
  });
});

describe("factory-check release mode", () => {
  const project: Files = {
    "package.json": '{"name":"csv-tool","type":"module","bin":{"csv":"bin/cli.js"}}\n',
    "bin/cli.js": '#!/usr/bin/env node\nconsole.log("hi");\n',
    "src/csv.js": "line 1\nline 2\nline 3\n",
    "docs/notes.txt": "no newline at end",
    "docs/crlf.txt": "one\r\ntwo\r\n",
    "docs/read me.md": "# Spaced name\n",
    "empty.txt": "",
    "assets/logo.bin": Buffer.from([0x89, 0x50, 0x00, 0x01, 0x0a]),
    "test/csv.test.js": 'import test from "node:test";\ntest("parses", () => {});\n',
  };

  function releaseWorkspace(): string {
    return workspace({
      ...project,
      ".factory/release.json": JSON.stringify({ projectName: "csv-tool" }),
      ".factory/seed.json": JSON.stringify({ files: { "package.json": sha256(project["package.json"]!) } }),
      "node_modules/dep/index.js": "module.exports = 1;\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "outputs/RELEASE.md": "# Release notes\n",
      "outputs/bundle/stale.js": "from an earlier run\n",
    });
  }

  it("bundles every project file and writes a patch that creates them", () => {
    const dir = releaseWorkspace();

    const result = harness(dir, ["--release"]);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    const testReport = report(dir);
    expect(testReport).toMatchObject({ mode: "release", exitCode: 0, summary: { total: 1, passed: 1, failed: 0, skipped: 0 } });
    expect(testReport.taskId).toBeUndefined();

    const paths = Object.keys(project).sort();
    const bundle = manifest(dir);
    expect(bundle).toMatchObject({ schema: "factory.manifest/v1", mode: "release" });
    expect(bundle.files.map((file) => file.path)).toEqual(paths);
    for (const file of bundle.files) {
      const content = fs.readFileSync(path.join(dir, file.path));
      expect(file).toEqual({ path: file.path, size: content.length, sha256: sha256(content) });
      expect(readOutput(dir, `bundle/${file.path}`).equals(content)).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, "outputs", "bundle", "stale.js"))).toBe(false);
    expect(readOutput(dir, "RELEASE.md").toString()).toBe("# Release notes\n");

    const patch = readOutput(dir, "project.patch").toString("utf8");
    expect([...patch.matchAll(/^diff --git a\/(.+) b\//gm)].map((match) => match[1])).toEqual(paths);
    expect(patch).toContain(
      'diff --git a/bin/cli.js b/bin/cli.js\nnew file mode 100755\n--- /dev/null\n+++ b/bin/cli.js\n@@ -0,0 +1,2 @@\n+#!/usr/bin/env node\n+console.log("hi");\n',
    );
    expect(patch).toContain(
      "diff --git a/src/csv.js b/src/csv.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/csv.js\n@@ -0,0 +1,3 @@\n+line 1\n+line 2\n+line 3\n",
    );
    expect(patch).toContain("+++ b/docs/notes.txt\n@@ -0,0 +1 @@\n+no newline at end\n\\ No newline at end of file\n");
    expect(patch).toContain("+++ b/docs/crlf.txt\n@@ -0,0 +1,2 @@\n+one\r\n+two\r\n");
    expect(patch).toContain("+++ b/docs/read me.md\t\n");
    expect(patch).toContain("diff --git a/empty.txt b/empty.txt\nnew file mode 100644\ndiff --git a/package.json");
    expect(patch).toContain("new file mode 100644\nBinary files /dev/null and b/assets/logo.bin differ\n");
    expect(patch).not.toMatch(/node_modules|\.git\/|\.factory|outputs\//);

    expect(result.stdout).toContain("Bundled 9 files of csv-tool to outputs/bundle");
    expect(marker(result.lastLine)).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });

    if (hasGit) {
      // git apply recreates every text file byte for byte (binary files need the bundle).
      const applied = tempDir();
      const patchFile = path.join(dir, "outputs", "project.patch");
      const git = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "--exclude=assets/logo.bin", patchFile], {
        cwd: applied,
        encoding: "utf8",
      });
      expect(git.status, git.stderr).toBe(0);
      for (const rel of paths.filter((file) => file !== "assets/logo.bin")) {
        expect(fs.readFileSync(path.join(applied, rel)).equals(fs.readFileSync(path.join(dir, rel))), rel).toBe(true);
      }
    }
  });
});
