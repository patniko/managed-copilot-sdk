// What Data Desk sends to Software Factory, shared by the server (which composes and enforces it) and the UI (which
// shows what will be sent before it goes): the factory's limits on reference material, tables as CSV text, and the
// words for work orders.
import type { WorkOrderStatus } from "./types.js";

/** Software Factory's limits on a work order's context files (its routing contract). */
export const FACTORY_LIMITS = {
  files: 12,
  fileBytes: 256 * 1024,
  totalBytes: 512 * 1024,
} as const;

/** Data Desk's own limits on what a person sends. */
export const HANDOFF_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  noteMin: 10,
  /** What to build; the brief adds a summary of the insight and stays under the factory's 8,000 characters. */
  noteMax: 4_000,
  /** The most of the dataset's first rows "the current view" sends. */
  viewRows: 500,
  /** Selected rows per table. */
  selectedRows: 10_000,
} as const;

/** Why sending is off when Data Desk has no `SOFTWARE_FACTORY_URL`. */
export const FACTORY_NOT_CONNECTED = "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL.";

/** Work orders the factory is still working on: Data Desk follows these. */
export const ACTIVE_STATUSES: ReadonlySet<WorkOrderStatus> = new Set(["queued", "planning", "building", "releasing"]);

export const STATUS_LABEL: Readonly<Record<WorkOrderStatus, string>> = {
  queued: "Queued",
  planning: "Planning",
  building: "Building",
  releasing: "Releasing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A work order as people know it: `WO-0012`. */
export const workOrderLabel = (number: number): string => `WO-${String(number).padStart(4, "0")}`;

/** Published outputs that can be sent: charts as SVG, and text files. Images like PNG are binary and stay behind. */
const TEXT_OUTPUT = /\.(svg|csv|tsv|json|md|markdown|txt)$/i;

export const isTextOutput = (path: string): boolean => TEXT_OUTPUT.test(path);

/** One CSV field, quoted when it holds a comma, a quote, a line break, or spaces at either end (RFC 4180). */
export function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A table as CSV text: a header line, then one line per row, each ending in a line feed. */
export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => cells.map(csvField).join(",");
  return `${[line(columns), ...rows.map((row) => line(columns.map((_, index) => row[index] ?? "")))].join("\n")}\n`;
}

const encoder = new TextEncoder();

/** Text's size in UTF-8, the way the factory counts it. */
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

/** Kilobytes for messages, rounded up so a file just over a limit never reads as within it. */
export const kilobytes = (bytes: number): string => `${Math.max(1, Math.ceil(bytes / 1024)).toLocaleString("en-US")} KB`;
