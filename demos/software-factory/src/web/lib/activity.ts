import { FileIcon, PencilIcon, SearchIcon, TerminalIcon, ToolsIcon, type Icon } from "@primer/octicons-react";
import { TEST_SUMMARY_MARKER } from "../../shared/types.js";

export function toolIcon(name: string): Icon {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...words: string[]): boolean => tokens.some((token) => words.includes(token));
  if (has("shell", "bash", "sh", "powershell", "pwsh", "terminal", "exec", "command", "run")) return TerminalIcon;
  if (has("create", "edit", "write", "replace", "patch", "insert", "apply", "editor")) return PencilIcon;
  if (has("grep", "glob", "search", "find", "rg", "ls", "list")) return SearchIcon;
  if (has("view", "read", "cat", "open", "fetch", "get")) return FileIcon;
  return ToolsIcon;
}

export interface MarkerSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads the harness's `FACTORY_TEST_SUMMARY` line from tool output (JSON or `key=value` pairs). */
export function parseSummaryMarker(output: string | undefined): MarkerSummary | undefined {
  if (!output || !output.includes(TEST_SUMMARY_MARKER)) return undefined;
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const at = line.indexOf(TEST_SUMMARY_MARKER);
    if (at < 0) continue;
    const rest = line.slice(at + TEST_SUMMARY_MARKER.length).replace(/^[\s:=]+/, "");
    let fields: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(rest);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        fields = typeof record.summary === "object" && record.summary !== null ? (record.summary as Record<string, unknown>) : record;
      }
    } catch {
      for (const match of rest.matchAll(/(\w+)\s*[=:]\s*(\d+)/g)) {
        const [, key, value] = match;
        if (key && value) fields[key.toLowerCase()] = Number(value);
      }
    }
    const passed = toNumber(fields.passed);
    const failed = toNumber(fields.failed);
    if (passed === undefined || failed === undefined) continue;
    const skipped = toNumber(fields.skipped) ?? 0;
    return { total: toNumber(fields.total) ?? passed + failed + skipped, passed, failed, skipped };
  }
  return undefined;
}
