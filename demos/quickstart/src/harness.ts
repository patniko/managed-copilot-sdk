/**
 * A small acceptance harness for the spec snippets. Each snippet file keeps the spec's code as written, then adds
 * acceptance checks. Outcomes: pass, fail, unavailable (the platform reported `capability_unavailable` because the
 * feature has not landed), or skipped (a local prerequisite is missing). Nothing is faked: snippets run against your
 * real platform with real models.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { ManagedCopilot } from "@managed-copilot/sdk";

export type Outcome = "pass" | "fail" | "unavailable" | "skipped";

export interface SnippetContext {
  /** Records an acceptance check; a false condition fails the snippet. */
  check(condition: unknown, description: string): void;
  /** Ends the snippet as skipped: a missing local prerequisite, not a platform failure. */
  skip(reason: string): never;
  /** Runs after the snippet, whether it passed or failed. */
  cleanup(task: () => unknown): void;
  /** True when running in an interactive terminal. */
  readonly interactive: boolean;
}

export interface Snippet {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly timeoutMs: number;
  /** Capabilities the deployment must advertise in `/v1/info`; missing ones report "not available yet". */
  readonly requires: readonly string[];
  readonly run: (t: SnippetContext) => Promise<void>;
}

export interface SnippetResult {
  readonly snippet: Snippet;
  readonly outcome: Outcome;
  readonly detail?: string;
  readonly durationMs: number;
  readonly checks: number;
}

class CheckFailed extends Error {}
class Skipped extends Error {}

class Unavailable extends Error {
  readonly code = "capability_unavailable";
}

/** Fails fast with "not available yet" when the deployment does not advertise what a snippet needs. */
async function checkCapabilities(needed: readonly string[]): Promise<void> {
  if (needed.length === 0) return;
  const managed = await ManagedCopilot.connect();
  try {
    const missing = needed.filter((capability) => !managed.info.capabilities.includes(capability));
    if (missing.length > 0) throw new Unavailable(`This deployment does not offer ${missing.join(", ")} yet`);
  } finally {
    await managed.close();
  }
}

const env = process.env;
const color = env.NO_COLOR === undefined && (Boolean(env.FORCE_COLOR && env.FORCE_COLOR !== "0") || Boolean(process.stdout.isTTY));
const unicode = process.platform !== "win32" || Boolean(env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.ConEmuTask || env.TERM === "xterm-256color");
const paint = (code: number) => (text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
export const style = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };
export const symbols = unicode
  ? { pass: "✔", fail: "✖", unavailable: "◌", skipped: "↷", run: "▶", bar: "│" }
  : { pass: "√", fail: "×", unavailable: "o", skipped: "~", run: ">", bar: "|" };

const OUTCOME_STYLE: Record<Outcome, (text: string) => string> = { pass: style.green, fail: style.red, unavailable: style.yellow, skipped: style.dim };
const OUTCOME_LABEL: Record<Outcome, string> = { pass: "PASS", fail: "FAIL", unavailable: "UNAVAILABLE", skipped: "SKIPPED" };

/** The stable error code of a platform error, whether it came from REST (`code`) or JSON-RPC (`data.code`, `[code]`). */
export function stableCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; data?: { code?: unknown }; message?: unknown };
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.data?.code === "string") return candidate.data.code;
  const match = /\[([a-z_]+)\]\s*$/.exec(String(candidate?.message ?? ""));
  return match?.[1];
}

/** A feature that has not landed on this deployment yet, as opposed to a failure of one that has. */
export function isUnavailable(error: unknown): boolean {
  const code = stableCode(error);
  const message = String((error as { message?: unknown })?.message ?? "");
  return code === "capability_unavailable" || (code === "not_found" && /^No route for /.test(message)) || /not available in this build/.test(message);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Indents everything the snippet prints, and caps it so the acceptance log stays readable. */
function captureOutput(maxLines: number): () => void {
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const error = console.error;
  let lines = 0;
  let atLineStart = true;
  let truncated = false;
  const emit = (text: string) => {
    for (const piece of text.split(/(\n)/)) {
      if (piece === "") continue;
      if (lines >= maxLines) {
        truncated = true;
        continue;
      }
      if (piece === "\n") {
        write("\n");
        lines++;
        atLineStart = true;
        continue;
      }
      write(`${atLineStart ? `  ${style.dim(symbols.bar)} ` : ""}${piece}`);
      atLineStart = false;
    }
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    emit(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => emit(`${format(...args)}\n`);
  console.error = (...args: unknown[]) => emit(`${format(...args)}\n`);
  return () => {
    if (!atLineStart) write("\n");
    if (truncated) write(`  ${style.dim(`${symbols.bar} … output truncated`)}\n`);
    process.stdout.write = write as typeof process.stdout.write;
    console.log = log;
    console.error = error;
  };
}

export async function runSnippet(snippet: Snippet, options: { readonly maxOutputLines?: number } = {}): Promise<SnippetResult> {
  const started = performance.now();
  const cleanups: (() => unknown)[] = [];
  let checks = 0;
  const context: SnippetContext = {
    check(condition, description) {
      checks++;
      if (!condition) throw new CheckFailed(description);
      process.stdout.write(`${style.green(symbols.pass)} ${description}\n`);
    },
    skip(reason) {
      throw new Skipped(reason);
    },
    cleanup(task) {
      cleanups.push(task);
    },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };

  console.log(`\n${style.cyan(symbols.run)} ${style.bold(`${snippet.id}  ${snippet.title}`)} ${style.dim(`· ${snippet.section}`)}`);
  const restore = captureOutput(options.maxOutputLines ?? 40);
  let outcome: Outcome = "pass";
  let detail: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CheckFailed(`timed out after ${seconds(snippet.timeoutMs)}`)), snippet.timeoutMs);
    });
    await Promise.race([checkCapabilities(snippet.requires).then(() => snippet.run(context)), timeout]);
  } catch (error) {
    if (error instanceof Skipped) {
      outcome = "skipped";
      detail = error.message;
    } else if (isUnavailable(error)) {
      outcome = "unavailable";
      detail = String((error as Error).message).replace(/\s*\[[a-z_]+\]\s*$/, "");
    } else {
      outcome = "fail";
      const code = stableCode(error);
      detail = `${(error as Error)?.message ?? String(error)}${code && !String((error as Error)?.message).includes(`[${code}]`) && !(error instanceof CheckFailed) ? ` (${code})` : ""}`;
    }
  } finally {
    clearTimeout(timer);
    for (const task of cleanups.reverse()) {
      try {
        await Promise.race([Promise.resolve().then(task), new Promise((resolve) => setTimeout(resolve, 30_000))]);
      } catch {
        // Cleanup is best effort; the snippet's outcome stands.
      }
    }
    restore();
  }
  const durationMs = performance.now() - started;
  const paintOutcome = OUTCOME_STYLE[outcome];
  console.log(`${paintOutcome(`${symbols[outcome]} ${OUTCOME_LABEL[outcome]}`)} ${snippet.id} ${snippet.title} ${style.dim(`(${seconds(durationMs)})`)}${detail ? `\n  ${paintOutcome(detail)}` : ""}`);
  return { snippet, outcome, durationMs, checks, ...(detail ? { detail } : {}) };
}

function isEntry(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry).toLowerCase() === realpathSync.native(fileURLToPath(moduleUrl)).toLowerCase();
  } catch {
    return false;
  }
}

/** Declares a snippet. Running its file directly (`pnpm snippet 03`, or `tsx src/03-….ts`) runs just that snippet. */
export function snippet(
  moduleUrl: string,
  meta: { readonly title: string; readonly section: string; readonly requires: readonly string[]; readonly timeoutMs?: number },
  run: Snippet["run"],
): Snippet {
  const definition: Snippet = {
    id: basename(fileURLToPath(moduleUrl)).slice(0, 2),
    title: meta.title,
    section: meta.section,
    requires: meta.requires,
    timeoutMs: meta.timeoutMs ?? 3 * 60_000,
    run,
  };
  if (isEntry(moduleUrl)) {
    // Exit explicitly: timed-out platform work cannot be cancelled from here and may hold connections open.
    void runSnippet(definition).then((result) => process.exit(result.outcome === "fail" ? 1 : 0));
  }
  return definition;
}

/** Waits for a condition with a deadline, for platform work that completes asynchronously. */
export async function eventually<T>(probe: () => Promise<T | undefined | false>, { timeoutMs = 120_000, intervalMs = 1_000, what = "the condition" } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new CheckFailed(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

