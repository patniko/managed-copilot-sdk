/**
 * Reads pass and fail counts, and the failing tests' names, from the output of common test runners: node:test, Jest,
 * Vitest, Mocha, pytest, unittest, Go, Cargo, and TAP. What it can't read stays undefined; the exit code still decides
 * whether a run passed.
 */

export interface TestCounts {
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly total?: number;
  readonly failures: readonly string[];
}

const MAX_FAILURES = 20;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

type Counts = Omit<TestCounts, "failures">;

interface Format {
  counts(text: string): Counts | undefined;
  failures(text: string): string[];
}

const num = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));

/** "2 failed, 4 passed" style pairs anywhere in `line`, summed per word. */
function pairs(line: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of line.matchAll(/(\d+) ([a-z]+)/gi)) found[match[2]!.toLowerCase()] = (found[match[2]!.toLowerCase()] ?? 0) + Number(match[1]);
  return found;
}

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...text.matchAll(pattern)].at(-1);
}

function captures(text: string, pattern: RegExp, clean: (name: string) => string = (name) => name.trim()): string[] {
  return [...text.matchAll(pattern)].map((match) => clean(match[1]!)).filter(Boolean);
}

/** node --test: spec (`ℹ pass 4`) or TAP (`# pass 4`) summaries. */
const nodeTest: Format = {
  counts(text) {
    const value = (word: string) => num(lastMatch(text, new RegExp(`^[ℹ#] ${word} (\\d+)\\s*$`, "gm"))?.[1]);
    const total = value("tests");
    if (total === undefined) return undefined;
    const pass = value("pass");
    const fail = value("fail");
    if (pass === undefined || fail === undefined) return undefined;
    return { total, passed: pass, failed: fail + (value("cancelled") ?? 0), skipped: (value("skipped") ?? 0) + (value("todo") ?? 0) };
  },
  failures(text) {
    const spec = captures(text, /^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/gm).filter((name) => name !== "failing tests:");
    return spec.length ? spec : tap.failures(text);
  },
};

/** Jest: `Tests:       2 failed, 4 passed, 6 total`. */
const jest: Format = {
  counts(text) {
    const line = lastMatch(text, /^Tests:\s+(.*\d+ total.*)$/gm)?.[1];
    if (!line) return undefined;
    const found = pairs(line);
    return { passed: found.passed ?? 0, failed: found.failed ?? 0, skipped: (found.skipped ?? 0) + (found.todo ?? 0), total: found.total };
  },
  failures: (text) => captures(text, /^\s*● (?!Console\b)(.+?)\s*$/gm),
};

/** Vitest: ` Tests  2 failed | 4 passed (6)`. */
const vitest: Format = {
  counts(text) {
    const match = lastMatch(text, /^\s*Tests\s+(.*\d+ (?:passed|failed).*?)\s*\((\d+)\)\s*$/gm);
    if (!match) return undefined;
    const found = pairs(match[1]!);
    return { passed: found.passed ?? 0, failed: found.failed ?? 0, skipped: (found.skipped ?? 0) + (found.todo ?? 0), total: Number(match[2]) };
  },
  failures: (text) => captures(text, /^\s*(?:FAIL|×)\s+(.+?)(?:\s+\d+m?s)?\s*$/gm),
};

/** pytest: `==== 2 failed, 4 passed in 0.12s ====`. */
const pytest: Format = {
  counts(text) {
    const line = lastMatch(text, /^=+ (.*\d+ (?:passed|failed|errors?|skipped).*) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm)?.[1];
    if (!line) return undefined;
    const found = pairs(line);
    const failed = (found.failed ?? 0) + (found.error ?? 0) + (found.errors ?? 0);
    const passed = found.passed ?? 0;
    const skipped = (found.skipped ?? 0) + (found.xfailed ?? 0) + (found.deselected ?? 0);
    return { passed, failed, skipped, total: passed + failed + skipped + (found.xpassed ?? 0) };
  },
  failures: (text) => captures(text, /^(?:FAILED|ERROR) (\S+)/gm),
};

/** unittest: `Ran 6 tests in 0.002s` then `FAILED (failures=2)` or `OK`. */
const unittest: Format = {
  counts(text) {
    const ran = num(lastMatch(text, /^Ran (\d+) tests? in [\d.]+s\s*$/gm)?.[1]);
    if (ran === undefined) return undefined;
    const outcome = lastMatch(text, /^(OK|FAILED)(?: \((.*)\))?\s*$/gm);
    const found: Record<string, number> = {};
    for (const part of (outcome?.[2] ?? "").split(",")) {
      const [key, value] = part.split("=").map((piece) => piece.trim());
      if (key && value) found[key] = Number(value);
    }
    const failed = (found.failures ?? 0) + (found.errors ?? 0);
    const skipped = found.skipped ?? 0;
    return { total: ran, failed, skipped, passed: Math.max(0, ran - failed - skipped) };
  },
  failures: (text) => captures(text, /^(?:FAIL|ERROR): (.+?)\s*$/gm),
};

/** Mocha: `4 passing (12ms)` and `2 failing`. */
const mocha: Format = {
  counts(text) {
    const passing = num(lastMatch(text, /^\s*(\d+) passing\b/gm)?.[1]);
    if (passing === undefined) return undefined;
    const failing = num(lastMatch(text, /^\s*(\d+) failing\s*$/gm)?.[1]) ?? 0;
    const pending = num(lastMatch(text, /^\s*(\d+) pending\s*$/gm)?.[1]) ?? 0;
    return { passed: passing, failed: failing, skipped: pending, total: passing + failing + pending };
  },
  failures: (text) => captures(text, /^\s{2}\d+\) (.+?):?\s*$/gm),
};

/** Cargo: `test result: FAILED. 4 passed; 2 failed; 0 ignored`, once per test binary. */
const cargo: Format = {
  counts(text) {
    const results = [...text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
    if (results.length === 0) return undefined;
    const sum = (index: number) => results.reduce((total, match) => total + Number(match[index]), 0);
    return { passed: sum(1), failed: sum(2), skipped: sum(3), total: sum(1) + sum(2) + sum(3) };
  },
  failures: (text) => captures(text, /^test (\S+) \.\.\. FAILED\s*$/gm),
};

/** go test: `--- FAIL: TestName` lines (with -v, `--- PASS:` too). */
const goTest: Format = {
  counts(text) {
    const failed = [...text.matchAll(/^\s*--- FAIL: /gm)].length;
    const passed = [...text.matchAll(/^\s*--- PASS: /gm)].length;
    const skipped = [...text.matchAll(/^\s*--- SKIP: /gm)].length;
    if (failed + passed + skipped === 0) return undefined;
    return { passed, failed, skipped, total: passed + failed + skipped };
  },
  failures: (text) => captures(text, /^\s*--- FAIL: (\S+)/gm),
};

/** TAP: `# pass 4`, `# fail 2`, and `not ok 3 - name`. */
const tap: Format = {
  counts(text) {
    const pass = num(lastMatch(text, /^# pass (\d+)\s*$/gm)?.[1]);
    const fail = num(lastMatch(text, /^# fail (\d+)\s*$/gm)?.[1]);
    if (pass === undefined && fail === undefined) return undefined;
    const total = num(lastMatch(text, /^# tests (\d+)\s*$/gm)?.[1]);
    return { passed: pass ?? 0, failed: fail ?? 0, ...(total !== undefined ? { total } : {}) };
  },
  failures: (text) => captures(text, /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/gm),
};

const FORMATS: readonly Format[] = [nodeTest, jest, vitest, pytest, unittest, mocha, cargo, goTest, tap];

export function parseTestOutput(raw: string): TestCounts {
  const text = stripAnsi(raw).replace(/\r\n?/g, "\n");
  for (const format of FORMATS) {
    const counts = format.counts(text);
    if (!counts) continue;
    const failures = [...new Set(format.failures(text))].slice(0, MAX_FAILURES);
    return { ...counts, failures };
  }
  return { failures: [] };
}
