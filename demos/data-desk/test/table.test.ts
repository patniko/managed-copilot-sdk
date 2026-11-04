import { describe, expect, it } from "vitest";
import { formatNumber, inferType, parseCsv, Table, TableError } from "../src/server/table.js";

const SALES = "month,store,units,revenue\n2025-01,Downtown,10,32.5\n2025-01,Harbor,4,13\n2025-02,Downtown,12,39\n2025-02,Harbor,,20\n2025-03,Campus,7,22.75\n";

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, line breaks inside quotes, CRLF, and a byte order mark", () => {
    const parsed = parseCsv('\uFEFFname,note\r\n"Smith, Jo","said ""hi""\nand left"\r\nLee,plain\r\n');
    expect(parsed.header).toEqual(["name", "note"]);
    expect(parsed.rows).toEqual([
      ["Smith, Jo", 'said "hi"\nand left'],
      ["Lee", "plain"],
    ]);
  });

  it("detects semicolon and tab delimiters, and evens out ragged rows", () => {
    expect(parseCsv("a;b;c\n1;2\n3;4;5;6\n").rows).toEqual([
      ["1", "2", ""],
      ["3", "4", "5"],
    ]);
    expect(parseCsv("a\tb\n1\t2\n").rows).toEqual([["1", "2"]]);
  });

  it("names empty and repeated headers, and skips blank lines", () => {
    expect(parseCsv("x,,x,X\n\n1,2,3,4\n").header).toEqual(["x", "column_2", "x_2", "X_3"]);
  });

  it("refuses files it can't read", () => {
    expect(() => parseCsv("")).toThrow(TableError);
    expect(() => parseCsv('a,b\n"open,1\n')).toThrow(/quoted value/);
  });
});

describe("columns", () => {
  it("infers numbers, dates, and text", () => {
    expect(inferType(["1", "-2.5", "", "3e2"])).toBe("number");
    expect(inferType(["2025-01", "2025-02-03", "2025-02-03T10:00:00Z"])).toBe("date");
    expect(inferType(["1", "two"])).toBe("text");
    expect(inferType(["", " "])).toBe("text");
    expect(inferType(["1".repeat(64)])).toBe("number");
    expect(inferType(["1".repeat(65)])).toBe("text");
  });

  it("reads a huge number-like value quickly, as text", () => {
    // 100,000 digits and a letter used to make the number check backtrack for 12 seconds.
    const digits = "1".repeat(100_000);
    const started = performance.now();
    const table = Table.fromCsv(`id,value\n1,${digits}x\n2,${digits}\n`);
    expect(table.columns.map((column) => column.type)).toEqual(["number", "text"]);
    expect(() => table.query({ filters: [{ column: "id", op: ">", value: `${digits}x` }] })).toThrow(/holds numbers/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("summarizes each column by its type", () => {
    const table = Table.fromCsv(SALES);
    const [month, store, units, revenue] = table.columns;
    expect(month).toEqual({ name: "month", type: "date", missing: 0, min: "2025-01", max: "2025-03" });
    expect(store).toMatchObject({ type: "text", distinct: 3, top: [{ value: "Downtown", count: 2 }, { value: "Harbor", count: 2 }, { value: "Campus", count: 1 }] });
    expect(units).toMatchObject({ type: "number", missing: 1, min: 4, max: 12, sum: 33, mean: 8.25 });
    expect(revenue).toMatchObject({ type: "number", sum: 127.25 });
  });

  it("formats numbers for people and models", () => {
    expect(formatNumber(3)).toBe("3");
    expect(formatNumber(2 / 3)).toBe("0.67");
    expect(formatNumber(Number.NaN)).toBe("");
  });
});

describe("query", () => {
  const table = Table.fromCsv(SALES);

  it("filters, sorts, picks columns, and limits", () => {
    const result = table.query({ columns: ["store", "revenue"], filters: [{ column: "revenue", op: ">", value: 15 }], sortBy: "revenue", descending: true, limit: 2 });
    expect(result).toEqual({
      columns: ["store", "revenue"],
      rows: [
        ["Downtown", "39"],
        ["Downtown", "32.5"],
      ],
      total: 4,
    });
  });

  it("compares text without case, dates in order, and finds empty cells", () => {
    expect(table.query({ filters: [{ column: "STORE", op: "=", value: "harbor" }] }).total).toBe(2);
    expect(table.query({ filters: [{ column: "month", op: ">=", value: "2025-02" }] }).total).toBe(3);
    expect(table.query({ filters: [{ column: "units", op: "=", value: "" }] }).rows).toEqual([["2025-02", "Harbor", "", "20"]]);
    expect(table.query({ filters: [{ column: "store", op: "contains", value: "town" }] }).total).toBe(2);
  });

  it("explains mistakes the agent can fix", () => {
    expect(() => table.query({ filters: [{ column: "region", op: "=", value: "West" }] })).toThrow(/no column "region".*month, store, units, revenue/);
    expect(() => table.query({ filters: [{ column: "units", op: ">", value: "many" }] })).toThrow(/holds numbers/);
  });
});

describe("aggregate", () => {
  const table = Table.fromCsv(SALES);

  it("groups and computes metrics, sorted by a metric", () => {
    const result = table.aggregate({ groupBy: ["store"], metrics: [{ fn: "sum", column: "revenue" }, { fn: "count" }, { fn: "avg", column: "units" }], sortBy: "sum(revenue)", descending: true });
    expect(result.columns).toEqual(["store", "sum(revenue)", "count", "avg(units)"]);
    expect(result.rows).toEqual([
      ["Downtown", "71.5", "2", "11"],
      ["Harbor", "33", "2", "4"],
      ["Campus", "22.75", "1", "7"],
    ]);
    expect(result.total).toBe(3);
  });

  it("totals the whole table without a group, and counts only filtered rows", () => {
    expect(table.aggregate({ metrics: [{ fn: "max", column: "units" }, { fn: "min", column: "revenue" }] }).rows).toEqual([["12", "13"]]);
    expect(table.aggregate({ groupBy: ["month"], metrics: [{ fn: "count" }], filters: [{ column: "store", op: "!=", value: "Campus" }] }).rows).toEqual([
      ["2025-01", "2"],
      ["2025-02", "2"],
    ]);
  });

  it("refuses metrics that don't fit the column", () => {
    expect(() => table.aggregate({ metrics: [] })).toThrow(/at least one metric/);
    expect(() => table.aggregate({ metrics: [{ fn: "sum", column: "store" }] })).toThrow(/isn't a number column/);
    expect(() => table.aggregate({ metrics: [{ fn: "avg" }] })).toThrow(/needs a column/);
    expect(() => table.aggregate({ groupBy: ["store"], metrics: [{ fn: "count" }], sortBy: "nope" })).toThrow(/Sort by one of/);
  });
});
