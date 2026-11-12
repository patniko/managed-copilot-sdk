// Samples other apps serve: Downhill's shop sales, with `DOWNHILL_URL`. Each pick fetches the CSV file fresh, server to
// server, within a deadline and the upload size limit; the copy then becomes a dataset the way an upload does
// (`Datasets.open`). A fetch that fails says why, and nothing is kept: there's no fallback to an older copy.
import type { Sample } from "./datasets.js";
import { DeskError, errorText } from "./errors.js";
import { Table, TableError } from "./table.js";

/**
 * A sample another app serves: like a bundled one (`file` names its copy, here and in the sandbox's `data/`), but each
 * pick fetches its file from `url`.
 */
export interface RemoteSample extends Sample {
  /** The CSV file's address, fetched each time the sample is picked. */
  readonly url: string;
  /** What it is, in errors: "Couldn't load <label> from <url>: ...". */
  readonly label: string;
  /** Columns the file must have: its prompts and notes rely on them. */
  readonly columns: readonly string[];
  /** What the columns mean, added to the agent's instructions for an analysis of a copy. */
  readonly notes?: string;
}

/** The header of Downhill's `GET /api/sales.csv`. */
export const DOWNHILL_SALES_COLUMNS = ["time", "minutes_since_launch", "event", "order_id", "item", "kind", "price_usd", "promo_code", "promo_result", "discount_usd", "total_usd", "player", "source"];

/**
 * Downhill's shop sales since the game launched: purchases and rejected promo codes, from simulated players and real
 * ones. The launch-week banner offers `trail15`, which checkout rejects until the fix is deployed.
 */
export function downhillSales(downhillUrl: string): RemoteSample {
  return {
    id: "live-downhill-sales",
    file: "downhill-sales.csv",
    name: "Downhill shop sales",
    description: "Live from Downhill's shop, since launch",
    prompts: [
      // A list, newest first: the grid shows your own failed sale (the latest live row) at the top, and the count says how many.
      { text: "How many promo codes were rejected in the last hour? List them, newest first", needs: "tools" },
      { text: "Chart promotional sales and rejected promo codes every 10 minutes since launch", needs: "code" },
    ],
    url: `${downhillUrl}/api/sales.csv`,
    label: "Downhill's sales",
    columns: DOWNHILL_SALES_COLUMNS,
    notes: [
      "Each row is a checkout in Downhill's in-game shop since the game launched.",
      "event is purchase (an order) or promo_rejected (checkout refused the promo code, so no order; a full-price purchase after it is a separate row).",
      "promo_result is applied, rejected, or none: count promotional sales as purchases with promo_result applied, and rejected promo codes as promo_rejected rows.",
      "source is live for real players and simulated for Downhill's simulated players.",
      'time is the shop\'s local time and minutes_since_launch counts from launch: the newest row is the latest activity, so "the last hour" is the 60 minutes before it.',
    ].join(" "),
  };
}

/** The remote samples Data Desk offers: Downhill's shop sales when `DOWNHILL_URL` is set. */
export function remoteSamples(config: { readonly downhillUrl?: string }): RemoteSample[] {
  return config.downhillUrl ? [downhillSales(config.downhillUrl)] : [];
}

export interface FetchOptions {
  /** The largest file: the upload limit. */
  readonly maxBytes: number;
  /** Default 10 seconds. */
  readonly timeoutMs?: number;
  /** Replaces the global `fetch` (tests). */
  readonly fetch?: typeof fetch;
}

/** "Couldn't load Downhill's sales from <url>: <why>". */
export function remoteError(sample: RemoteSample, why: string): DeskError {
  return new DeskError("sample_unavailable", `Couldn't load ${sample.label} from ${sample.url}: ${why}`, 502);
}

const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const seconds = (ms: number): string => `${ms / 1000} second${ms === 1000 ? "" : "s"}`;

/** Why a connection failed, in plain words: Node's fetch says "fetch failed" and puts the reason in `cause`. */
function failure(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "no such host";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the connection was cut";
  return errorText(cause);
}

/** Fetches a remote sample's file now: within the deadline and the size limit, or an error that says why not. */
export async function fetchSample(sample: RemoteSample, options: FetchOptions): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = AbortSignal.timeout(timeoutMs);
  // The deadline covers the whole download, whatever the fetch implementation does with the signal.
  const deadline = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  deadline.catch(() => undefined);
  const late = () => remoteError(sample, `it didn't answer within ${seconds(timeoutMs)}.`);
  let response: Response;
  try {
    response = await Promise.race([(options.fetch ?? fetch)(sample.url, { headers: { accept: "text/csv" }, signal }), deadline]);
  } catch (error) {
    throw signal.aborted ? late() : remoteError(sample, `nothing answered (${failure(error)}).`);
  }
  const refuse = (why: string): never => {
    response.body?.cancel().catch(() => undefined);
    throw remoteError(sample, why);
  };
  if (!response.ok) refuse(`it answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`);
  if (/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) refuse("it sent a web page, not a CSV file.");
  const tooLarge = `the file is larger than ${size(options.maxBytes)}, the most Data Desk reads.`;
  if (Number(response.headers.get("content-length")) > options.maxBytes) refuse(tooLarge);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) return Buffer.concat(chunks);
      read += value.byteLength;
      if (read > options.maxBytes) throw remoteError(sample, tooLarge);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DeskError) throw error;
    throw signal.aborted ? late() : remoteError(sample, `the download broke off (${failure(error)}).`);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** A remote sample's file as a table with the columns Data Desk expects, or an error that says why it isn't one. */
export function readSample(sample: RemoteSample, bytes: Buffer): Table {
  const text = bytes.toString("utf8");
  if (!text.trim()) throw remoteError(sample, "the file is empty.");
  if (text.includes("\u0000")) throw remoteError(sample, "the file isn't text.");
  let table: Table;
  try {
    table = Table.fromCsv(text);
  } catch (error) {
    const why = error instanceof TableError ? error.message : "the file can't be read as CSV.";
    throw remoteError(sample, why.charAt(0).toLowerCase() + why.slice(1));
  }
  const header = new Set(table.header.map((name) => name.toLowerCase()));
  const missing = sample.columns.filter((column) => !header.has(column.toLowerCase()));
  if (missing.length) throw remoteError(sample, `the file doesn't have the columns Data Desk expects (missing ${missing.join(", ")}).`);
  if (table.rows.length === 0) throw remoteError(sample, "the file has a header but no rows.");
  return table;
}
