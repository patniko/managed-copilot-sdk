// The CPU time and memory of one process the gateway started (the shared runtime), read from the operating system:
// /proc on Linux (the gateway's container), `ps` on macOS, and PowerShell's Get-Process on Windows.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessUsage {
  /** CPU time it has used since it started (user and system), in milliseconds. */
  readonly cpuMs: number;
  /** Memory it holds now (resident set / working set), in bytes. */
  readonly memoryBytes: number;
  /** The most memory it has held, in bytes, where the operating system keeps it (not on macOS). */
  readonly peakMemoryBytes?: number;
}

/** `/proc/<pid>/stat`: `utime` and `stime` (fields 14 and 15) in clock ticks. The command name may hold spaces and parentheses. */
export function parseProcStat(stat: string, ticksPerSecond: number): number | undefined {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  if (!Number.isFinite(user) || !Number.isFinite(system)) return undefined;
  return ((user + system) * 1000) / ticksPerSecond;
}

/** `/proc/<pid>/status`: `VmRSS` and `VmHWM`, in kB. */
export function parseProcStatus(status: string): { memoryBytes: number; peakMemoryBytes?: number } | undefined {
  const kb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(status);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const memoryBytes = kb("VmRSS");
  if (memoryBytes === undefined) return undefined;
  const peakMemoryBytes = kb("VmHWM");
  return { memoryBytes, ...(peakMemoryBytes !== undefined ? { peakMemoryBytes } : {}) };
}

/** `ps -o rss=,time=` on macOS: resident kB, then CPU time as `[[D-]H:]M:SS.ss`. */
export function parsePs(output: string): ProcessUsage | undefined {
  const [rss, time] = output.trim().split(/\s+/);
  if (!rss || !time) return undefined;
  const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
  const parts = (clock ?? "").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
  const memory = Number(rss);
  if (!Number.isFinite(seconds) || !Number.isFinite(memory)) return undefined;
  return { cpuMs: seconds * 1000, memoryBytes: memory * 1024 };
}

/** The Windows probe's line: CPU milliseconds, working set, and peak working set. */
export function parseWindows(output: string): ProcessUsage | undefined {
  const [cpu, memory, peak] = output.trim().split(/\s+/).map(Number);
  if (cpu === undefined || memory === undefined || !Number.isFinite(cpu) || !Number.isFinite(memory)) return undefined;
  return { cpuMs: cpu, memoryBytes: memory, ...(peak !== undefined && Number.isFinite(peak) ? { peakMemoryBytes: peak } : {}) };
}

let ticks: Promise<number> | undefined;

/** Linux clock ticks per second (`getconf CLK_TCK`; 100 on every common kernel). */
function ticksPerSecond(): Promise<number> {
  ticks ??= execFileAsync("getconf", ["CLK_TCK"], { timeout: 5_000 })
    .then(({ stdout }) => Number(stdout.trim()) || 100)
    .catch(() => 100);
  return ticks;
}

/** Reads a process's usage; undefined when it's gone or the operating system won't say. */
export async function readProcessUsage(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcessUsage | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === "linux") {
      const [stat, status, hz] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8"), ticksPerSecond()]);
      const cpuMs = parseProcStat(stat, hz);
      const memory = parseProcStatus(status);
      return cpuMs === undefined || !memory ? undefined : { cpuMs, ...memory };
    }
    if (platform === "win32") {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { "{0} {1} {2}" -f [math]::Round($p.TotalProcessorTime.TotalMilliseconds), $p.WorkingSet64, $p.PeakWorkingSet64 }`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000 });
      return parseWindows(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-o", "rss=,time=", "-p", String(pid)], { timeout: 10_000 });
    return parsePs(stdout);
  } catch {
    return undefined;
  }
}
