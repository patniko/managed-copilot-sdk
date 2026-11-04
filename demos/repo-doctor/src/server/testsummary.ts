/**
 * Reads pass and fail counts, and the failing tests' names, from the output of common test runners: node:test, Jest,
 * Vitest, Mocha, pytest, unittest, Go, Cargo, and TAP. What it can't read stays undefined; the exit code still decides
 * whether a run passed.
 *
 * The output comes from the repository under test, so reading it must take time linear in its length: only its end is
 * read, one line at a time, with patterns that have one way to match (no `\s` across lines, no rescanned runs).
 */

export interface TestCounts {
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly total?: number;
  readonly failures: readonly string[];
}

const MAX_FAILURES = 20;
/** Runners print their summaries last, so only the end of the output is read. */
const READ_CHARS = 64 * 1024;
/** Characters of each line that are matched: summaries and test names fit. */
const LINE_CHARS = 1_000;

// Color and cursor codes (`ESC [`), and terminal commands such as links (`ESC ]`, ended by BEL or `ESC \`).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The end of a command's output as people read it: without color codes or trailing whitespace. */
export function outputEnd(output: string): string {
  return stripAnsi(output.length > READ_CHARS ? output.slice(-READ_CHARS) : output).trimEnd();
}

type Counts = Omit<TestCounts, "failures">;

interface Format {
  counts(lines: readonly string[]): Counts | undefined;
  failures(lines: readonly string[]): string[];
}

const num = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));

/** "2 failed, 4 passed" style pairs in `text`, summed per word. */
function pairs(text: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of text.matchAll(/(?<!\d)(\d+) ([a-z]+)/gi)) found[match[2]!.toLowerCase()] = (found[match[2]!.toLowerCase()] ?? 0) + Number(match[1]);
  return found;
}

/** Whether `text` counts one of `words`, as in "2 failed". */
function hasCount(text: string, words: readonly string[]): boolean {
  const found = pairs(text);
  return words.some((word) => found[word] !== undefined);
}

/** The last line `pattern` matches (and `accept` takes). */
function lastMatch(lines: readonly string[], pattern: RegExp, accept: (match: RegExpExecArray) => boolean = () => true): RegExpExecArray | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = pattern.exec(lines[index]!);
    if (match && accept(match)) return match;
  }
  return undefined;
}

function allMatches(lines: readonly string[], pattern: RegExp): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) found.push(match);
  }
  return found;
}

/** The first capture of every line `pattern` matches, as a test name. */
function names(lines: readonly string[], pattern: RegExp, clean: (name: string) => string = (name) => name): string[] {
  return allMatches(lines, pattern)
    .map((match) => clean(match[1]!).trim())
    .filter(Boolean);
}

/** node --test: spec (`ℹ pass 4`) or TAP (`# pass 4`) summaries. */
const nodeTest: Format = {
  counts(lines) {
    const summary: Record<string, number> = {};
    for (const match of allMatches(lines, /^[ℹ#] (tests|pass|fail|cancelled|skipped|todo) (\d+)$/)) summary[match[1]!] = Number(match[2]);
    const { tests: total, pass, fail } = summary;
    if (total === undefined || pass === undefined || fail === undefined) return undefined;
    return { total, passed: pass, failed: fail + (summary.cancelled ?? 0), skipped: (summary.skipped ?? 0) + (summary.todo ?? 0) };
  },
  failures(lines) {
    // `✖ name (1.2ms)`, and the spec reporter's closing list of them.
    const spec = names(lines, /^[ \t]*✖ (.+)$/, (name) => name.replace(/ \([\d.]+m?s\)$/, "")).filter((name) => name !== "failing tests:");
    return spec.length ? spec : tap.failures(lines);
  },
};

/** Jest: `Tests:       2 failed, 4 passed, 6 total`. */
const jest: Format = {
  counts(lines) {
    const line = lastMatch(lines, /^Tests:[ \t]+(\S.*)$/, (match) => hasCount(match[1]!, ["total"]))?.[1];
    if (line === undefined) return undefined;
    const found = pairs(line);
    return { passed: found.passed ?? 0, failed: found.failed ?? 0, skipped: (found.skipped ?? 0) + (found.todo ?? 0), total: found.total };
  },
  failures: (lines) => names(lines, /^[ \t]*● (?!Console\b)(.+)$/),
};

/** Vitest: ` Tests  2 failed | 4 passed (6)`. */
const vitest: Format = {
  counts(lines) {
    const match = lastMatch(lines, /^[ \t]*Tests[ \t]+(\S.*)\((\d+)\)$/, (found) => hasCount(found[1]!, ["passed", "failed"]));
    if (!match) return undefined;
    const found = pairs(match[1]!);
    return { passed: found.passed ?? 0, failed: found.failed ?? 0, skipped: (found.skipped ?? 0) + (found.todo ?? 0), total: Number(match[2]) };
  },
  // ` × suite > name 3ms` and ` FAIL  file > suite > name`.
  failures: (lines) => names(lines, /^[ \t]*(?:FAIL|×)[ \t]+(\S.*)$/, (name) => name.replace(/[ \t]\d+m?s$/, "")),
};

/** pytest: `==== 2 failed, 4 passed in 0.12s ====`. */
const pytest: Format = {
  counts(lines) {
    const line = lastMatch(lines, /^=+ (\S.*) in [\d.]+s(?: \([^()]*\))? =+$/, (match) => hasCount(match[1]!, ["passed", "failed", "error", "errors", "skipped"]))?.[1];
    if (line === undefined) return undefined;
    const found = pairs(line);
    const failed = (found.failed ?? 0) + (found.error ?? 0) + (found.errors ?? 0);
    const passed = found.passed ?? 0;
    const skipped = (found.skipped ?? 0) + (found.xfailed ?? 0) + (found.deselected ?? 0);
    return { passed, failed, skipped, total: passed + failed + skipped + (found.xpassed ?? 0) };
  },
  failures: (lines) => names(lines, /^(?:FAILED|ERROR) (\S+)/),
};

/** unittest: `Ran 6 tests in 0.002s` then `FAILED (failures=2)` or `OK`. */
const unittest: Format = {
  counts(lines) {
    const ran = num(lastMatch(lines, /^Ran (\d+) tests? in [\d.]+s$/)?.[1]);
    if (ran === undefined) return undefined;
    const outcome = lastMatch(lines, /^(OK|FAILED)(?: \((.*)\))?$/);
    const found: Record<string, number> = {};
    for (const part of (outcome?.[2] ?? "").split(",")) {
      const [key, value] = part.split("=").map((piece) => piece.trim());
      if (key && value) found[key] = Number(value);
    }
    const failed = (found.failures ?? 0) + (found.errors ?? 0);
    const skipped = found.skipped ?? 0;
    return { total: ran, failed, skipped, passed: Math.max(0, ran - failed - skipped) };
  },
  failures: (lines) => names(lines, /^(?:FAIL|ERROR): (.+)$/),
};

/** Mocha: `4 passing (12ms)` and `2 failing`. */
const mocha: Format = {
  counts(lines) {
    const passing = num(lastMatch(lines, /^[ \t]*(\d+) passing\b/)?.[1]);
    if (passing === undefined) return undefined;
    const failing = num(lastMatch(lines, /^[ \t]*(\d+) failing$/)?.[1]) ?? 0;
    const pending = num(lastMatch(lines, /^[ \t]*(\d+) pending$/)?.[1]) ?? 0;
    return { passed: passing, failed: failing, skipped: pending, total: passing + failing + pending };
  },
  // `  1) suite name:`
  failures: (lines) => names(lines, /^[ \t]{2}\d+\) (.+)$/, (name) => name.replace(/:$/, "")),
};

/** Cargo: `test result: FAILED. 4 passed; 2 failed; 0 ignored`, once per test binary. */
const cargo: Format = {
  counts(lines) {
    const results = allMatches(lines, /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
    if (results.length === 0) return undefined;
    const sum = (index: number) => results.reduce((total, match) => total + Number(match[index]), 0);
    return { passed: sum(1), failed: sum(2), skipped: sum(3), total: sum(1) + sum(2) + sum(3) };
  },
  failures: (lines) => names(lines, /^test (\S+) \.\.\. FAILED$/),
};

/** go test: `--- FAIL: TestName` lines (with -v, `--- PASS:` too). */
const goTest: Format = {
  counts(lines) {
    const results = allMatches(lines, /^[ \t]*--- (FAIL|PASS|SKIP): /).map((match) => match[1]);
    const count = (result: string) => results.filter((found) => found === result).length;
    const [failed, passed, skipped] = [count("FAIL"), count("PASS"), count("SKIP")];
    if (failed + passed + skipped === 0) return undefined;
    return { passed, failed, skipped, total: passed + failed + skipped };
  },
  failures: (lines) => names(lines, /^[ \t]*--- FAIL: (\S+)/),
};

/** TAP: `# pass 4`, `# fail 2`, and `not ok 3 - name`. */
const tap: Format = {
  counts(lines) {
    const pass = num(lastMatch(lines, /^# pass (\d+)$/)?.[1]);
    const fail = num(lastMatch(lines, /^# fail (\d+)$/)?.[1]);
    if (pass === undefined && fail === undefined) return undefined;
    const total = num(lastMatch(lines, /^# tests (\d+)$/)?.[1]);
    return { passed: pass ?? 0, failed: fail ?? 0, ...(total !== undefined ? { total } : {}) };
  },
  // `not ok 3 - name # time=1.2ms` or `# TODO later`: the name ends where its comment or directive starts.
  failures: (lines) =>
    names(lines, /^[ \t]*not ok \d+ - (.+)$/, (name) => {
      const directive = name.search(/[ \t]#/);
      return directive >= 0 ? name.slice(0, directive) : name;
    }),
};

const FORMATS: readonly Format[] = [nodeTest, jest, vitest, pytest, unittest, mocha, cargo, goTest, tap];

export function parseTestOutput(output: string): TestCounts {
  const lines = outputEnd(output)
    .split(/\r\n|\r|\n/)
    .map((line) => (line.length > LINE_CHARS ? line.slice(0, LINE_CHARS) : line).trimEnd())
    .filter(Boolean);
  for (const format of FORMATS) {
    const found = format.counts(lines);
    if (!found) continue;
    const failures = [...new Set(format.failures(lines))].slice(0, MAX_FAILURES);
    return { ...found, failures };
  }
  return { failures: [] };
}
