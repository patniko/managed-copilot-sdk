import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The image's registry guard (also used by the gateway's registry tests). */
const GUARD = fileURLToPath(new URL("../image/check-registry-url.sh", import.meta.url));

/** Generous: Git for Windows' `sh` can take seconds to start on a loaded machine. */
export const GUARD_TIMEOUT_MS = 120_000;

/** Whether a POSIX `sh` is available (Linux, macOS, Git for Windows). */
export const hasSh = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;

export interface GuardResult {
  readonly status: number;
  /** The guard's stderr, without trailing line breaks. */
  readonly stderr: string;
}

// Each case runs in its own subshell with the arguments `sh <guard> NPM_REGISTRY <value>` would pass (the guard ends
// with `exit`, which leaves only that subshell), and reports `@@case <index> <status>` followed by the guard's stderr.
const DRIVER = [
  "i=0",
  'while [ "$i" -lt "$GUARD_COUNT" ]; do',
  '  eval "value=\\${GUARD_VALUE_$i}"',
  '  message=$(exec 2>&1 >/dev/null; set -- NPM_REGISTRY "$value"; . "$GUARD_SCRIPT")',
  "  status=$?",
  "  printf '@@case %s %s\\n%s\\n' \"$i\" \"$status\" \"$message\"",
  "  i=$((i + 1))",
  "done",
].join("\n");

/**
 * Runs the image's registry guard on every value in one `sh` process. A process per case made these tests slow (Git for
 * Windows' `sh` takes hundreds of milliseconds to start) and, under a loaded full run, longer than vitest's default
 * timeout. Values travel in the environment, because Windows command lines cannot carry every character (Git for
 * Windows' `sh` cuts an argument at a line break).
 */
export function runRegistryGuard(values: readonly string[]): GuardResult[] {
  const dir = mkdtempSync(join(tmpdir(), "mc-registry-guard-"));
  try {
    const guard = join(dir, "check-registry-url.sh");
    // The image build normalizes line endings the same way (sed) before running it.
    writeFileSync(guard, readFileSync(GUARD, "utf8").replace(/\r\n/g, "\n"));
    const env: Record<string, string | undefined> = { ...process.env, GUARD_SCRIPT: guard.replace(/\\/g, "/"), GUARD_COUNT: String(values.length) };
    values.forEach((value, index) => {
      env[`GUARD_VALUE_${index}`] = value;
    });
    const result = spawnSync("sh", ["-c", DRIVER], { encoding: "utf8", env });
    const results: GuardResult[] = [];
    for (const block of (result.stdout ?? "").split(/^@@case /m).slice(1)) {
      const [header = "", ...lines] = block.split(/\r?\n/);
      const [index, status] = header.split(" ").map(Number);
      if (index !== undefined && status !== undefined) results[index] = { status, stderr: lines.join("\n").replace(/\n+$/, "") };
    }
    for (let index = 0; index < values.length; index++) {
      if (!results[index]) throw new Error(`The registry guard did not report case ${index} (sh exited ${String(result.status)}): ${result.error?.message ?? result.stderr}`);
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
