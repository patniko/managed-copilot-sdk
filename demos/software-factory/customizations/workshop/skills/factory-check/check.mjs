#!/usr/bin/env node
// factory-check harness: runs the project's tests with Node's test runner, writes outputs/test-report.json, and
// publishes the task's new or changed files (or, with --release, the whole project as a bundle and a patch).
// Usage: node check.mjs [--release] [--workspace <dir>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MARKER = "FACTORY_TEST_SUMMARY";
const USAGE = "Usage: node check.mjs [--release] [--workspace <dir>]";
const REPORTER = fileURLToPath(new URL("reporter.mjs", import.meta.url));
const TIMEOUT_MS = Number(process.env.FACTORY_CHECK_TIMEOUT_MS) || 5 * 60_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/;

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const normalize = (file) => path.posix.normalize(String(file).replace(/\\/g, "/"));
const hash = (content) => createHash("sha256").update(content).digest("hex");
const count = (tests, status) => tests.filter((test) => test.status === status).length;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`✖ factory-check could not finish: ${String(error?.message ?? error).split("\n")[0]}`);
  if (process.env.FACTORY_DEBUG === "1") console.error(error);
  process.exitCode = 3;
}

async function main() {
  const options = parseOptions();
  const root = path.resolve(options.workspace ?? process.cwd());
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace ${root} is not a directory.`);
  const mode = options.release ? "release" : "task";
  const task = mode === "task" ? readMeta(root, "task.json") : undefined;
  const seed = mode === "task" ? readMeta(root, "seed.json") : undefined;
  const release = mode === "release" ? readMeta(root, "release.json") : undefined;
  const taskId = typeof task?.id === "string" ? task.id : undefined;
  if (mode === "task" && task === undefined) console.log("⚠ .factory/task.json not found; publishing without task ownership.");

  const files = listProjectFiles(root);
  const testFiles = files.map((file) => file.path).filter((file) => TEST_FILE.test(path.posix.basename(file)));
  const run = testFiles.length > 0 ? await runTests(root, testFiles) : undefined;
  const tests = run ? withRunnerFailure(run) : [];
  const summary = { total: tests.length, passed: count(tests, "passed"), failed: count(tests, "failed"), skipped: count(tests, "skipped") };
  const durationMs = run?.durationMs ?? 0;

  fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
  writeJson(path.join(root, "outputs", "test-report.json"), {
    schema: "factory.test-report/v1",
    mode,
    taskId,
    command: ["node", "--test", ...testFiles.map(quote)].join(" "),
    startedAt: run?.startedAt ?? new Date().toISOString(),
    durationMs,
    exitCode: run ? run.code || (summary.failed > 0 ? 1 : 0) : 2,
    summary,
    files: testFiles,
    tests,
    output: run?.output,
  });
  const published = mode === "task" ? publishTask(root, files, taskId, task, seed) : publishRelease(root, files, release);

  if (run) {
    const seconds = (durationMs / 1000).toFixed(1);
    console.log(`\n✔ ${summary.passed} passed · ✖ ${summary.failed} failed · ${summary.skipped} skipped (${seconds}s)`);
    if (summary.failed === 0 && summary.passed === 0) console.log("No tests ran: every test was skipped or the test files define none.");
  } else {
    console.log("No test files found. Name test files like test/<name>.test.js.");
  }
  console.log(published);
  console.log(`${MARKER} ${JSON.stringify({ ...summary, durationMs })}`);
  if (!run) return 2;
  if (summary.failed > 0) return 1;
  return summary.passed > 0 ? 0 : 2;
}

function parseOptions() {
  try {
    return parseArgs({ options: { release: { type: "boolean" }, workspace: { type: "string" } } }).values;
  } catch (error) {
    throw new Error(`${error.message.split(". ")[0]}. ${USAGE}`);
  }
}

function readMeta(root, name) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, ".factory", name), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`.factory/${name} is not valid JSON (${error.message}).`);
  }
}

// Project files as sorted workspace-relative POSIX paths. Never follows symlinks.
function listProjectFiles(root) {
  const files = [];
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && rel !== "outputs") visit(abs, `${rel}/`);
      } else if (entry.isFile()) {
        const { size, mode } = fs.lstatSync(abs);
        if (size <= MAX_FILE_BYTES) files.push({ path: rel, abs, mode });
        else console.log(`⚠ Skipped ${rel}: larger than 1 MiB (${(size / MAX_FILE_BYTES).toFixed(1)} MiB).`);
      }
    }
  };
  visit(root, "");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function runTests(root, testFiles) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-check-"));
  const reportFile = path.join(temp, "tests.json");
  const args = [
    "--test",
    `--test-reporter=${pathToFileURL(REPORTER).href}`,
    `--test-reporter-destination=${reportFile}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    // `node --test` treats its arguments as globs, so glob syntax in file names is escaped to match literally.
    ...testFiles.map((file) => file.replace(/[[\]()*?#]/g, "[$&]").replace(/[{}]/g, "?")),
  ];
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.NODE_TEST_CONTEXT;
  console.log(`▶ node --test ${testFiles.map(quote).join(" ")}`);
  const started = Date.now();
  const chunks = [];
  let size = 0;
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop(child);
      }, TIMEOUT_MS);
      const capture = (chunk) => {
        process.stdout.write(chunk);
        chunks.push(chunk);
        size += chunk.length;
        while (size - chunks[0].length >= MAX_OUTPUT_BYTES) size -= chunks.shift().length;
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, signal: null, error, timedOut });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut });
      });
    });
    const durationMs = Date.now() - started;
    const output = Buffer.concat(chunks);
    if (output.length > 0 && output.at(-1) !== 0x0a) process.stdout.write("\n");
    let start = Math.max(0, output.length - MAX_OUTPUT_BYTES);
    while (start < output.length && (output[start] & 0xc0) === 0x80) start++; // don't start mid-character
    const tests = readReport(reportFile);
    return { ...result, tests, startedAt: new Date(started).toISOString(), durationMs, output: output.subarray(start).toString("utf8") };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function stop(child) {
  if (process.platform === "win32") {
    // taskkill /t also ends the per-file test processes, which killing the runner alone would orphan.
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // The runner leads its own process group, so test files and anything they spawned stop with it and release the
  // output pipes (an orphaned grandchild holding them open would otherwise hang the harness).
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5000).unref();
}

function readReport(file) {
  try {
    const { tests } = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(tests) ? tests.filter((test) => ["passed", "failed", "skipped"].includes(test?.status)) : undefined;
  } catch {
    return undefined;
  }
}

// Adds a failed entry when the runner itself failed, so a broken run never looks like a passing one.
function withRunnerFailure(run) {
  const tests = run.tests ?? [];
  const how = run.signal ? `was stopped by ${run.signal}` : `exited with code ${run.code}`;
  const minutes = TIMEOUT_MS / 60_000;
  const limit = minutes >= 1 ? `${+minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}` : `${TIMEOUT_MS / 1000} seconds`;
  let error;
  if (run.error) error = `Could not start the test runner: ${run.error.message}`;
  else if (run.timedOut) error = `Tests did not finish within ${limit} and were stopped. Look for tests that never end, such as open servers, timers, or unresolved promises.`;
  else if (!run.tests) error = `The test runner ${how} without writing a test report. See the test output for details.`;
  else if (run.code !== 0 && count(tests, "failed") === 0) error = `The test runner ${how}, but no test failed. See the test output for details.`;
  return error ? [...tests, { name: "Test runner", status: "failed", error }] : tests;
}

function publishTask(root, files, taskId, task, seed) {
  const seedFiles = seed?.files && typeof seed.files === "object" ? seed.files : {};
  const seeded = new Map(Object.entries(seedFiles).map(([file, sha256]) => [normalize(file), String(sha256).toLowerCase()]));
  const owned = new Set((Array.isArray(task?.files) ? task.files : []).map(normalize));
  const target = path.join(root, "outputs", "files");
  fs.rmSync(target, { recursive: true, force: true });
  const published = [];
  for (const file of files) {
    const content = read(file);
    if (content === undefined) continue;
    const sha256 = hash(content);
    if (seeded.get(file.path) === sha256) continue;
    copy(file, content, target);
    published.push({ path: file.path, size: content.length, sha256, owned: owned.has(file.path) });
  }
  const generatedAt = new Date().toISOString();
  writeJson(path.join(root, "outputs", "manifest.json"), { schema: "factory.manifest/v1", mode: "task", taskId, generatedAt, files: published });
  return `Published ${plural(published.length, "file")} to outputs/files`;
}

function publishRelease(root, files, release) {
  const target = path.join(root, "outputs", "bundle");
  fs.rmSync(target, { recursive: true, force: true });
  const bundled = [];
  const patch = [];
  for (const file of files) {
    const content = read(file);
    if (content === undefined) continue;
    copy(file, content, target);
    bundled.push({ path: file.path, size: content.length, sha256: hash(content) });
    patch.push(diff(file, content));
  }
  fs.writeFileSync(path.join(root, "outputs", "project.patch"), Buffer.concat(patch));
  const generatedAt = new Date().toISOString();
  writeJson(path.join(root, "outputs", "manifest.json"), { schema: "factory.manifest/v1", mode: "release", generatedAt, files: bundled });
  const name = typeof release?.projectName === "string" && release.projectName ? ` of ${release.projectName}` : "";
  return `Bundled ${plural(bundled.length, "file")}${name} to outputs/bundle (patch: outputs/project.patch)`;
}

// A git-style diff that creates the file from nothing.
function diff(file, content) {
  const executable = (file.mode & 0o111) !== 0 || content.subarray(0, 2).toString("latin1") === "#!";
  const header = `diff --git a/${file.path} b/${file.path}\nnew file mode ${executable ? "100755" : "100644"}\n`;
  if (content.length === 0) return Buffer.from(header);
  if (content.subarray(0, 8000).includes(0)) return Buffer.from(`${header}Binary files /dev/null and b/${file.path} differ\n`);
  // latin1 maps each byte to one character, so lines round-trip byte for byte in any encoding (CRLF stays CRLF).
  const lines = content.toString("latin1").split("\n");
  const newlineAtEnd = lines.at(-1) === "";
  if (newlineAtEnd) lines.pop();
  // Like git, end the +++ line with a tab when the path has a space so the name's end is unambiguous.
  const hunk = `--- /dev/null\n+++ b/${file.path}${file.path.includes(" ") ? "\t" : ""}\n@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n`;
  const body = `${lines.map((line) => `+${line}\n`).join("")}${newlineAtEnd ? "" : "\\ No newline at end of file\n"}`;
  return Buffer.concat([Buffer.from(header + hunk), Buffer.from(body, "latin1")]);
}

function read(file) {
  try {
    return fs.readFileSync(file.abs);
  } catch (error) {
    if (error.code === "ENOENT") return undefined; // removed while the tests ran
    throw error;
  }
}

function copy(file, content, target) {
  const destination = path.join(target, ...file.path.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, { mode: file.mode & 0o111 ? 0o755 : 0o644 });
}
