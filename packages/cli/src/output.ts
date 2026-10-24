/** Terminal output that degrades gracefully: colors only on color-capable TTYs, ASCII symbols where Unicode is unsafe. */

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  readonly ok: string;
  readonly fail: string;
  readonly warn: string;
  readonly dot: string;
  readonly arrow: string;
  readonly ellipsis: string;
}

export interface StyleOptions {
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly noColor?: boolean;
  readonly platform?: NodeJS.Platform;
}

function colorEnabled({ isTTY, env, noColor }: StyleOptions): boolean {
  if (noColor || env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return isTTY && env.TERM !== "dumb";
}

function unicodeEnabled({ env, platform = process.platform }: StyleOptions): boolean {
  if (platform !== "win32") return env.TERM !== "linux";
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.ConEmuTask || env.TERMINAL_EMULATOR === "JetBrains-JediTerm" || env.TERM === "xterm-256color" || env.TERM === "alacritty");
}

export function createStyle(options: StyleOptions): Style {
  const color = colorEnabled(options);
  const paint = (open: number, close: number) => (text: string) => (color ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  const unicode = unicodeEnabled(options);
  return {
    bold: paint(1, 22),
    dim: paint(2, 22),
    red: paint(31, 39),
    green: paint(32, 39),
    yellow: paint(33, 39),
    cyan: paint(36, 39),
    ok: unicode ? "✔" : "√",
    fail: unicode ? "✖" : "×",
    warn: unicode ? "⚠" : "!",
    dot: unicode ? "●" : "*",
    arrow: unicode ? "→" : "->",
    ellipsis: unicode ? "…" : "...",
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

export function truncate(text: string, max: number, ellipsis = "…"): string {
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, Math.max(0, max - 1)).join("")}${ellipsis}`;
}

/** A left-aligned table with a dim header row and two-space gutters. Cells may contain color codes. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], style: Style): string {
  const widths = headers.map((header, column) => Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? ""))));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : `${cell}${" ".repeat(widths[column]! - visibleLength(cell))}`))
      .join("  ")
      .trimEnd();
  return [style.dim(line(headers)), ...rows.map(line)].join("\n");
}

const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.35, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

/** "5 minutes ago", "in 3 hours", "just now". */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "-";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  let delta = (time - now) / 1000;
  if (Math.abs(delta) < 45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [size, unit] of UNITS) {
    if (Math.abs(delta) < size) return format.format(Math.round(delta), unit);
    delta /= size;
  }
  return iso;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** The first eight characters, like a short git hash. Any unique prefix resolves back to the full ID. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
