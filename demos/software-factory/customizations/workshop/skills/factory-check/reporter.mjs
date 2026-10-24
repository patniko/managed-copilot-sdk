// Node test runner reporter for the factory-check harness. It collects every test (suites excluded) and yields one
// JSON document, {"tests":[...]}, that check.mjs turns into outputs/test-report.json.
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ERROR = 2000;
const MAX_LOG = 8192;

export default async function* factoryReporter(source) {
  const tests = [];
  const logs = new Map(); // test file → its stderr and diagnostics, used to explain files that crash
  const crashed = [];
  for await (const event of source) {
    try {
      const data = event?.data;
      if (!data || typeof data !== "object") continue;
      if (event.type === "test:stderr" || (event.type === "test:diagnostic" && data.file)) {
        const file = absolute(data.file);
        const text = `${data.message ?? ""}${event.type === "test:diagnostic" ? "\n" : ""}`;
        if (file) logs.set(file, ((logs.get(file) ?? "") + text).slice(-MAX_LOG));
      } else if ((event.type === "test:pass" || event.type === "test:fail") && data.details?.type !== "suite") {
        // Node reports a file that fails to load (or exits with an error) as one top-level test named after the file.
        // It also reports a file that defines no tests as a passing test; that is not a real test, so it is dropped.
        const file = absolute(data.file);
        const fileLevel = file !== undefined && data.nesting === 0 && absolute(data.name) === file;
        if (fileLevel && event.type === "test:pass") continue;
        const test = toTest(event.type, data, fileLevel);
        tests.push(test);
        if (fileLevel && test.status === "failed") crashed.push({ test, file });
      }
    } catch {
      // An unexpected event shape must never break the run.
    }
  }
  for (const { test, file } of crashed) {
    const log = clean(logs.get(file) ?? "");
    const room = MAX_ERROR - test.error.length - 1;
    if (log && room > 1) test.error += `\n${log.length > room ? `…${log.slice(-(room - 1))}` : log}`;
  }
  yield `${JSON.stringify({ tests })}\n`;
}

function toTest(type, data, fileLevel) {
  const file = relative(data.file);
  const status = data.skip || data.todo ? "skipped" : type === "test:pass" ? "passed" : "failed";
  const test = { name: fileLevel && file ? file : String(data.name ?? "(unnamed test)"), file, status };
  const duration = Number(data.details?.duration_ms);
  if (Number.isFinite(duration)) test.durationMs = Math.round(duration * 1000) / 1000;
  if (status === "failed") test.error = errorText(data.details?.error);
  return test;
}

function errorText(error) {
  const cause = error?.cause;
  let text = [cause?.message, error?.message, cause].find((value) => typeof value === "string" && value.trim());
  text ??= "Test failed";
  if (Number.isInteger(error?.exitCode)) text += ` (exit code ${error.exitCode})`;
  else if (typeof error?.signal === "string") text += ` (${error.signal})`;
  return truncate(text);
}

// Keeps a crashed file's stderr readable: drops Node-internal source snippets and stack frames (keeping the brace
// that opens an error's property block) and the trailing "Node.js vX" banner.
function clean(log) {
  return log
    .replace(/^node:\S+:\d+\n[\s\S]*?\n\n/gm, "")
    .split(/\r?\n/)
    .flatMap((line) => (/^\s*at (?:.*\()?node:/.test(line) ? (line.endsWith(" {") ? ["{"] : []) : [line]))
    .filter((line) => !/^Node\.js v\d/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text) {
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
}

function absolute(file) {
  if (typeof file !== "string" || !file) return undefined;
  try {
    return file.startsWith("file:") ? fileURLToPath(file) : path.resolve(file);
  } catch {
    return undefined;
  }
}

function relative(file) {
  const abs = absolute(file);
  if (!abs) return undefined;
  const rel = path.relative(process.cwd(), abs);
  const inside = rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
  return (inside ? rel : abs).split(path.sep).join("/");
}
