import type { SandboxSetupPlan, SandboxSetupRecord, SandboxSetupStep, SandboxSetupStepKind } from "@managed-copilot/protocol";
import { LIMITS, PATHS } from "../shared/constants.js";
import { normalizeWorkspacePath, PathError } from "../shared/paths.js";
import { redact, run, type Identity } from "./exec.js";

export interface SetupContext {
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly identity: Identity;
  /** Writes one workspace file as the workload identity (fsworker). */
  writeFile(path: string, content: Buffer): Promise<{ size: number; sha256: string }>;
  onProgress(record: SandboxSetupRecord): void;
}

export class SetupError extends Error {}

const NETWORK_HINT =
  "If network access is disabled or restricted for this environment, session-time installs cannot reach the package index; use a prepared image or allow the index host.";
const NETWORK_FAILURE = /ProxyError|SSLError|CERTIFICATE_VERIFY_FAILED|handshake failure|Max retries exceeded|Failed to establish a new connection|Temporary failure in name resolution|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|403 Forbidden|tunneling socket|network is unreachable|ETIMEDOUT|Could not find a version that satisfies/i;

function now(): string {
  return new Date().toISOString();
}

function validateSpec(kind: "python" | "npm", spec: string): string {
  const value = spec.trim();
  if (!value || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("-")) {
    throw new SetupError(`Invalid ${kind} package "${spec}". Use a package specifier such as ${kind === "python" ? '"pandas==2.2.3"' : '"typescript@5.9"'}.`);
  }
  return value;
}

/** Decodes strict base64 (setup `files` travel base64-encoded), checking the decoded size before allocating it. */
function decodeBase64(path: string, value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new SetupError(`Setup file "${path}" is not valid base64.`);
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  if ((compact.length / 4) * 3 - padding > LIMITS.setupFiles.fileBytes) throw new SetupError(`Setup file "${path}" is larger than 1 MiB; upload it with the files API instead.`);
  return Buffer.from(compact, "base64");
}

export function emptyRecord(): SandboxSetupRecord {
  return { state: "pending", steps: [], resolved: {}, files: [] };
}

/**
 * Runs admitted setup once, in order: Python packages, npm packages, files, then setup commands (spec section 5).
 * Records progress, resolved versions, and file digests. A failing step stops setup and returns a `failed` record
 * with a redacted error; it never throws for setup failures.
 */
export async function runSetup(plan: SandboxSetupPlan, ctx: SetupContext): Promise<SandboxSetupRecord> {
  const steps: SandboxSetupStep[] = [];
  const resolved: { python?: Record<string, string>; npm?: Record<string, string> } = {};
  const files: { path: string; size: number; sha256: string }[] = [];
  let record: SandboxSetupRecord = { state: "running", steps, resolved, files, startedAt: now() };
  const publish = () => ctx.onProgress((record = { ...record, steps: [...steps], resolved: { ...resolved }, files: [...files] }));
  try {
    await execute(plan, ctx, { steps, resolved, files, publish });
    record = { ...record, state: "succeeded", finishedAt: now() };
  } catch (error) {
    const message = error instanceof SetupError ? error.message : `Setup failed unexpectedly: ${(error as Error)?.message ?? String(error)}`;
    record = { ...record, steps: [...steps], resolved: { ...resolved }, files: [...files], state: "failed", finishedAt: now(), error: redact(message, ctx.secrets) };
  }
  ctx.onProgress(record);
  return record;
}

interface Progress {
  readonly steps: SandboxSetupStep[];
  readonly resolved: { python?: Record<string, string>; npm?: Record<string, string> };
  readonly files: { path: string; size: number; sha256: string }[];
  readonly publish: () => void;
}

async function execute(plan: SandboxSetupPlan, ctx: SetupContext, progress: Progress): Promise<void> {
  const { steps, resolved, files, publish } = progress;
  const python = (plan.packages?.python ?? []).map((spec) => validateSpec("python", spec));
  const npm = (plan.packages?.npm ?? []).map((spec) => validateSpec("npm", spec));
  const fileEntries = Object.entries(plan.files ?? {});
  if (fileEntries.length > LIMITS.setupFiles.count) throw new SetupError(`Setup has ${fileEntries.length} files; the limit is ${LIMITS.setupFiles.count}. Upload larger sets with the files API.`);
  const decoded = fileEntries.map(([path, content]) => {
    let relative: string;
    try {
      relative = normalizeWorkspacePath(path);
    } catch (error) {
      throw new SetupError(`Setup file "${path}": ${(error as PathError).message}`);
    }
    const bytes = decodeBase64(path, content);
    if (bytes.length > LIMITS.setupFiles.fileBytes) throw new SetupError(`Setup file "${path}" is larger than 1 MiB; upload it with the files API instead.`);
    return { relative, bytes };
  });
  const totalBytes = decoded.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > LIMITS.setupFiles.totalBytes) throw new SetupError("Setup files exceed 8 MiB in total; upload large files with the files API instead.");

  const begin = (kind: SandboxSetupStepKind, name: string): number => {
    steps.push({ kind, name, state: "running", startedAt: now() });
    publish();
    return steps.length - 1;
  };
  const finish = (index: number, patch: Partial<SandboxSetupStep>): void => {
    steps[index] = { ...steps[index]!, ...patch, finishedAt: now() };
    publish();
  };
  const failStep = (index: number, message: string, exitCode?: number, output?: string): never => {
    finish(index, { state: "failed", ...(exitCode !== undefined ? { exitCode } : {}), ...(output ? { output: redact(output, ctx.secrets) } : {}) });
    throw new SetupError(redact(message, ctx.secrets));
  };

  const command = async (index: number, label: string, file: string, args: readonly string[], hintOnNetwork: boolean, timeoutSeconds = LIMITS.setupCommandTimeoutSeconds) => {
    const result = await run(file, args, { identity: ctx.identity, env: ctx.env, cwd: PATHS.workspace, timeoutMs: timeoutSeconds * 1000 });
    if (result.timedOut) failStep(index, `${label} timed out after ${timeoutSeconds} seconds.`, undefined, result.output);
    if (result.exitCode !== 0) {
      const hint = hintOnNetwork && NETWORK_FAILURE.test(result.output) ? ` ${NETWORK_HINT}` : "";
      failStep(index, `${label} failed with exit code ${result.exitCode ?? result.signal}.${hint}`, result.exitCode ?? undefined, result.output);
    }
    return result;
  };

  if (python.length > 0) {
    const label = `pip install ${python.join(" ")}`;
    const index = begin("python", label);
    await command(index, label, `${PATHS.venv}/bin/pip`, ["install", "--no-input", "--disable-pip-version-check", "--progress-bar", "off", ...python], true);
    const listed = await run(`${PATHS.venv}/bin/pip`, ["list", "--format=json", "--disable-pip-version-check"], { identity: ctx.identity, env: ctx.env, cwd: PATHS.workspace, timeoutMs: 120_000 });
    try {
      resolved.python = Object.fromEntries((JSON.parse(listed.stdout) as { name: string; version: string }[]).map((item) => [item.name, item.version]));
    } catch {
      resolved.python = {};
    }
    finish(index, { state: "succeeded", exitCode: 0 });
  }

  if (npm.length > 0) {
    const label = `npm install -g ${npm.join(" ")}`;
    const index = begin("npm", label);
    await command(index, label, "/usr/local/bin/npm", ["install", "--global", "--no-fund", "--no-audit", "--loglevel=error", ...npm], true);
    const listed = await run("/usr/local/bin/npm", ["ls", "--global", "--json", "--depth=0"], { identity: ctx.identity, env: ctx.env, cwd: PATHS.workspace, timeoutMs: 120_000 });
    try {
      const dependencies = (JSON.parse(listed.stdout) as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
      resolved.npm = Object.fromEntries(Object.entries(dependencies).map(([name, info]) => [name, info.version ?? "unknown"]));
    } catch {
      resolved.npm = {};
    }
    finish(index, { state: "succeeded", exitCode: 0 });
  }

  if (decoded.length > 0) {
    const index = begin("files", `write ${decoded.length} file${decoded.length === 1 ? "" : "s"}`);
    for (const file of decoded) {
      try {
        const written = await ctx.writeFile(file.relative, file.bytes);
        files.push({ path: file.relative, size: written.size, sha256: written.sha256 });
      } catch (error) {
        failStep(index, `Writing setup file "${file.relative}" failed: ${(error as Error).message}`);
      }
    }
    finish(index, { state: "succeeded" });
  }

  for (const setupCommand of plan.setupCommands ?? []) {
    const index = begin("command", setupCommand);
    await command(index, `Setup command \`${setupCommand}\``, "/bin/bash", ["-c", setupCommand], true);
    finish(index, { state: "succeeded", exitCode: 0 });
  }
}
