// Exports a session's stock runtime state for promotion: the `session-state/<sessionId>/` directory of the source
// runtime's COPILOT_HOME, which is everything the stock runtime (1.0.103) needs to `session.resume` the same session
// elsewhere. Lock files are skipped, platform host paths are rewritten (the session's shared working directory
// becomes `/workspace`, any other platform path `/platform`), and an export that would carry a GitHub token into a
// sandbox is refused.
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { finished } from "node:stream/promises";
import { ManagedCopilotError } from "@managed-copilot/protocol";

/** Limits match what the sandbox imports (`importRuntimeState`). */
export const EXPORT_LIMITS = { files: 10_000, bytes: 1024 * 1024 * 1024 } as const;

/** Files whose text is rewritten. Everything else is copied byte for byte (and still scanned for tokens). */
const JSONL = new Set([".jsonl"]);
const JSON_FILES = new Set([".json"]);
const TEXT = new Set([".yaml", ".yml", ".md", ".txt", ".log", ".csv", ".toml", ".ini", ".xml", ".html"]);
/** Text files larger than this are copied without rewriting (they are not expected in session state). */
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;
/** GitHub token formats: classic and OAuth/app tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained PATs. */
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/;

export interface ExportOptions {
  /** `<COPILOT_HOME>/session-state/<sessionId>` of the source runtime. */
  readonly sourceDir: string;
  /** A new, empty staging directory that receives the export. */
  readonly targetDir: string;
  readonly sessionId: string;
  /** Platform directories to hide. `<root>/workspaces/<sessionId>` becomes `/workspace`; anything else `/platform`. */
  readonly platformRoots: readonly string[];
  /** Literal secrets (for example the owner's current token) the export must never contain. */
  readonly secrets?: readonly string[];
  readonly limits?: { readonly files?: number; readonly bytes?: number };
}

export interface ExportResult {
  readonly files: number;
  readonly bytes: number;
  /** Files whose platform paths were rewritten. */
  readonly rewritten: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The given root plus its canonical spelling (Windows 8.3 short names, symlinked temp directories). */
function rootVariants(roots: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const root of roots) {
    const trimmed = root.replace(/[\\/]+$/, "");
    if (!trimmed) continue;
    variants.add(trimmed);
    try {
      variants.add(realpathSync.native(trimmed).replace(/[\\/]+$/, ""));
    } catch {
      // A root that does not exist has no other spelling.
    }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/**
 * Rewrites platform paths inside strings. Separators may be `/`, `\`, or JSON-escaped `\\`; the path continues over
 * further segments, which are re-joined with `/`.
 */
export function pathRewriter(roots: readonly string[], sessionId: string): { test(text: string): boolean; rewrite(text: string): string } {
  const variants = rootVariants(roots);
  if (variants.length === 0) return { test: () => false, rewrite: (text) => text };
  const separator = String.raw`[\\/]+`;
  const alternatives = variants.map((root) => root.split(/[\\/]+/).map(escapeRegExp).join(separator));
  const flags = process.platform === "win32" ? "gi" : "g";
  // A root, not followed by more characters of the same directory name, then any further path segments.
  const source = `(?:${alternatives.join("|")})(?![^\\\\/\\s"'\`<>|])((?:${separator}[^\\\\/\\s"'\`<>|*?:]+)*)`;
  const pattern = new RegExp(source, flags);
  const probe = new RegExp(`(?:${alternatives.join("|")})`, flags.replace("g", ""));
  const caseInsensitive = process.platform === "win32";
  return {
    test: (text) => probe.test(text),
    rewrite: (text) =>
      text.replace(pattern, (_match, rest: string) => {
        const segments = rest.split(/[\\/]+/).filter(Boolean);
        const same = (a: string | undefined, b: string) => (a === undefined ? false : caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
        if (same(segments[0], "workspaces") && same(segments[1], sessionId)) {
          const tail = segments.slice(2);
          return tail.length > 0 ? `/workspace/${tail.join("/")}` : "/workspace";
        }
        return segments.length > 0 ? `/platform/${segments.join("/")}` : "/platform";
      }),
  };
}

function rewriteValue(value: unknown, rewrite: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") return rewrite(value);
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, rewrite, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = rewriteValue(item, rewrite, depth + 1);
  return out;
}

class SecretScanner {
  readonly #secrets: readonly string[];

  constructor(secrets: readonly string[]) {
    // Very short values would match by accident; tokens are long.
    this.#secrets = secrets.filter((secret) => secret.length >= 16);
  }

  check(text: string, file: string): void {
    if (TOKEN_PATTERN.test(text) || this.#secrets.some((secret) => text.includes(secret))) {
      throw new ManagedCopilotError(
        "policy_violation",
        `The session's history contains what looks like a GitHub token (in ${file}), and credentials never enter a sandbox. Start a new session for work that needs a sandbox.`,
        { file },
      );
    }
  }
}

/** Copies and rewrites the session state. Throws `ManagedCopilotError`; the caller removes `targetDir` on failure. */
export async function exportSessionState(options: ExportOptions): Promise<ExportResult> {
  const limits = { files: options.limits?.files ?? EXPORT_LIMITS.files, bytes: options.limits?.bytes ?? EXPORT_LIMITS.bytes };
  const rewriter = pathRewriter(options.platformRoots, options.sessionId);
  const scanner = new SecretScanner(options.secrets ?? []);
  let files = 0;
  let bytes = 0;
  let rewritten = 0;

  const root = await lstat(options.sourceDir).catch(() => undefined);
  if (!root?.isDirectory()) {
    throw new ManagedCopilotError("state_restore_failed", `The runtime state of session ${options.sessionId} was not found on its current placement.`, { sessionId: options.sessionId });
  }
  const account = (size: number, file: string) => {
    bytes += size;
    if (bytes > limits.bytes) {
      throw new ManagedCopilotError("capability_unavailable", `The session's history is larger than the ${Math.round(limits.bytes / (1024 * 1024))} MiB a sandbox can import (at ${file}).`);
    }
  };

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Runtime lock files (and lock directories) belong to the process that held them.
      if (entry.name.endsWith(".lock")) continue;
      const source = join(directory, entry.name);
      const name = relative(options.sourceDir, source).replace(/\\/g, "/");
      const target = join(options.targetDir, relative(options.sourceDir, source));
      const stats = await lstat(source);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new ManagedCopilotError("state_restore_failed", `The session's runtime state contains an unsupported entry (${name}); only regular files and folders can be moved.`);
      }
      if (stats.isDirectory()) {
        await mkdir(target, { recursive: true });
        await walk(source);
        continue;
      }
      files += 1;
      if (files > limits.files) throw new ManagedCopilotError("capability_unavailable", `The session's history has more than ${limits.files} files, more than a sandbox can import.`);
      const extension = extname(entry.name).toLowerCase();
      if (JSONL.has(extension)) {
        const result = await copyJsonLines(source, target, rewriter, scanner, name);
        account(result.bytes, name);
        if (result.rewritten) rewritten += 1;
      } else if ((JSON_FILES.has(extension) || TEXT.has(extension)) && stats.size <= MAX_REWRITE_BYTES) {
        const text = await readFile(source, "utf8");
        let output = text;
        if (rewriter.test(text)) {
          if (JSON_FILES.has(extension)) {
            try {
              output = `${JSON.stringify(rewriteValue(JSON.parse(text), rewriter.rewrite))}${text.endsWith("\n") ? "\n" : ""}`;
            } catch {
              output = rewriter.rewrite(text);
            }
          } else {
            output = rewriter.rewrite(text);
          }
        }
        scanner.check(output, name);
        const data = Buffer.from(output, "utf8");
        account(data.length, name);
        await writeFile(target, data);
        if (output !== text) rewritten += 1;
      } else {
        account(stats.size, name);
        const data = await readFile(source);
        scanner.check(data.toString("latin1"), name);
        await writeFile(target, data);
      }
    }
  };

  await mkdir(options.targetDir, { recursive: true });
  await walk(options.sourceDir);
  return { files, bytes, rewritten };
}

/**
 * Streams a JSONL journal line by line (split on `\n` only: JSON strings may hold raw U+2028/U+2029, which readline
 * would treat as line breaks); only lines that mention a platform path are parsed and re-serialized.
 */
async function copyJsonLines(
  source: string,
  target: string,
  rewriter: ReturnType<typeof pathRewriter>,
  scanner: SecretScanner,
  name: string,
): Promise<{ bytes: number; rewritten: boolean }> {
  const output = createWriteStream(target);
  let bytes = 0;
  let rewritten = false;
  let pending = "";
  const write = async (line: string, terminated: boolean) => {
    let text = line;
    if (rewriter.test(line)) {
      try {
        text = JSON.stringify(rewriteValue(JSON.parse(line), rewriter.rewrite));
      } catch {
        // A line the runtime could not have written completely; rewrite its text and let resume repair it.
        text = rewriter.rewrite(line);
      }
      if (text !== line) rewritten = true;
    }
    scanner.check(text, name);
    const chunk = terminated ? `${text}\n` : text;
    bytes += Buffer.byteLength(chunk);
    if (!output.write(chunk)) await new Promise<void>((resolve) => output.once("drain", () => resolve()));
  };
  try {
    for await (const chunk of createReadStream(source, { encoding: "utf8" })) {
      pending += chunk as string;
      let index = pending.indexOf("\n");
      while (index >= 0) {
        await write(pending.slice(0, index), true);
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
    }
    if (pending.length > 0) await write(pending, false);
  } finally {
    output.end();
    await finished(output).catch(() => undefined);
  }
  return { bytes, rewritten };
}
