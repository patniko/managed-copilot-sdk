// The datasets an analysis can start from: the bundled samples, and CSV files people upload (kept in the data
// directory). Memory stays bounded however many files people upload: only the newest uploads are kept (older ones are
// dropped, files included), and only their summaries stay in memory; a few at a time are kept parsed.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ColumnInfo, DatasetSummary, SuggestedPrompt } from "../shared/types.js";
import { DeskError, errorText } from "./errors.js";
import { log } from "./log.js";
import { Table, TableError } from "./table.js";

export interface Sample {
  readonly id: string;
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly prompts: readonly SuggestedPrompt[];
}

/** The bundled datasets (`datasets/*.csv`), each with a question the app's tools answer and one that needs code. */
export const SAMPLES: readonly Sample[] = [
  {
    // The cross-demo story: mobile carts just under free shipping drop out at the shipping step, which leads to a UX
    // experiment Data Desk sends to Software Factory.
    id: "sample-checkout-funnel",
    file: "checkout-funnel.csv",
    name: "Storefront checkout funnel",
    description: "Contoso Outdoors, 12 weeks",
    prompts: [
      // "By cart value" makes the first answer find the $40–$49 band; by device alone, the gap looks like payment friction.
      { text: "Where do mobile shoppers drop out of checkout, by cart value?", needs: "tools" },
      { text: "Chart shipping-step drop-off by cart value for each device", needs: "code" },
    ],
  },
  {
    id: "sample-coffee-sales",
    file: "coffee-sales.csv",
    name: "Coffee shop sales",
    description: "Three stores, four products, 2025",
    prompts: [
      { text: "Which store made the most revenue in 2025?", needs: "tools" },
      { text: "Chart monthly revenue for each store", needs: "code" },
    ],
  },
  {
    id: "sample-bike-rides",
    file: "bike-rides.csv",
    name: "City bike rides",
    description: "Daily rides and the weather",
    prompts: [
      { text: "Which weekday has the most rides on average?", needs: "tools" },
      { text: "Plot rides against temperature with a trend line", needs: "code" },
    ],
  },
  {
    id: "sample-support-tickets",
    file: "support-tickets.csv",
    name: "Support tickets",
    description: "Resolution times and satisfaction",
    prompts: [
      { text: "Which team takes longest to resolve tickets?", needs: "tools" },
      { text: "Does resolution time affect satisfaction? Show a chart", needs: "code" },
    ],
  },
];

export interface Dataset {
  readonly summary: DatasetSummary;
  /** The parsed file; an upload that isn't in memory is read again. Throws once the dataset is no longer available. */
  table(): Table;
  /** The file as it was uploaded, copied into the sandbox when the session moves. */
  bytes(): Buffer;
}

/** How many uploads Data Desk keeps, and how many of them stay parsed in memory. */
export interface UploadLimits {
  /** Uploads kept: adding another drops the oldest, files included. */
  readonly maxUploads: number;
  /** The kept uploads' total size. */
  readonly maxStoredBytes: number;
  /** The total size of the uploads kept parsed; the others are parsed again when used. */
  readonly maxParsedBytes: number;
}

interface UploadMeta {
  readonly name: string;
  readonly fileName: string;
  readonly uploadedAt: string;
}

function isUploadMeta(value: unknown): value is UploadMeta {
  const meta = value as Partial<UploadMeta> | null;
  return typeof meta?.name === "string" && typeof meta.fileName === "string" && typeof meta.uploadedAt === "string";
}

/** Data Desk's files in the uploads folder: each upload's CSV file and details, and what an interrupted write left. */
const UPLOAD_FILE = /^(upload-[0-9a-f]{16})\.(?:csv|json)(?:\.tmp)?$/;
const GONE = "That dataset isn't available anymore. Pick another one.";
const gone = () => new DeskError("not_found", GONE, 404);
/** The longest file name common file systems allow; longer names are cut first, so cleaning them up stays cheap. */
const MAX_FILE_NAME = 255;

/** A file name safe for the sandbox's `data/` folder: lowercase letters, digits, dashes, dots, ending in `.csv`. */
export function sandboxFileName(original: string): string {
  const base = original
    .slice(0, MAX_FILE_NAME)
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${base || "data"}.csv`;
}

/** A person-friendly name from a file name: "q3_sales-by-region.csv" becomes "Q3 sales by region". */
export function displayName(original: string): string {
  const words = original
    .slice(0, MAX_FILE_NAME)
    .replace(/\.[^.]*$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Uploaded data";
}

const MEASURES = /revenue|sales|amount|total|price|cost|profit|units|count|value|score|rides|hours|qty|quantity/i;

/** Two starting questions for an uploaded file, from its columns. */
export function suggestPrompts(columns: readonly ColumnInfo[]): SuggestedPrompt[] {
  const numbers = columns.filter((column) => column.type === "number");
  const measure = numbers.find((column) => MEASURES.test(column.name)) ?? numbers[0];
  const category = columns.find((column) => column.type === "text" && (column.distinct ?? Infinity) <= 30 && (column.distinct ?? 0) > 1);
  const date = columns.find((column) => column.type === "date");
  const other = numbers.find((column) => column !== measure);
  const tools: SuggestedPrompt =
    measure && category
      ? { text: `What's the total ${measure.name} by ${category.name}?`, needs: "tools" }
      : measure
        ? { text: `What are the average and largest ${measure.name}?`, needs: "tools" }
        : { text: "Describe this dataset", needs: "tools" };
  const code: SuggestedPrompt =
    measure && date
      ? { text: `Chart ${measure.name} over ${date.name}`, needs: "code" }
      : measure && category
        ? { text: `Chart ${measure.name} by ${category.name}`, needs: "code" }
        : measure && other
          ? { text: `Plot ${measure.name} against ${other.name} with a trend line`, needs: "code" }
          : { text: "Chart the most interesting column", needs: "code" };
  return [tools, code];
}

function summarize(id: string, name: string, fileName: string, table: Table, bytes: number, extra: { description?: string; sample: boolean; prompts?: readonly SuggestedPrompt[] }): DatasetSummary {
  return {
    id,
    name,
    fileName,
    ...(extra.description ? { description: extra.description } : {}),
    sample: extra.sample,
    rows: table.rows.length,
    bytes,
    // Names and types only: summaries stay small, and none of them holds on to the parsed table's values.
    columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
    prompts: extra.prompts ?? suggestPrompts(table.columns),
  };
}

interface Entry {
  readonly dataset: Dataset;
  readonly path: string;
  /** The file's size. */
  readonly size: number;
  /** Samples stay parsed. */
  readonly table?: Table;
  /** Uploads only. */
  meta?: UploadMeta;
}

export class Datasets {
  readonly #samplesDir: string;
  readonly #uploadsDir: string;
  readonly #maxBytes: number;
  readonly #limits: UploadLimits;
  readonly #entries = new Map<string, Entry>();
  /** Uploads, newest first. */
  #uploads: string[] = [];
  /** Parsed uploads, least recently used first. */
  readonly #parsed = new Map<string, { readonly table: Table; readonly size: number }>();

  constructor(samplesDir: string, dataDir: string, maxBytes: number, limits: Partial<UploadLimits> = {}) {
    this.#samplesDir = samplesDir;
    this.#uploadsDir = join(dataDir, "uploads");
    this.#maxBytes = maxBytes;
    // A parsed file takes up to about 12 times its size in memory (100,000 rows of tiny values): with 5 MB files, the
    // parsed uploads kept take about 60 MB at most, however many uploads there are.
    this.#limits = { maxUploads: 10, maxStoredBytes: 4 * maxBytes, maxParsedBytes: maxBytes, ...limits };
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  /** Reads the samples and the newest uploads kept from earlier runs, and removes the uploads beyond the limits. */
  load(): void {
    for (const sample of SAMPLES) {
      const path = join(this.#samplesDir, sample.file);
      try {
        const bytes = readFileSync(path);
        const table = Table.fromCsv(bytes.toString("utf8"));
        const summary = summarize(sample.id, sample.name, sample.file, table, bytes.length, { description: sample.description, sample: true, prompts: sample.prompts });
        this.#entries.set(sample.id, this.#entry(summary, path, table));
      } catch (error) {
        log.error("Couldn't load a sample dataset", { file: sample.file, error: errorText(error) });
      }
    }
    mkdirSync(this.#uploadsDir, { recursive: true });
    const found: { id: string; meta: UploadMeta; size: number }[] = [];
    for (const file of readdirSync(this.#uploadsDir)) {
      const id = UPLOAD_FILE.exec(file)?.[1];
      if (!id || file !== `${id}.json`) continue;
      try {
        const meta: unknown = JSON.parse(readFileSync(join(this.#uploadsDir, file), "utf8"));
        if (!isUploadMeta(meta)) throw new Error("Its details are incomplete.");
        found.push({ id, meta, size: statSync(this.#csvPath(id)).size });
      } catch (error) {
        log.warn("Removing an uploaded dataset that can't be read", { id, error: errorText(error) });
      }
    }
    let stored = 0;
    for (const { id, meta, size } of found.sort((a, b) => b.meta.uploadedAt.localeCompare(a.meta.uploadedAt))) {
      if (size > this.#maxBytes) continue;
      if (this.#uploads.length >= this.#limits.maxUploads || stored + size > this.#limits.maxStoredBytes) break;
      try {
        // Parsed once for its summary; the table is let go, and read again when an analysis uses it.
        const table = Table.fromCsv(readFileSync(this.#csvPath(id), "utf8"));
        this.#entries.set(id, this.#entry(summarize(id, meta.name, meta.fileName, table, size, { sample: false }), this.#csvPath(id), undefined, meta));
        this.#uploads.push(id);
        stored += size;
      } catch (error) {
        log.warn("Removing an uploaded dataset that can't be read", { id, error: errorText(error) });
      }
    }
    // Everything else goes: the oldest uploads beyond the limits, unreadable ones, and what interrupted writes left.
    const removed = new Set<string>();
    for (const file of readdirSync(this.#uploadsDir)) {
      const id = UPLOAD_FILE.exec(file)?.[1];
      if (!id || this.#entries.has(id)) continue;
      this.#remove(file);
      removed.add(id);
    }
    if (removed.size > 0) log.info("Removed uploaded datasets Data Desk no longer keeps", { count: removed.size, kept: this.#uploads.length });
  }

  list(): DatasetSummary[] {
    return [...SAMPLES.map((sample) => sample.id), ...this.#uploads].flatMap((id) => {
      const entry = this.#entries.get(id);
      return entry ? [entry.dataset.summary] : [];
    });
  }

  get(id: string): Dataset | undefined {
    return this.#entries.get(id)?.dataset;
  }

  require(id: string): Dataset {
    const dataset = this.get(id);
    if (!dataset) throw gone();
    return dataset;
  }

  /**
   * Adds an uploaded CSV file, dropping the oldest uploads beyond the limits; the same bytes again answer with the
   * dataset already added, which counts as the newest upload again.
   */
  add(originalName: string, bytes: Buffer): Dataset {
    if (bytes.length === 0) throw new DeskError("invalid_request", "That file is empty.");
    if (bytes.length > this.#maxBytes) throw new DeskError("payload_too_large", `Upload a CSV file up to ${Math.round(this.#maxBytes / (1024 * 1024))} MB.`, 413);
    const id = `upload-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
    const existing = this.#entries.get(id);
    if (existing?.meta) {
      existing.meta = { ...existing.meta, uploadedAt: new Date().toISOString() };
      this.#writeMeta(id, existing.meta);
      this.#uploads = [id, ...this.#uploads.filter((other) => other !== id)];
      return existing.dataset;
    }
    const text = bytes.toString("utf8");
    if (text.includes("\u0000")) throw new DeskError("invalid_request", "That isn't a text file. Upload a CSV file.");
    let table: Table;
    try {
      table = Table.fromCsv(text);
    } catch (error) {
      throw new DeskError("invalid_request", error instanceof TableError ? error.message : "That file can't be read as CSV.");
    }
    if (table.rows.length === 0) throw new DeskError("invalid_request", "That file has a header but no rows.");
    const meta: UploadMeta = { name: displayName(originalName), fileName: sandboxFileName(originalName), uploadedAt: new Date().toISOString() };
    mkdirSync(this.#uploadsDir, { recursive: true });
    writeAtomically(this.#csvPath(id), bytes);
    this.#writeMeta(id, meta);
    const entry = this.#entry(summarize(id, meta.name, meta.fileName, table, bytes.length, { sample: false }), this.#csvPath(id), undefined, meta);
    this.#entries.set(id, entry);
    this.#uploads.unshift(id);
    this.#keepParsed(id, bytes.length, table);
    log.info("Added an uploaded dataset", { id, rows: table.rows.length, columns: table.header.length });
    this.#trim();
    return entry.dataset;
  }

  #entry(summary: DatasetSummary, path: string, table?: Table, meta?: UploadMeta): Entry {
    const id = summary.id;
    return {
      dataset: { summary, table: () => this.#table(id), bytes: () => this.#bytes(id) },
      path,
      size: summary.bytes,
      ...(table ? { table } : {}),
      ...(meta ? { meta } : {}),
    };
  }

  #table(id: string): Table {
    const entry = this.#entries.get(id);
    if (!entry) throw gone();
    if (entry.table) return entry.table;
    const parsed = this.#parsed.get(id);
    if (parsed) {
      this.#parsed.delete(id);
      this.#parsed.set(id, parsed);
      return parsed.table;
    }
    let table: Table;
    try {
      table = Table.fromCsv(readFileSync(entry.path, "utf8"));
    } catch (error) {
      log.warn("Couldn't read an uploaded dataset", { id, error: errorText(error) });
      throw gone();
    }
    this.#keepParsed(id, entry.size, table);
    return table;
  }

  #bytes(id: string): Buffer {
    const entry = this.#entries.get(id);
    if (!entry) throw gone();
    try {
      return readFileSync(entry.path);
    } catch (error) {
      log.warn("Couldn't read a dataset's file", { id, error: errorText(error) });
      throw gone();
    }
  }

  /** Keeps a parsed upload in memory, letting go of the least recently used ones beyond the limit. */
  #keepParsed(id: string, size: number, table: Table): void {
    this.#parsed.delete(id);
    this.#parsed.set(id, { table, size });
    let total = 0;
    for (const value of this.#parsed.values()) total += value.size;
    for (const [key, value] of this.#parsed) {
      if (total <= this.#limits.maxParsedBytes || key === id) break;
      this.#parsed.delete(key);
      total -= value.size;
    }
  }

  /** Drops the oldest uploads, files included, until the rest fit the limits. */
  #trim(): void {
    let stored = 0;
    for (const id of this.#uploads) stored += this.#entries.get(id)?.size ?? 0;
    while (this.#uploads.length > this.#limits.maxUploads || stored > this.#limits.maxStoredBytes) {
      const oldest = this.#uploads.pop()!;
      stored -= this.#entries.get(oldest)?.size ?? 0;
      this.#entries.delete(oldest);
      this.#parsed.delete(oldest);
      this.#remove(`${oldest}.csv`);
      this.#remove(`${oldest}.json`);
      log.info("Dropped the oldest uploaded dataset", { id: oldest });
    }
  }

  #csvPath(id: string): string {
    return join(this.#uploadsDir, `${id}.csv`);
  }

  #writeMeta(id: string, meta: UploadMeta): void {
    writeAtomically(join(this.#uploadsDir, `${id}.json`), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
  }

  #remove(file: string): void {
    try {
      rmSync(join(this.#uploadsDir, file), { force: true });
    } catch (error) {
      log.warn("Couldn't remove an uploaded file", { file, error: errorText(error) });
    }
  }
}

function writeAtomically(path: string, bytes: Buffer): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}
