/**
 * Fixture data for the UI preview (`?preview` in dev only). Never imported by production code paths.
 * Covers every station status, review findings, test reports, patches, and release outputs.
 */
import { TEMPLATES } from "../../shared/templates.js";
import {
  TEST_SUMMARY_MARKER,
  type ActivityItem,
  type EnvironmentView,
  type NetworkView,
  type PlatformStatus,
  type ReviewRecord,
  type Station,
  type StationRole,
  type TestReport,
  type TestSummary,
  type WorkOrder,
} from "../../shared/types.js";

export interface FixtureVersion {
  readonly version: number;
  readonly round: number;
  readonly content: string;
  readonly publishedAt: string;
}

export interface FixtureFile {
  readonly stationId: string;
  readonly path: string;
  readonly contentType: string;
  readonly viewable: boolean;
  /** Newest last. */
  readonly versions: FixtureVersion[];
}

export interface Fixtures {
  platform: PlatformStatus;
  workOrders: WorkOrder[];
  activity: Map<string, ActivityItem[]>;
  files: Map<string, FixtureFile[]>;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const REGISTRY_HOST = "npm.pkg.example.com";
const RESTRICTED: NetworkView = {
  access: "restricted",
  allowedDomains: [REGISTRY_HOST, "github.com", "*.github.com", "*.githubusercontent.com"],
};
const OFF: NetworkView = { access: "disabled", allowedDomains: [] };

export const ENVIRONMENTS: readonly EnvironmentView[] = [
  {
    role: "planner",
    name: "factory-planner",
    type: "shared",
    description: "Splits work orders into tasks. Office customizations, no sandbox.",
    network: OFF,
    agents: ["planner"],
    model: "claude-sonnet-4.5",
  },
  {
    role: "builder",
    name: "factory-builder",
    type: "isolated",
    description: "One fresh Linux sandbox per task with the workshop toolkit and test harness.",
    network: RESTRICTED,
    size: "small",
    agents: ["builder"],
    model: "gpt-5.1-codex",
  },
  {
    role: "reviewer",
    name: "factory-reviewer",
    type: "shared",
    description: "Reviews each task's code and test report with a different model.",
    network: OFF,
    agents: ["reviewer"],
    model: "claude-sonnet-4.5",
  },
  {
    role: "coordinator",
    name: "factory-coordinator",
    type: "orchestrator",
    description: "Creates and reuses builder and release sandboxes as an accepted plan needs them.",
    network: OFF,
    agents: ["coordinator"],
    model: "claude-sonnet-5",
  },
  {
    role: "release",
    name: "factory-release",
    type: "isolated",
    description: "Integrates every task, runs the full suite, and packages the release.",
    network: RESTRICTED,
    size: "small",
    agents: ["release"],
    model: "gpt-5.1-codex",
  },
];

function environmentFor(role: StationRole): EnvironmentView {
  const environment = ENVIRONMENTS.find((candidate) => candidate.role === role);
  if (!environment) throw new Error(`No fixture environment for ${role}`);
  return environment;
}

export function platformFixture(state: PlatformStatus["state"], now: number): PlatformStatus {
  const connected = state === "connected";
  return {
    state,
    url: "http://localhost:7400",
    message:
      state === "connecting"
        ? "Waiting for the Managed Copilot gateway to come up."
        : state === "unavailable"
          ? "The factory can't reach Managed Copilot at http://localhost:7400."
          : state === "misconfigured"
            ? "The deployment is missing environments the factory needs."
            : undefined,
    hint:
      state === "unavailable" || state === "connecting"
        ? "Start the platform with `aspire run` from the repository root."
        : state === "misconfigured"
          ? "Add the factory environments with `softwareFactory()` in the AppHost, then restart `aspire run`."
          : undefined,
    deployment: connected
      ? {
          name: "contoso-dev",
          mode: "local",
          version: "0.1.0",
          capabilities: ["sessions", "isolated-sandboxes", "artifacts", "files", "attach", "network-policy"],
          copilotSdk: "1.0.26",
          copilotRuntime: "1.0.103",
        }
      : undefined,
    account: connected ? { login: "mona", name: "Mona Octocat" } : undefined,
    environments: state === "misconfigured" ? ENVIRONMENTS.filter((environment) => environment.role !== "release" && environment.role !== "builder") : connected ? ENVIRONMENTS : [],
    missingEnvironments: state === "misconfigured" ? ["factory-builder", "factory-release"] : [],
    features: { runs: connected, agentLed: connected, isolated: connected, artifacts: connected, files: connected, attach: connected },
    checkedAt: new Date(now - 8 * SECOND).toISOString(),
  };
}

// ─── Builders ────────────────────────────────────────────────────────────────────────────────────────────────

let sandboxCounter = 0;
function sandboxId(): string {
  sandboxCounter += 1;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let id = "01JB";
  let seed = sandboxCounter * 7919;
  for (let index = 0; index < 22; index += 1) {
    seed = (seed * 48271) % 2147483647;
    id += alphabet[seed % alphabet.length];
  }
  return `sbx_${id}`;
}

function sessionId(stationId: string, salt: number): string {
  const hex = Array.from(`${stationId}:${salt}`).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7).toString(16);
  return `ses_${hex.padStart(8, "0")}${(salt * 2654435761 >>> 0).toString(16).padStart(8, "0")}`;
}

const IMAGE = "ghcr.io/contoso/factory-workshop@sha256:4f0c9e2b7d1a6e3f5c8b2a9d0e7f1c3b5a6d8e9f0a1b2c3d4e5f6a7b8c9d0e1f";

interface StationInput {
  readonly id: string;
  readonly kind: Station["kind"];
  readonly title: string;
  readonly status: Station["status"];
  readonly role: StationRole;
  readonly taskId?: string;
  readonly detail?: string;
  readonly round?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly tests?: TestSummary;
  readonly reviews?: readonly ReviewRecord[];
  readonly acceptedWithFindings?: boolean;
  readonly error?: Station["error"];
  readonly sandboxState?: string;
  readonly usage?: Station["usage"];
  readonly previousSessionIds?: readonly string[];
  readonly sessionState?: string;
  readonly turnKind?: NonNullable<Station["turn"]>["kind"];
}

function station(input: StationInput, salt: number): Station {
  const environment = environmentFor(input.role);
  const sandboxed = environment.type !== "shared";
  const started = input.startedAt !== undefined && input.status !== "waiting";
  const active = input.status === "starting" || input.status === "working" || input.status === "collecting";
  const round = input.round ?? (started ? 1 : 0);
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    taskId: input.taskId,
    status: input.status,
    detail: input.detail,
    role: input.role,
    environment: environment.name,
    placement: sandboxed ? "sandbox" : "shared",
    agent: environment.agents[0] ?? input.role,
    model: environment.model,
    sessionId: started ? sessionId(input.id, salt) : undefined,
    sessionState: started ? (input.sessionState ?? (active ? "running" : sandboxed ? "stopped" : "idle")) : undefined,
    turn:
      started && input.startedAt
        ? {
            kind: input.turnKind ?? (input.kind === "review" ? "review" : round > 1 ? "fix" : "work"),
            round: Math.max(round, 1),
            sentAt: input.startedAt,
            completedAt: active ? undefined : input.finishedAt,
          }
        : undefined,
    previousSessionIds: input.previousSessionIds,
    sandbox:
      sandboxed && started
        ? {
            id: sandboxId(),
            size: environment.size ?? "small",
            state: input.sandboxState ?? (input.finishedAt ? "stopped" : "running"),
            image: IMAGE,
            network: environment.network,
            startedAt: input.startedAt,
          }
        : undefined,
    round: round,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    tests: input.tests,
    usage: input.usage ?? (started ? { inputTokens: 18_400 + salt * 731, outputTokens: 3_100 + salt * 97, cacheReadTokens: 9_800, requests: 9 + salt, durationMs: 64_000 } : undefined),
    reviews: input.reviews,
    acceptedWithFindings: input.acceptedWithFindings,
    error: input.error,
  };
}

function tests(passed: number, failed: number, skipped: number, durationMs: number, at: string): TestSummary {
  return { total: passed + failed + skipped, passed, failed, skipped, durationMs, at };
}

function newFilePatch(files: readonly { readonly path: string; readonly content: string }[]): string {
  return files
    .map(({ path, content }) => {
      const lines = content.replace(/\n$/, "").split("\n");
      return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..3f2a9c1",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}

function testReport(
  mode: TestReport["mode"],
  taskId: string | undefined,
  command: string,
  startedAt: string,
  cases: TestReport["tests"],
  output: string,
): string {
  const passed = cases.filter((test) => test.status === "passed").length;
  const failed = cases.filter((test) => test.status === "failed").length;
  const skipped = cases.filter((test) => test.status === "skipped").length;
  const report: TestReport = {
    schema: "factory.test-report/v1",
    mode,
    taskId,
    command,
    startedAt,
    durationMs: cases.reduce((sum, test) => sum + (test.durationMs ?? 0), 0) + 310,
    exitCode: failed > 0 ? 1 : 0,
    summary: { total: cases.length, passed, failed, skipped },
    files: [...new Set(cases.map((test) => test.file).filter((file): file is string => Boolean(file)))],
    tests: cases,
    output,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ─── File contents ───────────────────────────────────────────────────────────────────────────────────────────

const CSV_V1 = `/**
 * RFC 4180 CSV parsing for csvjson.
 * @param {string} text
 * @param {{ delimiter?: string }} [options]
 * @returns {string[][]}
 */
export function parseCsv(text, { delimiter = "," } = {}) {
  const rows = [];
  for (const line of text.split("\\n")) {
    if (line === "") continue;
    rows.push(splitLine(line, delimiter));
  }
  return rows;
}

function splitLine(line, delimiter) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}
`;

const CSV_V2 = `/**
 * RFC 4180 CSV parsing for csvjson.
 * Handles quoted fields, escaped quotes (""), delimiters and newlines inside quotes, and CRLF or LF endings.
 * @param {string} text
 * @param {{ delimiter?: string }} [options]
 * @returns {string[][]}
 */
export function parseCsv(text, { delimiter = "," } = {}) {
  if (delimiter.length !== 1) throw new TypeError("delimiter must be a single character");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\\n" || char === "\\r") {
      if (char === "\\r" && text[i + 1] === "\\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new SyntaxError("Unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
`;

const CSV_PATCH_V2 = `diff --git a/src/csv.js b/src/csv.js
index 3f2a9c1..8d41b0e 100644
--- a/src/csv.js
+++ b/src/csv.js
@@ -1,15 +1,46 @@
 /**
  * RFC 4180 CSV parsing for csvjson.
+ * Handles quoted fields, escaped quotes (""), delimiters and newlines inside quotes, and CRLF or LF endings.
  * @param {string} text
  * @param {{ delimiter?: string }} [options]
  * @returns {string[][]}
  */
 export function parseCsv(text, { delimiter = "," } = {}) {
+  if (delimiter.length !== 1) throw new TypeError("delimiter must be a single character");
   const rows = [];
-  for (const line of text.split("\\n")) {
-    if (line === "") continue;
-    rows.push(splitLine(line, delimiter));
+  let row = [];
+  let field = "";
+  let quoted = false;
+  for (let i = 0; i < text.length; i += 1) {
+    const char = text[i];
+    if (quoted) {
+      if (char === '"' && text[i + 1] === '"') {
+        field += '"';
+        i += 1;
+      } else if (char === '"') {
+        quoted = false;
+      } else {
+        field += char;
+      }
+      continue;
+    }
+    if (char === "\\n" || char === "\\r") {
+      if (char === "\\r" && text[i + 1] === "\\n") i += 1;
+      row.push(field);
+      rows.push(row);
+      row = [];
+      field = "";
+    } else if (char === delimiter) {
+      row.push(field);
+      field = "";
+    } else if (char === '"') {
+      quoted = true;
+    } else {
+      field += char;
+    }
   }
+  if (quoted) throw new SyntaxError("Unterminated quoted field");
   return rows;
 }
-
-function splitLine(line, delimiter) {
-  const fields = [];
\\ No newline at end of file
`;

const CSV_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/csv.js";

test("parses a header row and records", () => {
  assert.deepEqual(parseCsv("a,b\\n1,2\\n"), [["a", "b"], ["1", "2"]]);
});

test("keeps commas inside quotes", () => {
  assert.deepEqual(parseCsv('name,city\\n"Doe, Jane",Oslo\\n'), [["name", "city"], ["Doe, Jane", "Oslo"]]);
});

test("unescapes doubled quotes", () => {
  assert.deepEqual(parseCsv('q\\n"say ""hi"""\\n'), [["q"], ['say "hi"']]);
});

test("handles CRLF line endings", () => {
  assert.deepEqual(parseCsv("a,b\\r\\n1,2\\r\\n"), [["a", "b"], ["1", "2"]]);
});

test("keeps newlines inside quoted fields", () => {
  assert.deepEqual(parseCsv('note\\n"line one\\r\\nline two"\\n'), [["note"], ["line one\\r\\nline two"]]);
});

test("rejects an unterminated quote", () => {
  assert.throws(() => parseCsv('a\\n"oops\\n'), /Unterminated/);
});
`;

const SEMVER = `const PATTERN =
  /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$/;

/** Parses a semantic version (semver 2.0.0). */
export function parse(version) {
  const match = PATTERN.exec(String(version).trim());
  if (!match) throw new SyntaxError(\`Invalid version: \${version}\`);
  const [, major, minor, patch, prerelease, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
    build: build ? build.split(".") : [],
  };
}

function compareIdentifiers(a, b) {
  const numericA = /^\\d+$/.test(a);
  const numericB = /^\\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  if (numericA) return -1;
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares two versions by semver precedence: -1, 0, or 1. Build metadata is ignored. */
export function compare(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const result = compareIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (result !== 0) return result;
  }
  return 0;
}

export const sort = (versions) => [...versions].sort(compare);

/** Bumps a version, dropping prerelease and build metadata. */
export function bump(version, part) {
  const { major, minor, patch } = parse(version);
  if (part === "major") return \`\${major + 1}.0.0\`;
  if (part === "minor") return \`\${major}.\${minor + 1}.0\`;
  if (part === "patch") return \`\${major}.\${minor}.\${patch + 1}\`;
  throw new TypeError(\`Unknown part: \${part}\`);
}
`;

const SEMVER_CLI = `#!/usr/bin/env node
import { bump, compare, sort } from "../src/semver.js";

const [command, ...args] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(\`semver: \${message}\\n\`);
  process.exit(1);
}

try {
  if (command === "compare" && args.length === 2) {
    process.stdout.write(\`\${compare(args[0], args[1])}\\n\`);
  } else if (command === "sort" && args.length > 0) {
    process.stdout.write(\`\${sort(args).join("\\n")}\\n\`);
  } else if (command === "bump" && args.length === 2) {
    process.stdout.write(\`\${bump(args[1], args[0])}\\n\`);
  } else {
    fail("usage: semver compare <a> <b> | sort <versions...> | bump <major|minor|patch> <version>");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
`;

const SEMVER_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { bump, compare, parse, sort } from "../src/semver.js";

test("parses prerelease and build metadata", () => {
  assert.deepEqual(parse("1.2.3-alpha.1+exp.sha"), { major: 1, minor: 2, patch: 3, prerelease: ["alpha", "1"], build: ["exp", "sha"] });
});

test("orders by precedence", () => {
  assert.equal(compare("1.2.3", "1.10.0"), -1);
  assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compare("1.0.0+build", "1.0.0"), 0);
});

test("sorts prereleases like the spec", () => {
  assert.deepEqual(sort(["1.0.0", "1.0.0-rc.1", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta"]), [
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-rc.1", "1.0.0",
  ]);
});

test("bumps versions", () => {
  assert.equal(bump("1.2.3-rc.1", "minor"), "1.3.0");
});
`;

const SEMVER_README = `# semver-lite

A zero-dependency semantic versioning library and CLI for Node.js 24, built by the Software Factory.

## Install

\`\`\`sh
npm install ./semver-lite-0.1.0.tgz
\`\`\`

## Library

\`\`\`js
import { parse, compare, sort, bump } from "semver-lite";

compare("1.2.3", "1.10.0"); // -1
sort(["1.0.0", "1.0.0-rc.1", "1.0.0-alpha"]); // ["1.0.0-alpha", "1.0.0-rc.1", "1.0.0"]
bump("1.2.3", "minor"); // "1.3.0"
\`\`\`

## CLI

| Command | Example | Output |
| --- | --- | --- |
| \`compare\` | \`semver compare 1.2.3 1.10.0\` | \`-1\` |
| \`sort\` | \`semver sort 1.0.0 1.0.0-rc.1\` | one version per line |
| \`bump\` | \`semver bump minor 1.2.3\` | \`1.3.0\` |

Invalid input exits with status 1 and a one-line error.

## Tests

\`\`\`sh
node --test
\`\`\`
`;

const SEMVER_RELEASE_NOTES = `## semver-lite 0.1.0

First release of **semver-lite**, a zero-dependency semantic versioning toolkit.

### Highlights

- \`parse\`, \`compare\`, \`sort\`, and \`bump\` follow semver 2.0.0 precedence, including prerelease ordering.
- The \`semver\` CLI wraps the library with \`compare\`, \`sort\`, and \`bump\` commands.
- 34 tests cover the library and the CLI end to end.

### Known issues

- The CLI accepts \`bump\` arguments in either order; the reviewer suggested enforcing \`bump <part> <version>\` (minor).

### Verification

- \`node --test\` — 34 passed, 0 failed, 1 skipped (Windows path test).
`;

const PACKAGE_JSON = `{
  "name": "semver-lite",
  "version": "0.1.0",
  "description": "Parse, compare, sort, and bump semantic versions.",
  "type": "module",
  "exports": "./src/semver.js",
  "bin": { "semver": "./bin/semver.js" },
  "engines": { "node": ">=24" },
  "scripts": { "test": "node --test" },
  "license": "MIT"
}
`;

// ─── Work orders ─────────────────────────────────────────────────────────────────────────────────────────────

function at(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

let activityCounter = 0;

type Entry = readonly [offsetSeconds: number, item: Omit<ActivityItem, "id" | "workOrderId" | "stationId" | "at"> & { readonly id?: string }];

function activity(workOrderId: string, stationId: string, base: number, entries: readonly Entry[]): ActivityItem[] {
  return entries.map(([offset, item]) => {
    activityCounter += 1;
    return {
      ...item,
      id: item.id ?? `${item.kind}:${stationId}:${activityCounter}`,
      workOrderId,
      stationId,
      at: at(base, offset * SECOND),
    };
  });
}

function tool(
  name: string,
  summary: string,
  status: "running" | "succeeded" | "failed",
  durationMs?: number,
  output?: string,
  exitCode?: number,
): Entry[1] {
  activityCounter += 1;
  return {
    kind: "tool",
    tool: { callId: `call_${activityCounter.toString(36)}`, name, summary, status, durationMs, output, exitCode },
  };
}

function harnessOutput(passed: number, failed: number, skipped: number, durationMs: number, failures = ""): string {
  return [
    "> node --test --test-reporter=spec",
    "",
    failures || "✔ all tests passed",
    "",
    `ℹ tests ${passed + failed + skipped}`,
    `ℹ pass ${passed}`,
    `ℹ fail ${failed}`,
    `ℹ skipped ${skipped}`,
    `ℹ duration_ms ${durationMs}`,
    `${TEST_SUMMARY_MARKER} ${JSON.stringify({ total: passed + failed + skipped, passed, failed, skipped, durationMs })}`,
  ].join("\n");
}

function csvToolkit(now: number, fixtures: Fixtures): void {
  const id = "wo_csvjson";
  const base = now - 6 * MINUTE - 20 * SECOND;
  const template = TEMPLATES.find((candidate) => candidate.id === "csv-json-toolkit");
  const review1: ReviewRecord = {
    round: 1,
    verdict: "request_changes",
    summary:
      "The parser splits the input on `\\n` before handling quotes, so quoted fields that contain line breaks are cut in half and CRLF input leaves stray `\\r` characters.",
    findings: [
      { severity: "blocker", file: "src/csv.js", line: 9, message: "Splitting on \\n before parsing breaks quoted fields that contain newlines (RFC 4180 §2.6)." },
      { severity: "major", file: "src/csv.js", line: 10, message: "CRLF input leaves a trailing \\r in the last field of every row." },
      { severity: "minor", file: "test/csv.test.js", message: "Add a regression test for an unterminated quoted field." },
    ],
    at: at(base, 3 * MINUTE + 40 * SECOND),
  };
  const stations: Station[] = [
    station({ id: "plan", kind: "plan", title: "Plan", status: "done", role: "planner", startedAt: at(base, 5 * SECOND), finishedAt: at(base, 52 * SECOND), detail: "Planned 4 tasks" }, 1),
    station(
      {
        id: "build:csv-parser",
        kind: "build",
        title: "Build · CSV parser",
        taskId: "csv-parser",
        status: "working",
        role: "builder",
        round: 2,
        detail: "Fixing CRLF handling in src/csv.js",
        startedAt: at(base, 58 * SECOND),
        tests: tests(10, 2, 0, 1380, at(base, 3 * MINUTE)),
      },
      2,
    ),
    station(
      {
        id: "review:csv-parser",
        kind: "review",
        title: "Review · CSV parser",
        taskId: "csv-parser",
        status: "changes_requested",
        role: "reviewer",
        round: 1,
        detail: "Sent back to the builder: 1 blocker, 1 major, 1 minor",
        startedAt: at(base, 3 * MINUTE + 5 * SECOND),
        finishedAt: at(base, 3 * MINUTE + 40 * SECOND),
        reviews: [review1],
      },
      3,
    ),
    station(
      {
        id: "build:json-writer",
        kind: "build",
        title: "Build · JSON to CSV writer",
        taskId: "json-writer",
        status: "collecting",
        role: "builder",
        detail: "Collecting artifacts and the test report",
        startedAt: at(base, 59 * SECOND),
        tests: tests(9, 0, 0, 940, at(base, 5 * MINUTE + 50 * SECOND)),
      },
      4,
    ),
    station({ id: "review:json-writer", kind: "review", title: "Review · JSON to CSV writer", taskId: "json-writer", status: "waiting", role: "reviewer", detail: "Waiting for the build" }, 5),
    station(
      {
        id: "build:cli",
        kind: "build",
        title: "Build · Command-line tools",
        taskId: "cli",
        status: "waiting",
        role: "builder",
        detail: "Waiting for CSV parser and JSON to CSV writer",
      },
      6,
    ),
    station({ id: "review:cli", kind: "review", title: "Review · Command-line tools", taskId: "cli", status: "waiting", role: "reviewer" }, 7),
    station(
      {
        id: "build:docs",
        kind: "build",
        title: "Build · README and examples",
        taskId: "docs",
        status: "starting",
        role: "builder",
        detail: "Creating sandbox (small, restricted network)",
        startedAt: at(base, 6 * MINUTE + 5 * SECOND),
        sandboxState: "provisioning",
      },
      8,
    ),
    station({ id: "review:docs", kind: "review", title: "Review · README and examples", taskId: "docs", status: "waiting", role: "reviewer" }, 9),
    station({ id: "release", kind: "release", title: "Release", status: "waiting", role: "release", detail: "Waiting for every task to be approved" }, 10),
  ];
  const workOrder: WorkOrder = {
    id,
    number: 9,
    title: "CSV ⇄ JSON toolkit",
    status: "building",
    createdAt: at(base, 0),
    updatedAt: at(now, -2 * SECOND),
    startedAt: at(base, 2 * SECOND),
    taskCount: 4,
    brief: template?.brief ?? "Build csvjson.",
    source: { kind: "template", templateId: "csv-json-toolkit" },
    maxReviewRounds: 2,
    owner: { login: "mona" },
    plan: {
      summary:
        "Build `csvjson` as four tasks: a streaming-safe **CSV parser**, a **JSON to CSV writer**, the two **command-line tools** that wrap them, and a **README with examples**. The parser and writer have no dependencies and build in parallel; the CLIs wait for both.",
      projectName: "csvjson",
      packageDescription: "Zero-dependency CSV ⇄ JSON conversion for Node.js 24.",
      bin: { csv2json: "bin/csv2json.js", json2csv: "bin/json2csv.js" },
      integration:
        "1. `bin/csv2json.js` uses `parseCsv` and `inferValue`; `bin/json2csv.js` uses `toCsv`.\n2. Verify round trips: `csv2json data.csv | json2csv` should reproduce equivalent CSV.\n3. Run the full suite with `node --test` and check both CLIs exit with status 1 on bad input.",
      tasks: [
        {
          id: "csv-parser",
          title: "CSV parser",
          description: "RFC 4180 parser with quoted fields, escaped quotes, and CRLF or LF line endings. Exposes value inference for numbers, booleans, and empty fields.",
          files: ["src/csv.js", "test/csv.test.js"],
          interface: "export function parseCsv(text: string, options?: { delimiter?: string }): string[][];\nexport function inferValue(field: string): string | number | boolean | null;",
          acceptance: [
            "Quoted fields may contain the delimiter, doubled quotes, and newlines",
            "CRLF and LF input produce identical rows",
            "An unterminated quote throws a SyntaxError",
          ],
          dependsOn: [],
        },
        {
          id: "json-writer",
          title: "JSON to CSV writer",
          description: "Serialize an array of objects to CSV with a header row that is the union of keys in first-seen order.",
          files: ["src/json.js", "test/json.test.js"],
          interface: "export function toCsv(records: Record<string, unknown>[], options?: { delimiter?: string }): string;",
          acceptance: ["Missing values are empty", "Fields with delimiters, quotes, or newlines are quoted and escaped"],
          dependsOn: [],
        },
        {
          id: "cli",
          title: "Command-line tools",
          description: "`csv2json` and `json2csv` read a file path argument or stdin and print to stdout.",
          files: ["bin/csv2json.js", "bin/json2csv.js", "test/cli.test.js"],
          interface: "csv2json [file] [--pretty] [--delimiter <char>] [--no-infer]\njson2csv [file] [--delimiter <char>]",
          acceptance: ["`--pretty` prints with 2-space indentation", "Invalid input or a missing file exits 1 with a one-line error"],
          dependsOn: ["csv-parser", "json-writer"],
        },
        {
          id: "docs",
          title: "README and examples",
          description: "Document installation, both CLIs, and the library API with runnable examples.",
          files: ["README.md", "examples/people.csv"],
          acceptance: ["Every documented example runs as written"],
          dependsOn: [],
        },
      ],
    },
    stations,
  };
  fixtures.workOrders.push(workOrder);

  fixtures.activity.set(id, [
    ...activity(id, "plan", base, [
      [5, { kind: "status", text: "Session started on `factory-planner` (shared, network off)" }],
      [7, { kind: "skill", text: "task-decomposition" }],
      [9, { kind: "intent", text: "Splitting the brief into independent tasks" }],
      [31, { kind: "message", text: "I split **csvjson** into four tasks. The parser and the writer are independent, so they can build in parallel sandboxes; the CLI task depends on both, and the README can start right away.\n\n| Task | Depends on |\n| --- | --- |\n| `csv-parser` | — |\n| `json-writer` | — |\n| `cli` | `csv-parser`, `json-writer` |\n| `docs` | — |" }],
      [50, { kind: "status", text: "Plan submitted: 4 tasks", level: "success" }],
    ]),
    ...activity(id, "build:csv-parser", base, [
      [58, { kind: "status", text: "Sandbox `sbx_01JB…` ready (small · 1 vCPU · 2 GiB, restricted network)" }],
      [62, { kind: "skill", text: "factory-check" }],
      [64, { kind: "intent", text: "Writing the CSV parser" }],
      [66, tool("view", "/workspace/TASK.md", "succeeded", 40, "# Task csv-parser\n\nRFC 4180 parser with quoted fields...")],
      [80, tool("create", "src/csv.js", "succeeded", 120)],
      [96, tool("create", "test/csv.test.js", "succeeded", 95)],
      [110, { kind: "message", text: "The first version of `parseCsv` is in place with tests for quoting and escaped quotes. Running the harness next." }],
      [120, tool("bash", "node .factory/check.mjs --task csv-parser", "failed", 1380, harnessOutput(10, 2, 0, 1380, "✖ handles CRLF line endings\n✖ keeps newlines inside quoted fields"), 1)],
      [122, { kind: "test", tests: tests(10, 2, 0, 1380, at(base, 122 * SECOND)), text: "2 failures: CRLF handling and newlines inside quotes" }],
      [130, { kind: "message", text: "Two tests fail because the parser splits on `\\n` first. I'll publish this round so the reviewer sees the current state, then fix it if changes are requested." }],
      [176, { kind: "artifact", text: "Published 4 files" }],
      [222, { kind: "status", text: "Round 2: the reviewer requested changes (1 blocker, 1 major, 1 minor)", level: "warning" }],
      [226, { kind: "intent", text: "Fixing CRLF handling in the parser" }],
      [229, tool("view", "src/csv.js", "succeeded", 31, CSV_V1.slice(0, 600))],
    ]),
    ...activity(id, "review:csv-parser", base, [
      [185, { kind: "status", text: "Session started on `factory-reviewer` (shared, network off)" }],
      [187, { kind: "skill", text: "review-rubric" }],
      [190, tool("view", "outputs/files/src/csv.js", "succeeded", 22)],
      [192, tool("view", "outputs/test-report.json", "succeeded", 18)],
      [214, { kind: "message", text: "**Changes requested.** The parser splits on `\\n` before it handles quotes, which breaks two acceptance criteria:\n\n1. Quoted fields with line breaks are cut in half.\n2. CRLF input leaves a trailing `\\r`.\n\nParse character by character and track the quote state across line breaks." }],
      [220, { kind: "review", review: { round: 1, verdict: "request_changes", findings: 3 }, level: "warning" }],
    ]),
    ...activity(id, "build:json-writer", base, [
      [59, { kind: "status", text: "Sandbox ready (small · 1 vCPU · 2 GiB, restricted network)" }],
      [63, { kind: "intent", text: "Writing toCsv with RFC 4180 quoting" }],
      [90, tool("create", "src/json.js", "succeeded", 110)],
      [104, tool("create", "test/json.test.js", "succeeded", 84)],
      [118, tool("bash", "npm ls --depth=0", "succeeded", 610, "csvjson@0.0.0 /workspace\n└── (empty)")],
      [340, tool("bash", "node .factory/check.mjs --task json-writer", "succeeded", 940, harnessOutput(9, 0, 0, 940))],
      [342, { kind: "test", tests: tests(9, 0, 0, 940, at(base, 342 * SECOND)) }],
      [350, { kind: "status", text: "Collecting outputs from the sandbox" }],
    ]),
    ...activity(id, "build:docs", base, [
      [365, { kind: "status", text: "Creating a fresh sandbox for `docs`…" }],
    ]),
  ]);

  fixtures.files.set(id, [
    {
      stationId: "build:csv-parser",
      path: "files/src/csv.js",
      contentType: "text/javascript",
      viewable: true,
      versions: [{ version: 1, round: 1, content: CSV_V1, publishedAt: at(base, 176 * SECOND) }],
    },
    {
      stationId: "build:csv-parser",
      path: "files/test/csv.test.js",
      contentType: "text/javascript",
      viewable: true,
      versions: [{ version: 1, round: 1, content: CSV_TEST, publishedAt: at(base, 176 * SECOND) }],
    },
    {
      stationId: "build:csv-parser",
      path: "changes.patch",
      contentType: "text/x-diff",
      viewable: true,
      versions: [
        {
          version: 1,
          round: 1,
          content: newFilePatch([
            { path: "src/csv.js", content: CSV_V1 },
            { path: "test/csv.test.js", content: CSV_TEST },
          ]),
          publishedAt: at(base, 176 * SECOND),
        },
      ],
    },
    {
      stationId: "build:csv-parser",
      path: "test-report.json",
      contentType: "application/json",
      viewable: true,
      versions: [
        {
          version: 1,
          round: 1,
          publishedAt: at(base, 176 * SECOND),
          content: testReport(
            "task",
            "csv-parser",
            "node --test test/csv.test.js",
            at(base, 120 * SECOND),
            [
              { name: "parses a header row and records", file: "test/csv.test.js", status: "passed", durationMs: 2 },
              { name: "keeps commas inside quotes", file: "test/csv.test.js", status: "passed", durationMs: 1 },
              { name: "unescapes doubled quotes", file: "test/csv.test.js", status: "passed", durationMs: 1 },
              {
                name: "handles CRLF line endings",
                file: "test/csv.test.js",
                status: "failed",
                durationMs: 3,
                error:
                  "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n\n  [\n    [\n      'a',\n+     'b\\r'\n-     'b'\n    ],\n\n    at TestContext.<anonymous> (file:///workspace/test/csv.test.js:17:10)",
              },
              {
                name: "keeps newlines inside quoted fields",
                file: "test/csv.test.js",
                status: "failed",
                durationMs: 2,
                error: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ [['note'], ['\"line one'], ['line two\"']]\n- [['note'], ['line one\\r\\nline two']]",
              },
              { name: "infers numbers", file: "test/infer.test.js", status: "passed", durationMs: 1 },
              { name: "infers booleans", file: "test/infer.test.js", status: "passed", durationMs: 1 },
              { name: "maps empty fields to null", file: "test/infer.test.js", status: "passed", durationMs: 1 },
              { name: "keeps leading zeros as strings", file: "test/infer.test.js", status: "passed", durationMs: 1 },
              { name: "supports a custom delimiter", file: "test/csv.test.js", status: "passed", durationMs: 1 },
              { name: "rejects a multi-character delimiter", file: "test/csv.test.js", status: "passed", durationMs: 1 },
              { name: "parses an empty document", file: "test/csv.test.js", status: "passed", durationMs: 1 },
            ],
            harnessOutput(10, 2, 0, 1380, "✖ handles CRLF line endings (3.1ms)\n✖ keeps newlines inside quoted fields (2.4ms)"),
          ),
        },
      ],
    },
    {
      stationId: "build:csv-parser",
      path: "manifest.json",
      contentType: "application/json",
      viewable: true,
      versions: [
        {
          version: 1,
          round: 1,
          publishedAt: at(base, 176 * SECOND),
          content: `${JSON.stringify(
            {
              schema: "factory.manifest/v1",
              mode: "task",
              taskId: "csv-parser",
              generatedAt: at(base, 175 * SECOND),
              files: [
                { path: "src/csv.js", size: CSV_V1.length, sha256: "8d41b0e5c2f7a9136e0b4d2c8f1a7e3b9c5d0f6a2e8b4c1d7f3a9e5b0c6d2f8a", owned: true },
                { path: "test/csv.test.js", size: CSV_TEST.length, sha256: "1c9e7a3f5b2d8e4a0c6f1b7d3e9a5c2f8b4d0e6a1c7f3b9d5e2a8c4f0b6d1e7a", owned: true },
              ],
            },
            null,
            2,
          )}\n`,
        },
      ],
    },
  ]);
}

function semverToolkit(now: number, fixtures: Fixtures): void {
  const id = "wo_semver";
  const base = now - 52 * MINUTE;
  const template = TEMPLATES.find((candidate) => candidate.id === "semver-toolkit");
  const coreReview: ReviewRecord = {
    round: 1,
    verdict: "approve",
    summary: "Precedence rules match semver 2.0.0, including numeric versus alphanumeric prerelease identifiers. Tests cover the spec's ordering example.",
    findings: [{ severity: "minor", file: "src/semver.js", line: 2, message: "Consider exporting the pattern for reuse in validation helpers." }],
    at: at(base, 4 * MINUTE + 10 * SECOND),
  };
  const cliReviews: ReviewRecord[] = [
    {
      round: 1,
      verdict: "request_changes",
      summary: "`semver bump` reads its arguments in the wrong order and the usage text goes to stdout.",
      findings: [
        { severity: "major", file: "bin/semver.js", line: 16, message: "`bump minor 1.2.3` treats `minor` as the version." },
        { severity: "minor", file: "bin/semver.js", line: 7, message: "Print usage errors to stderr." },
      ],
      at: at(base, 5 * MINUTE),
    },
    {
      round: 2,
      verdict: "request_changes",
      summary: "The argument order is fixed. The CLI still accepts `bump <version> <part>` silently; enforce one order.",
      findings: [{ severity: "minor", file: "bin/semver.js", line: 16, message: "Reject `bump 1.2.3 minor` with a usage error." }],
      at: at(base, 7 * MINUTE + 30 * SECOND),
    },
  ];
  const stations: Station[] = [
    station({ id: "plan", kind: "plan", title: "Plan", status: "done", role: "planner", startedAt: at(base, 4 * SECOND), finishedAt: at(base, 41 * SECOND), detail: "Planned 2 tasks" }, 11),
    station({ id: "build:semver-core", kind: "build", title: "Build · Version library", taskId: "semver-core", status: "done", role: "builder", startedAt: at(base, 45 * SECOND), finishedAt: at(base, 3 * MINUTE + 50 * SECOND), detail: "Published 5 files", tests: tests(22, 0, 0, 1210, at(base, 3 * MINUTE + 30 * SECOND)) }, 12),
    station({ id: "review:semver-core", kind: "review", title: "Review · Version library", taskId: "semver-core", status: "done", role: "reviewer", startedAt: at(base, 3 * MINUTE + 55 * SECOND), finishedAt: at(base, 4 * MINUTE + 10 * SECOND), reviews: [coreReview], detail: "Approved in round 1" }, 13),
    station({ id: "build:semver-cli", kind: "build", title: "Build · semver CLI", taskId: "semver-cli", status: "done", role: "builder", round: 2, startedAt: at(base, 46 * SECOND), finishedAt: at(base, 7 * MINUTE + 5 * SECOND), detail: "Published 3 files", tests: tests(12, 0, 1, 1640, at(base, 6 * MINUTE + 50 * SECOND)), previousSessionIds: [sessionId("build:semver-cli", 99)] }, 14),
    station({ id: "review:semver-cli", kind: "review", title: "Review · semver CLI", taskId: "semver-cli", status: "done", role: "reviewer", round: 2, startedAt: at(base, 4 * MINUTE + 40 * SECOND), finishedAt: at(base, 7 * MINUTE + 30 * SECOND), reviews: cliReviews, acceptedWithFindings: true, detail: "Accepted after 2 rounds with 1 open finding" }, 15),
    station({ id: "release", kind: "release", title: "Release", status: "done", role: "release", startedAt: at(base, 7 * MINUTE + 40 * SECOND), finishedAt: at(base, 9 * MINUTE + 55 * SECOND), detail: "Packaged semver-lite 0.1.0", tests: tests(34, 0, 1, 2480, at(base, 9 * MINUTE + 20 * SECOND)) }, 16),
  ];
  const bundleFiles = [
    { path: "README.md", content: SEMVER_README },
    { path: "package.json", content: PACKAGE_JSON },
    { path: "src/semver.js", content: SEMVER },
    { path: "bin/semver.js", content: SEMVER_CLI },
    { path: "test/semver.test.js", content: SEMVER_TEST },
  ];
  const releasePatch = newFilePatch(bundleFiles);
  const workOrder: WorkOrder = {
    id,
    number: 8,
    title: "Semantic version toolkit",
    status: "completed",
    createdAt: at(base, 0),
    updatedAt: at(base, 10 * MINUTE),
    startedAt: at(base, 2 * SECOND),
    completedAt: at(base, 10 * MINUTE),
    taskCount: 2,
    tests: tests(34, 0, 1, 2480, at(base, 9 * MINUTE + 20 * SECOND)),
    brief: template?.brief ?? "Build semver-lite.",
    source: { kind: "template", templateId: "semver-toolkit" },
    maxReviewRounds: 2,
    owner: { login: "mona" },
    plan: {
      summary: "A pure library task and a CLI task that wraps it. The CLI depends on the library's exported API.",
      projectName: "semver-lite",
      packageDescription: "Parse, compare, sort, and bump semantic versions.",
      bin: { semver: "bin/semver.js" },
      integration: "Run the CLI against the spec's ordering example and check `semver compare` exit codes.",
      tasks: [
        {
          id: "semver-core",
          title: "Version library",
          description: "`parse`, `compare`, `sort`, and `bump` following semver 2.0.0.",
          files: ["src/semver.js", "test/semver.test.js"],
          interface: "export function parse(version: string): { major: number; minor: number; patch: number; prerelease: string[]; build: string[] };\nexport function compare(a: string, b: string): -1 | 0 | 1;\nexport function sort(versions: string[]): string[];\nexport function bump(version: string, part: \"major\" | \"minor\" | \"patch\"): string;",
          acceptance: ["Prerelease precedence matches the spec example", "Build metadata is ignored when comparing"],
          dependsOn: [],
        },
        {
          id: "semver-cli",
          title: "semver CLI",
          description: "`semver compare`, `semver sort`, and `semver bump` with one-line errors.",
          files: ["bin/semver.js", "test/cli.test.js"],
          interface: "semver compare <a> <b>\nsemver sort <versions...>\nsemver bump <major|minor|patch> <version>",
          acceptance: ["Invalid input exits with status 1 and a one-line error"],
          dependsOn: ["semver-core"],
        },
      ],
    },
    stations,
    release: {
      files: 7,
      bytes: 14_812,
      tests: tests(34, 0, 1, 2480, at(base, 9 * MINUTE + 20 * SECOND)),
      patchBytes: releasePatch.length,
      notes: SEMVER_RELEASE_NOTES,
    },
  };
  fixtures.workOrders.push(workOrder);

  const releaseReport = testReport(
    "release",
    undefined,
    "node --test",
    at(base, 9 * MINUTE + 10 * SECOND),
    [
      ...["parses prerelease and build metadata", "orders by precedence", "sorts prereleases like the spec", "bumps versions", "rejects leading zeros", "rejects empty identifiers", "compares numeric identifiers numerically", "compares alphanumeric identifiers lexically", "ignores build metadata", "sorts stably", "bumps major resets minor and patch", "bumps minor resets patch", "bump drops prerelease", "parse trims whitespace", "parse rejects v-prefix", "compare is antisymmetric", "compare handles long prereleases", "sort does not mutate input", "parse returns arrays for empty metadata", "compare equal versions", "rejects unknown bump part", "handles 0.x versions"].map(
        (name, index) => ({ name, file: "test/semver.test.js", status: "passed" as const, durationMs: 1 + (index % 4) }),
      ),
      ...["compare prints -1, 0, or 1", "sort prints one version per line", "bump minor", "bump major", "bump patch", "usage error exits 1", "invalid version exits 1", "errors go to stderr", "reads arguments in order", "sort with a single version", "compare with prereleases", "--help prints usage"].map(
        (name, index) => ({ name, file: "test/cli.test.js", status: "passed" as const, durationMs: 38 + index * 3 }),
      ),
      { name: "handles Windows paths in error messages", file: "test/cli.test.js", status: "skipped", durationMs: 0 },
    ],
    harnessOutput(34, 0, 1, 2480),
  );

  fixtures.activity.set(id, [
    ...activity(id, "plan", base, [
      [4, { kind: "status", text: "Session started on `factory-planner`" }],
      [30, { kind: "message", text: "Two tasks: the **library** and the **CLI** that wraps it. The CLI depends on the library's API, so it starts once the library interface is fixed." }],
      [40, { kind: "status", text: "Plan submitted: 2 tasks", level: "success" }],
    ]),
    ...activity(id, "build:semver-core", base, [
      [45, { kind: "status", text: "Sandbox ready (small · 1 vCPU · 2 GiB, restricted network)" }],
      [60, tool("create", "src/semver.js", "succeeded", 130)],
      [75, tool("create", "test/semver.test.js", "succeeded", 90)],
      [210, tool("bash", "node .factory/check.mjs --task semver-core", "succeeded", 1210, harnessOutput(22, 0, 0, 1210))],
      [212, { kind: "test", tests: tests(22, 0, 0, 1210, at(base, 212 * SECOND)) }],
      [228, { kind: "artifact", text: "Published 5 files" }],
    ]),
    ...activity(id, "review:semver-core", base, [
      [236, { kind: "message", text: "Precedence rules match the spec. One **minor** suggestion; approving." }],
      [249, { kind: "review", review: { round: 1, verdict: "approve", findings: 1 }, level: "success" }],
    ]),
    ...activity(id, "build:semver-cli", base, [
      [280, tool("create", "bin/semver.js", "succeeded", 70)],
      [300, tool("bash", "node bin/semver.js bump minor 1.2.3", "failed", 140, "semver: Invalid version: minor", 1)],
      [380, tool("edit", "bin/semver.js", "succeeded", 60)],
      [410, tool("bash", "node .factory/check.mjs --task semver-cli", "succeeded", 1640, harnessOutput(12, 0, 1, 1640))],
      [412, { kind: "test", tests: tests(12, 0, 1, 1640, at(base, 412 * SECOND)) }],
    ]),
    ...activity(id, "review:semver-cli", base, [
      [300, { kind: "review", review: { round: 1, verdict: "request_changes", findings: 2 }, level: "warning" }],
      [450, { kind: "review", review: { round: 2, verdict: "request_changes", findings: 1 }, level: "warning" }],
      [451, { kind: "status", text: "Maximum review rounds reached: accepted with 1 open finding", level: "warning" }],
    ]),
    ...activity(id, "release", base, [
      [460, { kind: "status", text: "Sandbox ready (small · 1 vCPU · 2 GiB, restricted network)" }],
      [462, { kind: "skill", text: "release-checklist" }],
      [470, tool("bash", "npm pack --dry-run", "succeeded", 1900, "npm notice 📦  semver-lite@0.1.0\nnpm notice Tarball Contents\nnpm notice 1.2kB README.md\nnpm notice 2.9kB src/semver.js\nnpm notice total files: 7")],
      [550, tool("bash", "node .factory/check.mjs --release", "succeeded", 2480, harnessOutput(34, 0, 1, 2480))],
      [552, { kind: "test", tests: tests(34, 0, 1, 2480, at(base, 552 * SECOND)) }],
      [580, { kind: "message", text: "Release **semver-lite 0.1.0** is packaged: 7 files, 34 tests passing. Release notes list the one open review finding." }],
      [594, { kind: "artifact", text: "Published the release bundle, patch, and test report" }],
    ]),
  ]);

  const published = at(base, 9 * MINUTE + 50 * SECOND);
  const releaseFiles: FixtureFile[] = bundleFiles.map((file) => ({
    stationId: "release",
    path: `bundle/${file.path}`,
    contentType: file.path.endsWith(".md") ? "text/markdown" : file.path.endsWith(".json") ? "application/json" : "text/javascript",
    viewable: true,
    versions: [{ version: 1, round: 1, content: file.content, publishedAt: published }],
  }));
  fixtures.files.set(id, [
    ...releaseFiles,
    { stationId: "release", path: "RELEASE.md", contentType: "text/markdown", viewable: true, versions: [{ version: 1, round: 1, content: SEMVER_RELEASE_NOTES, publishedAt: published }] },
    { stationId: "release", path: "release.patch", contentType: "text/x-diff", viewable: true, versions: [{ version: 1, round: 1, content: releasePatch, publishedAt: published }] },
    { stationId: "release", path: "test-report.json", contentType: "application/json", viewable: true, versions: [{ version: 1, round: 1, content: releaseReport, publishedAt: published }] },
    { stationId: "release", path: "semver-lite-0.1.0.tgz", contentType: "application/gzip", viewable: false, versions: [{ version: 1, round: 1, content: "", publishedAt: published }] },
    { stationId: "build:semver-core", path: "files/src/semver.js", contentType: "text/javascript", viewable: true, versions: [{ version: 1, round: 1, content: SEMVER, publishedAt: at(base, 228 * SECOND) }] },
    { stationId: "build:semver-core", path: "files/test/semver.test.js", contentType: "text/javascript", viewable: true, versions: [{ version: 1, round: 1, content: SEMVER_TEST, publishedAt: at(base, 228 * SECOND) }] },
    {
      stationId: "build:semver-cli",
      path: "files/bin/semver.js",
      contentType: "text/javascript",
      viewable: true,
      versions: [
        { version: 1, round: 1, content: SEMVER_CLI.replace("bump(args[1], args[0])", "bump(args[0], args[1])"), publishedAt: at(base, 290 * SECOND) },
        { version: 2, round: 2, content: SEMVER_CLI, publishedAt: at(base, 420 * SECOND) },
      ],
    },
  ]);
}

function markdownFormatter(now: number, fixtures: Fixtures): void {
  const id = "wo_mdtable";
  const base = now - 3 * 60 * MINUTE;
  const template = TEMPLATES.find((candidate) => candidate.id === "markdown-table-formatter");
  const stations: Station[] = [
    station({ id: "plan", kind: "plan", title: "Plan", status: "done", role: "planner", startedAt: at(base, 3 * SECOND), finishedAt: at(base, 38 * SECOND) }, 21),
    station({
      id: "build:formatter",
      kind: "build",
      title: "Build · Table formatter",
      taskId: "formatter",
      status: "failed",
      role: "builder",
      round: 2,
      startedAt: at(base, 40 * SECOND),
      finishedAt: at(base, 8 * MINUTE),
      detail: "Tests still failing after 2 rounds",
      tests: tests(14, 3, 0, 1720, at(base, 7 * MINUTE + 40 * SECOND)),
      error: { code: "tests_failed", message: "3 tests still fail after the last allowed round: escaped pipes are unescaped when cells are padded." },
    }, 22),
    station({ id: "review:formatter", kind: "review", title: "Review · Table formatter", taskId: "formatter", status: "skipped", role: "reviewer", detail: "Skipped because the build failed" }, 23),
    station({ id: "build:check-mode", kind: "build", title: "Build · --check mode", taskId: "check-mode", status: "cancelled", role: "builder", startedAt: at(base, 41 * SECOND), finishedAt: at(base, 8 * MINUTE + 2 * SECOND), detail: "Cancelled when the formatter failed" }, 24),
    station({ id: "review:check-mode", kind: "review", title: "Review · --check mode", taskId: "check-mode", status: "skipped", role: "reviewer" }, 25),
    station({ id: "release", kind: "release", title: "Release", status: "skipped", role: "release", detail: "Skipped: not every task was approved" }, 26),
  ];
  fixtures.workOrders.push({
    id,
    number: 7,
    title: "Markdown table formatter",
    status: "failed",
    createdAt: at(base, 0),
    updatedAt: at(base, 8 * MINUTE + 5 * SECOND),
    startedAt: at(base, 2 * SECOND),
    completedAt: at(base, 8 * MINUTE + 5 * SECOND),
    taskCount: 2,
    tests: tests(14, 3, 0, 1720, at(base, 7 * MINUTE + 40 * SECOND)),
    error: { code: "tests_failed", message: "The formatter's tests kept failing after 2 build rounds, so the release was skipped." },
    brief: template?.brief ?? "Build mdtable.",
    source: { kind: "template", templateId: "markdown-table-formatter" },
    maxReviewRounds: 2,
    plan: {
      summary: "A formatter library and the `--check` mode built on it.",
      projectName: "mdtable",
      packageDescription: "Align GitHub-flavored Markdown tables.",
      bin: { mdtable: "bin/mdtable.js" },
      integration: "Format the README itself as a smoke test.",
      tasks: [
        { id: "formatter", title: "Table formatter", description: "Pad cells and honor alignment markers.", files: ["src/format.js"], acceptance: ["Escaped pipes stay escaped"], dependsOn: [] },
        { id: "check-mode", title: "--check mode", description: "List unformatted tables by line number.", files: ["bin/mdtable.js"], acceptance: ["Exits 1 when a table needs formatting"], dependsOn: ["formatter"] },
      ],
    },
    stations,
  });
  fixtures.activity.set(id, [
    ...activity(id, "build:formatter", base, [
      [40, { kind: "status", text: "Sandbox ready" }],
      [300, tool("bash", "node .factory/check.mjs --task formatter", "failed", 1720, harnessOutput(14, 3, 0, 1720, "✖ keeps escaped pipes\n✖ pads cells with escaped pipes\n✖ round-trips a table with code spans"), 1)],
      [302, { kind: "test", tests: tests(14, 3, 0, 1720, at(base, 302 * SECOND)) }],
      [470, { kind: "error", text: "Tests still fail after the last allowed round (`tests_failed`)." }],
    ]),
  ]);
}

function csvCli(now: number, fixtures: Fixtures): void {
  const id = "wo_csv2json";
  const base = now - 26 * 60 * MINUTE;
  const template = TEMPLATES.find((candidate) => candidate.id === "csv-to-json-cli");
  fixtures.workOrders.push({
    id,
    number: 6,
    title: "CSV → JSON CLI",
    status: "cancelled",
    createdAt: at(base, 0),
    updatedAt: at(base, 2 * MINUTE),
    startedAt: at(base, 2 * SECOND),
    completedAt: at(base, 2 * MINUTE),
    taskCount: 1,
    brief: template?.brief ?? "Build csv2json.",
    source: { kind: "template", templateId: "csv-to-json-cli" },
    maxReviewRounds: 1,
    plan: {
      summary: "A single task: the parser and the CLI together.",
      projectName: "csv2json",
      packageDescription: "Convert CSV to JSON.",
      bin: { csv2json: "bin/csv2json.js" },
      integration: "Run the CLI on a sample file.",
      tasks: [{ id: "cli", title: "CSV to JSON CLI", description: "Parser and CLI.", files: ["src/csv.js", "bin/csv2json.js"], acceptance: ["`--pretty` works"], dependsOn: [] }],
    },
    stations: [
      station({ id: "plan", kind: "plan", title: "Plan", status: "done", role: "planner", startedAt: at(base, 3 * SECOND), finishedAt: at(base, 30 * SECOND) }, 31),
      station({ id: "build:cli", kind: "build", title: "Build · CSV to JSON CLI", taskId: "cli", status: "cancelled", role: "builder", startedAt: at(base, 33 * SECOND), finishedAt: at(base, 2 * MINUTE), detail: "Cancelled by mona", sessionState: "deleted" }, 32),
      station({ id: "review:cli", kind: "review", title: "Review · CSV to JSON CLI", taskId: "cli", status: "skipped", role: "reviewer" }, 33),
      station({ id: "release", kind: "release", title: "Release", status: "skipped", role: "release" }, 34),
    ],
  });
}

function planning(now: number, fixtures: Fixtures): void {
  const id = "wo_logsum";
  const base = now - 40 * SECOND;
  fixtures.workOrders.push({
    id,
    number: 10,
    title: "Log line summarizer",
    status: "planning",
    createdAt: at(base, 0),
    updatedAt: at(now, -1 * SECOND),
    startedAt: at(base, 1 * SECOND),
    taskCount: 0,
    brief:
      "Build `logsum`, a zero-dependency Node.js 24 CLI that reads newline-delimited JSON logs from stdin and prints a summary: counts by level, the top 5 messages, and the time range covered.\n\n- `--since <iso>` filters older lines.\n- Invalid JSON lines are counted and skipped.\n\nTest with node:test.",
    source: { kind: "brief" },
    maxReviewRounds: 3,
    stations: [
      station({ id: "plan", kind: "plan", title: "Plan", status: "working", role: "planner", startedAt: at(base, 3 * SECOND), detail: "Splitting the work order into tasks" }, 41),
    ],
  });
  fixtures.activity.set(id, activity(id, "plan", base, [
    [3, { kind: "status", text: "Session started on `factory-planner` (shared, network off)" }],
    [5, { kind: "skill", text: "task-decomposition" }],
    [8, { kind: "intent", text: "Reading the brief and sizing the tasks" }],
  ]));
}

function queued(now: number, fixtures: Fixtures): void {
  fixtures.workOrders.push({
    id: "wo_queued",
    number: 11,
    title: "HTTP status code lookup",
    status: "queued",
    createdAt: at(now, -6 * SECOND),
    updatedAt: at(now, -6 * SECOND),
    taskCount: 0,
    brief: "Build `httpstatus`, a CLI that prints the name and description of an HTTP status code.",
    source: { kind: "brief" },
    maxReviewRounds: 2,
    stations: [],
  });
}

/** Decorates only explicitly agent-led fixture records; never loaded by production. */
export function withPreviewCoordinator(workOrder: WorkOrder): WorkOrder {
  if (workOrder.mode !== "agent") return workOrder;
  const planned = Boolean(workOrder.plan);
  const status = !planned ? "waiting" : workOrder.status === "completed" ? "done" : workOrder.status === "cancelled" ? "cancelled" : workOrder.status === "failed" ? "failed" : "working";
  const coordinator: Station = {
    id: "coordinator", kind: "coordinate", title: "Coordinator", role: "coordinator",
    environment: "factory-coordinator", placement: "shared", agent: "coordinator", model: environmentFor("coordinator").model,
    status, round: planned ? 1 : 0, detail: planned ? "Waiting for the workers · no model time" : "Waits for the accepted plan",
    ...(planned ? { sessionId: `fixture_coordinator_${workOrder.id}`, startedAt: workOrder.startedAt } : {}),
  };
  const stations = workOrder.stations.filter((item) => item.kind !== "coordinate").map((item): Station => {
    if ((item.kind !== "build" && item.kind !== "release") || !item.sessionId) return item;
    return {
      ...item,
      worker: {
        id: item.sessionId, name: item.kind === "release" ? "release" : `builder-${item.taskId}`, createdRound: 1,
        messages: Math.max(item.round + 1, 2),
        state: item.status === "starting" ? "starting" : item.status === "working" ? "working" : item.status === "failed" ? "failed" : item.status === "cancelled" ? "stopped" : "idle",
      },
    };
  });
  return {
    ...workOrder, workersStarted: stations.filter((item) => item.worker).length,
    stations: [...stations.filter((item) => item.kind === "plan"), coordinator, ...stations.filter((item) => item.kind !== "plan")],
  };
}

function agentLedFixture(fixtures: Fixtures, now: number): void {
  const index = fixtures.workOrders.findIndex((item) => item.id === "wo_csvjson");
  const original = fixtures.workOrders[index];
  if (!original) return;
  const order = withPreviewCoordinator({ ...original, mode: "agent" });
  fixtures.workOrders[index] = order;
  const decisions: ActivityItem[] = order.stations.flatMap((item) => item.worker ? [{
    id: `decision:create:${item.id}`, workOrderId: order.id, stationId: "coordinator", kind: "decision" as const,
    at: item.startedAt ?? order.createdAt, text: `Created **${item.worker.name}** in ${item.environment}, agent ${item.agent}`,
    decision: { action: "create" as const, status: "done" as const, workers: [item.worker.name], tag: "new" as const },
  }] : []);
  for (const item of order.stations.filter((candidate) => candidate.worker && candidate.round > 1)) {
    decisions.push({
      id: `decision:review:${item.id}`, workOrderId: order.id, stationId: "coordinator", kind: "decision",
      at: at(now, -70 * SECOND), text: `Factory review requested changes to **${item.worker!.name}** on a second model`,
      decision: { action: "review", status: "done", workers: [item.worker!.name] },
    }, {
      id: `decision:reuse:${item.id}`, workOrderId: order.id, stationId: "coordinator", kind: "decision",
      at: at(now, -40 * SECOND), text: `Sent the findings to the same **${item.worker!.name}** sandbox`,
      decision: { action: "message", status: "done", workers: [item.worker!.name], tag: "reused" },
    });
  }
  fixtures.activity.set(order.id, [...(fixtures.activity.get(order.id) ?? []), ...decisions]);
}

export function createFixtures(now: number, variant: string): Fixtures {
  const state: PlatformStatus["state"] =
    variant === "platform-down" ? "unavailable" : variant === "misconfigured" ? "misconfigured" : variant === "connecting" ? "connecting" : "connected";
  const fixtures: Fixtures = { platform: platformFixture(state, now), workOrders: [], activity: new Map(), files: new Map() };
  if (variant === "empty") return fixtures;
  queued(now, fixtures);
  planning(now, fixtures);
  csvToolkit(now, fixtures);
  semverToolkit(now, fixtures);
  markdownFormatter(now, fixtures);
  csvCli(now, fixtures);
  agentLedFixture(fixtures, now);
  return fixtures;
}

export const PREVIEW_FILE_CONTENTS = { CSV_V2, CSV_PATCH_V2, CSV_TEST };
