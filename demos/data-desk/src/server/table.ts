// Tables from CSV files, and the operations Data Desk's own tools run on them: describe, filter, and aggregate. Pure
// functions, no I/O: the agent reaches them through tools that run in Data Desk's server, wherever its session runs.
import type { ColumnInfo, ColumnType } from "../shared/types.js";

export const MAX_COLUMNS = 100;
export const MAX_ROWS = 100_000;

/** A mistake in a request that the agent (or person) can fix; the message says how. */
export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableError";
  }
}

// Unambiguous: a run of digits can match only one way, so a long one followed by a letter fails in linear time.
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Longer values are text: real numbers and dates are shorter, and type inference stays cheap for any file. */
const MAX_TYPED_LENGTH = 64;

/** The delimiter of the first line: comma, semicolon, or tab, whichever separates the most fields outside quotes. */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  let best = ",";
  for (const [delimiter, count] of counts) if (count > counts.get(best)!) best = delimiter;
  return best;
}

/** Parses CSV text (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF). */
export function parseCsv(input: string): { header: string[]; rows: string[][] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
    if (records.length > MAX_ROWS + 1) throw new TableError(`This file has more than ${MAX_ROWS.toLocaleString("en-US")} rows. Use a smaller file.`);
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === delimiter) endField();
    else if (char === "\n") endRecord();
    else if (char === "\r") {
      if (text[index + 1] === "\n") index++;
      endRecord();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new TableError("The file ends inside a quoted value. Check its quotes.");
  if (field !== "" || record.length > 0) endRecord();
  const [first, ...rest] = records;
  if (!first) throw new TableError("The file is empty.");
  if (first.length > MAX_COLUMNS) throw new TableError(`This file has ${first.length} columns; Data Desk reads up to ${MAX_COLUMNS}.`);
  const header = uniqueNames(first.map((name, index) => name.trim() || `column_${index + 1}`));
  const width = header.length;
  const rows = rest.map((row) => (row.length === width ? row : row.length > width ? row.slice(0, width) : [...row, ...Array<string>(width - row.length).fill("")]));
  return { header, rows };
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), count);
    return count === 1 ? name : `${name}_${count}`;
  });
}

export function inferType(values: readonly string[]): ColumnType {
  let present = 0;
  let numbers = 0;
  let dates = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    present++;
    if (value.length > MAX_TYPED_LENGTH) continue;
    if (NUMBER.test(value)) numbers++;
    else if (DATE.test(value)) dates++;
  }
  if (present === 0) return "text";
  if (numbers === present) return "number";
  if (dates === present) return "date";
  return "text";
}

/** Rounds for people and models: integers stay whole, everything else keeps at most two decimals. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function describeColumn(name: string, values: readonly string[], type: ColumnType): ColumnInfo {
  const present = values.map((value) => value.trim()).filter(Boolean);
  const missing = values.length - present.length;
  if (type === "number") {
    const numbers = present.map(Number);
    const sum = numbers.reduce((total, value) => total + value, 0);
    return {
      name,
      type,
      missing,
      ...(numbers.length
        ? { min: Math.min(...numbers), max: Math.max(...numbers), mean: Number(formatNumber(sum / numbers.length)), sum: Number(formatNumber(sum)) }
        : {}),
    };
  }
  if (type === "date") {
    const sorted = [...present].sort();
    return { name, type, missing, ...(sorted.length ? { min: sorted[0]!, max: sorted.at(-1)! } : {}) };
  }
  const counts = new Map<string, number>();
  for (const value of present) counts.set(value, (counts.get(value) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));
  return { name, type, missing, distinct: counts.size, top };
}

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

export interface Filter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value: string | number;
}

export interface QuerySpec {
  readonly columns?: readonly string[];
  readonly filters?: readonly Filter[];
  readonly sortBy?: string;
  readonly descending?: boolean;
  readonly limit?: number;
}

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export interface Metric {
  readonly fn: AggregateFn;
  /** Every function but `count` needs a number column. */
  readonly column?: string;
}

export interface AggregateSpec {
  readonly groupBy?: readonly string[];
  readonly metrics: readonly Metric[];
  readonly filters?: readonly Filter[];
  /** A group-by column or a metric's label, for example `sum(revenue)`. */
  readonly sortBy?: string;
  readonly descending?: boolean;
  readonly limit?: number;
}

export interface TableResult {
  readonly columns: string[];
  readonly rows: string[][];
  /** Rows or groups that matched, before the limit. */
  readonly total: number;
}

export const metricLabel = (metric: Metric): string => (metric.fn === "count" ? "count" : `${metric.fn}(${metric.column ?? ""})`);

/** A parsed table with typed columns. */
export class Table {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly columns: readonly ColumnInfo[];
  readonly #index: ReadonlyMap<string, number>;

  constructor(header: readonly string[], rows: readonly (readonly string[])[]) {
    this.header = header;
    this.rows = rows;
    this.columns = header.map((name, index) => {
      const values = rows.map((row) => row[index] ?? "");
      return describeColumn(name, values, inferType(values));
    });
    this.#index = new Map(header.map((name, index) => [name.toLowerCase(), index]));
  }

  static fromCsv(text: string): Table {
    const { header, rows } = parseCsv(text);
    return new Table(header, rows);
  }

  /** A column's position; a helpful error naming the real columns when it doesn't exist. */
  column(name: string): number {
    const index = this.#index.get(name.trim().toLowerCase());
    if (index === undefined) throw new TableError(`There's no column "${name}". The columns are: ${this.header.join(", ")}.`);
    return index;
  }

  typeOf(index: number): ColumnType {
    return this.columns[index]!.type;
  }

  #matches(filters: readonly Filter[] = []): (row: readonly string[]) => boolean {
    const tests = filters.map((filter) => {
      const index = this.column(filter.column);
      const type = this.typeOf(index);
      const wanted = String(filter.value).trim();
      if (filter.op === "contains") {
        const needle = wanted.toLowerCase();
        return (row: readonly string[]) => (row[index] ?? "").toLowerCase().includes(needle);
      }
      const numeric = type === "number" && NUMBER.test(wanted);
      if (type === "number" && !numeric && filter.op !== "=" && filter.op !== "!=") {
        throw new TableError(`"${filter.column}" holds numbers; compare it with a number, not "${wanted}".`);
      }
      const compare = (cell: string): number => {
        if (numeric) return Number(cell) - Number(wanted);
        const a = type === "text" ? cell.toLowerCase() : cell;
        const b = type === "text" ? wanted.toLowerCase() : wanted;
        return a < b ? -1 : a > b ? 1 : 0;
      };
      return (row: readonly string[]) => {
        const cell = (row[index] ?? "").trim();
        // An empty value finds the empty cells (=) or the others (!=); it orders nothing.
        if (wanted === "") return filter.op === "=" ? cell === "" : filter.op === "!=" ? cell !== "" : false;
        if (cell === "" || (numeric && !NUMBER.test(cell))) return filter.op === "!=";
        const order = compare(cell);
        switch (filter.op) {
          case "=":
            return order === 0;
          case "!=":
            return order !== 0;
          case ">":
            return order > 0;
          case ">=":
            return order >= 0;
          case "<":
            return order < 0;
          case "<=":
            return order <= 0;
        }
      };
    });
    return (row) => tests.every((test) => test(row));
  }

  /** Rows that match every filter, sorted and limited, with the chosen columns. */
  query(spec: QuerySpec): TableResult {
    const indexes = spec.columns?.length ? spec.columns.map((name) => this.column(name)) : this.header.map((_, index) => index);
    const matched = this.rows.filter(this.#matches(spec.filters));
    if (spec.sortBy) {
      const index = this.column(spec.sortBy);
      const numeric = this.typeOf(index) === "number";
      const direction = spec.descending ? -1 : 1;
      matched.sort((a, b) => direction * compareCells(a[index] ?? "", b[index] ?? "", numeric));
    }
    const limit = clampLimit(spec.limit, 20, 200);
    return {
      columns: indexes.map((index) => this.header[index]!),
      rows: matched.slice(0, limit).map((row) => indexes.map((index) => row[index] ?? "")),
      total: matched.length,
    };
  }

  /** Groups the matching rows and computes each metric per group (one group for the whole table without `groupBy`). */
  aggregate(spec: AggregateSpec): TableResult {
    if (!spec.metrics.length) throw new TableError("Ask for at least one metric, for example count or sum of a number column.");
    const groupBy = (spec.groupBy ?? []).map((name) => this.column(name));
    if (groupBy.length > 3) throw new TableError("Group by at most three columns.");
    const metrics = spec.metrics.map((metric) => {
      if (metric.fn === "count") return { metric, index: undefined };
      if (!metric.column) throw new TableError(`${metric.fn} needs a column.`);
      const index = this.column(metric.column);
      if (this.typeOf(index) !== "number") throw new TableError(`"${this.header[index]}" isn't a number column, so it can't be summed or averaged. Use count, or group by it.`);
      return { metric: { ...metric, column: this.header[index]! }, index };
    });
    const groups = new Map<string, { keys: string[]; count: number; sums: number[]; mins: number[]; maxes: number[]; counts: number[] }>();
    for (const row of this.rows.filter(this.#matches(spec.filters))) {
      const keys = groupBy.map((index) => (row[index] ?? "").trim());
      const key = JSON.stringify(keys);
      let group = groups.get(key);
      if (!group) {
        group = { keys, count: 0, sums: metrics.map(() => 0), mins: metrics.map(() => Infinity), maxes: metrics.map(() => -Infinity), counts: metrics.map(() => 0) };
        groups.set(key, group);
      }
      group.count++;
      metrics.forEach(({ index }, position) => {
        if (index === undefined) return;
        const cell = (row[index] ?? "").trim();
        if (!cell) return;
        const value = Number(cell);
        group.sums[position]! += value;
        group.counts[position]! += 1;
        group.mins[position] = Math.min(group.mins[position]!, value);
        group.maxes[position] = Math.max(group.maxes[position]!, value);
      });
    }
    const labels = metrics.map(({ metric }) => metricLabel(metric));
    const columns = [...groupBy.map((index) => this.header[index]!), ...labels];
    let rows = [...groups.values()].map((group) => [
      ...group.keys,
      ...metrics.map(({ metric }, position) => {
        if (metric.fn === "count") return String(group.count);
        const n = group.counts[position]!;
        if (n === 0) return "";
        if (metric.fn === "sum") return formatNumber(group.sums[position]!);
        if (metric.fn === "avg") return formatNumber(group.sums[position]! / n);
        return formatNumber(metric.fn === "min" ? group.mins[position]! : group.maxes[position]!);
      }),
    ]);
    const sortBy = spec.sortBy ?? (groupBy.length ? this.header[groupBy[0]!] : undefined);
    if (sortBy) {
      const position = columns.findIndex((column) => column.toLowerCase() === sortBy.trim().toLowerCase());
      if (position < 0) throw new TableError(`Sort by one of: ${columns.join(", ")}.`);
      const numeric = position >= groupBy.length || this.typeOf(groupBy[position]!) === "number";
      const direction = spec.descending ? -1 : 1;
      rows = rows.sort((a, b) => direction * compareCells(a[position] ?? "", b[position] ?? "", numeric));
    }
    const limit = clampLimit(spec.limit, 50, 500);
    return { columns, rows: rows.slice(0, limit), total: rows.length };
  }
}

function compareCells(a: string, b: string, numeric: boolean): number {
  if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
  if (numeric) return Number(a) - Number(b);
  return a.localeCompare(b, "en", { numeric: true });
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}
