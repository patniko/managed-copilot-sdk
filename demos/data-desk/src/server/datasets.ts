// The datasets an analysis can start from: the bundled samples, and CSV files people upload (kept in the data
// directory). Each is parsed once into a typed table for the grid and the agent's tools.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    description: "Daily rides and weather, summer 2025",
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
  readonly table: Table;
  /** The file as it was uploaded, copied into the sandbox when the session moves. */
  readonly bytes: Buffer;
}

interface UploadMeta {
  readonly name: string;
  readonly fileName: string;
  readonly uploadedAt: string;
}

/** A file name safe for the sandbox's `data/` folder: lowercase letters, digits, dashes, dots, ending in `.csv`. */
export function sandboxFileName(original: string): string {
  const base = original
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

function summarize(id: string, name: string, fileName: string, table: Table, bytes: Buffer, extra: { description?: string; sample: boolean; prompts?: readonly SuggestedPrompt[] }): DatasetSummary {
  return {
    id,
    name,
    fileName,
    ...(extra.description ? { description: extra.description } : {}),
    sample: extra.sample,
    rows: table.rows.length,
    bytes: bytes.length,
    columns: table.columns,
    prompts: extra.prompts ?? suggestPrompts(table.columns),
  };
}

export class Datasets {
  readonly #samplesDir: string;
  readonly #uploadsDir: string;
  readonly #maxBytes: number;
  readonly #datasets = new Map<string, Dataset>();
  /** Uploads, newest first. */
  #uploads: string[] = [];

  constructor(samplesDir: string, dataDir: string, maxBytes: number) {
    this.#samplesDir = samplesDir;
    this.#uploadsDir = join(dataDir, "uploads");
    this.#maxBytes = maxBytes;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  /** Reads the samples and the uploads kept from earlier runs. */
  load(): void {
    for (const sample of SAMPLES) {
      try {
        const bytes = readFileSync(join(this.#samplesDir, sample.file));
        const table = Table.fromCsv(bytes.toString("utf8"));
        this.#datasets.set(sample.id, { table, bytes, summary: summarize(sample.id, sample.name, sample.file, table, bytes, { description: sample.description, sample: true, prompts: sample.prompts }) });
      } catch (error) {
        log.error("Couldn't load a sample dataset", { file: sample.file, error: errorText(error) });
      }
    }
    mkdirSync(this.#uploadsDir, { recursive: true });
    const uploads: { id: string; at: string }[] = [];
    for (const entry of readdirSync(this.#uploadsDir)) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      try {
        const meta = JSON.parse(readFileSync(join(this.#uploadsDir, entry), "utf8")) as UploadMeta;
        const bytes = readFileSync(join(this.#uploadsDir, `${id}.csv`));
        const table = Table.fromCsv(bytes.toString("utf8"));
        this.#datasets.set(id, { table, bytes, summary: summarize(id, meta.name, meta.fileName, table, bytes, { sample: false }) });
        uploads.push({ id, at: meta.uploadedAt });
      } catch (error) {
        log.warn("Skipping an uploaded dataset that can't be read", { id, error: errorText(error) });
      }
    }
    this.#uploads = uploads.sort((a, b) => b.at.localeCompare(a.at)).map((upload) => upload.id);
  }

  list(): DatasetSummary[] {
    const samples = SAMPLES.flatMap((sample) => {
      const dataset = this.#datasets.get(sample.id);
      return dataset ? [dataset.summary] : [];
    });
    return [...samples, ...this.#uploads.flatMap((id) => (this.#datasets.has(id) ? [this.#datasets.get(id)!.summary] : []))];
  }

  get(id: string): Dataset | undefined {
    return this.#datasets.get(id);
  }

  require(id: string): Dataset {
    const dataset = this.#datasets.get(id);
    if (!dataset) throw new DeskError("not_found", "That dataset isn't available anymore. Pick another one.", 404);
    return dataset;
  }

  /** Adds an uploaded CSV file; the same bytes again answer with the dataset already added. */
  add(originalName: string, bytes: Buffer): Dataset {
    if (bytes.length === 0) throw new DeskError("invalid_request", "That file is empty.");
    if (bytes.length > this.#maxBytes) throw new DeskError("payload_too_large", `Upload a CSV file up to ${Math.round(this.#maxBytes / (1024 * 1024))} MB.`, 413);
    const text = bytes.toString("utf8");
    if (text.includes("\u0000")) throw new DeskError("invalid_request", "That isn't a text file. Upload a CSV file.");
    let table: Table;
    try {
      table = Table.fromCsv(text);
    } catch (error) {
      throw new DeskError("invalid_request", error instanceof TableError ? error.message : "That file can't be read as CSV.");
    }
    if (table.rows.length === 0) throw new DeskError("invalid_request", "That file has a header but no rows.");
    const id = `upload-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
    const existing = this.#datasets.get(id);
    if (existing) return existing;
    const meta: UploadMeta = { name: displayName(originalName), fileName: sandboxFileName(originalName), uploadedAt: new Date().toISOString() };
    mkdirSync(this.#uploadsDir, { recursive: true });
    writeAtomically(join(this.#uploadsDir, `${id}.csv`), bytes);
    writeAtomically(join(this.#uploadsDir, `${id}.json`), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
    const dataset: Dataset = { table, bytes, summary: summarize(id, meta.name, meta.fileName, table, bytes, { sample: false }) };
    this.#datasets.set(id, dataset);
    this.#uploads.unshift(id);
    log.info("Added an uploaded dataset", { id, rows: table.rows.length, columns: table.header.length });
    return dataset;
  }
}

function writeAtomically(path: string, bytes: Buffer): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}
