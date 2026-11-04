import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Datasets, displayName, sandboxFileName, SAMPLES, suggestPrompts, type Dataset } from "../src/server/datasets.js";
import { Table } from "../src/server/table.js";
import { PACKAGE_ROOT } from "./fakes.js";

const samples = join(PACKAGE_ROOT, "datasets");

describe("datasets", () => {
  it("loads every bundled sample with a question for the tools and one that needs code", () => {
    const datasets = new Datasets(samples, mkdtempSync(join(tmpdir(), "desk-")), 1024 * 1024);
    datasets.load();
    const list = datasets.list();
    expect(list.map((dataset) => dataset.id)).toEqual(SAMPLES.map((sample) => sample.id));
    for (const dataset of list) {
      expect(dataset.rows).toBeGreaterThan(50);
      expect(dataset.columns.some((column) => column.type === "number")).toBe(true);
      expect(dataset.prompts.map((prompt) => prompt.needs)).toEqual(["tools", "code"]);
      expect(dataset.description!.length).toBeLessThanOrEqual(40);
    }
  });

  it("keeps uploads across restarts, once per file content", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const first = new Datasets(samples, dataDir, 1024 * 1024);
    first.load();
    const added = first.add("Q3 Sales (final).csv", Buffer.from("region,revenue\nWest,10\nEast,12\n"));
    expect(added.summary).toMatchObject({ name: "Q3 Sales (final)", fileName: "q3-sales-final.csv", sample: false, rows: 2 });
    expect(added.summary.columns).toEqual([
      { name: "region", type: "text" },
      { name: "revenue", type: "number" },
    ]);
    expect(first.add("again.csv", Buffer.from("region,revenue\nWest,10\nEast,12\n")).summary.id).toBe(added.summary.id);
    expect(readdirSync(join(dataDir, "uploads")).sort()).toEqual([`${added.summary.id}.csv`, `${added.summary.id}.json`]);

    const second = new Datasets(samples, dataDir, 1024 * 1024);
    second.load();
    expect(second.get(added.summary.id)?.summary.name).toBe("Q3 Sales (final)");
    expect(second.list().at(-1)?.id).toBe(added.summary.id);
  });

  it("refuses files it can't use, in plain words", () => {
    const datasets = new Datasets(samples, mkdtempSync(join(tmpdir(), "desk-")), 64);
    expect(() => datasets.add("empty.csv", Buffer.alloc(0))).toThrow(/empty/);
    expect(() => datasets.add("big.csv", Buffer.alloc(65, "a"))).toThrow(/up to/);
    expect(() => datasets.add("header.csv", Buffer.from("a,b\n"))).toThrow(/no rows/);
    expect(() => datasets.add("binary.csv", Buffer.from("a\u0000b"))).toThrow(/text file/);
    expect(() => datasets.require("missing")).toThrow(/isn't available/);
  });

  it("names files for the sandbox and for people", () => {
    expect(sandboxFileName("My Sales (Q3).CSV")).toBe("my-sales-q3.csv");
    expect(sandboxFileName("...")).toBe("data.csv");
    expect(displayName("q3_sales-by-region.csv")).toBe("Q3 sales by region");
  });

  it("names files quickly however long the name is", () => {
    // A 16,000-character name of dashes used to take 0.3 s to clean up; names are cut to 255 characters first.
    const long = `a${"-".repeat(16_000)}b.csv`;
    const started = performance.now();
    expect(sandboxFileName(long)).toBe("a.csv");
    expect(displayName(long)).toBe("A");
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("suggests starting questions from an upload's columns", () => {
    const columns = (csv: string) => Table.fromCsv(csv).columns;
    expect(suggestPrompts(columns("date,region,sales\n2025-01-01,West,3\n2025-01-02,East,4\n"))).toEqual([
      { text: "What's the total sales by region?", needs: "tools" },
      { text: "Chart sales over date", needs: "code" },
    ]);
    expect(suggestPrompts(columns("height,weight\n1,2\n3,4\n"))[1]).toEqual({ text: "Plot height against weight with a trend line", needs: "code" });
    expect(suggestPrompts(columns("name\nAda\n"))).toEqual([
      { text: "Describe this dataset", needs: "tools" },
      { text: "Chart the most interesting column", needs: "code" },
    ]);
  });
});

describe("uploads", () => {
  let minute = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Uploads a 16-byte file a minute after the previous upload. */
  function upload(datasets: Datasets, label: string): Dataset {
    vi.setSystemTime(Date.parse("2026-11-04T10:00:00Z") + ++minute * 60_000);
    return datasets.add(`${label}.csv`, Buffer.from(`name,value\n${label},1\n`));
  }

  const names = (datasets: Datasets) => datasets.list().flatMap((dataset) => (dataset.sample ? [] : [dataset.name]));
  const files = (...kept: Dataset[]) => kept.flatMap((dataset) => [`${dataset.summary.id}.csv`, `${dataset.summary.id}.json`]).sort();

  it("keep the newest: another one drops the oldest, files included", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const datasets = new Datasets(samples, dataDir, 1024, { maxUploads: 2 });
    datasets.load();
    const aa = upload(datasets, "aa");
    const bb = upload(datasets, "bb");
    const cc = upload(datasets, "cc");
    expect(names(datasets)).toEqual(["Cc", "Bb"]);
    expect(readdirSync(join(dataDir, "uploads")).sort()).toEqual(files(bb, cc));
    expect(datasets.get(aa.summary.id)).toBeUndefined();
    expect(() => datasets.require(aa.summary.id)).toThrow(/isn't available/);
    // An analysis still holding the dropped one hears the same.
    expect(() => aa.table()).toThrow(/isn't available/);
    expect(() => aa.bytes()).toThrow(/isn't available/);
  });

  it("fit a total size, and a file uploaded again counts as the newest", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const datasets = new Datasets(samples, dataDir, 1024, { maxStoredBytes: 40 });
    datasets.load();
    upload(datasets, "aa");
    upload(datasets, "bb");
    upload(datasets, "aa");
    upload(datasets, "cc");
    expect(names(datasets)).toEqual(["Cc", "Aa"]);
    const restarted = new Datasets(samples, dataDir, 1024, { maxStoredBytes: 40 });
    restarted.load();
    expect(names(restarted)).toEqual(["Cc", "Aa"]);
  });

  it("are limited again when Data Desk starts, and leftovers are removed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const before = new Datasets(samples, dataDir, 1024);
    before.load();
    const aa = upload(before, "aa");
    const bb = upload(before, "bb");
    const cc = upload(before, "cc");
    const folder = join(dataDir, "uploads");
    writeFileSync(join(folder, `${aa.summary.id}.json.tmp`), "{");
    writeFileSync(join(folder, "upload-0123456789abcdef.csv"), "name\nlost\n");
    writeFileSync(join(folder, "upload-fedcba9876543210.json"), "not json");
    writeFileSync(join(folder, "notes.txt"), "someone else's");
    const after = new Datasets(samples, dataDir, 1024, { maxUploads: 2 });
    after.load();
    expect(names(after)).toEqual(["Cc", "Bb"]);
    expect(readdirSync(folder).sort()).toEqual([...files(bb, cc), "notes.txt"].sort());
  });

  it("stay parsed a few at a time, and are read again when used", () => {
    const datasets = new Datasets(samples, mkdtempSync(join(tmpdir(), "desk-")), 1024, { maxParsedBytes: 20 });
    datasets.load();
    const aa = upload(datasets, "aa");
    const bb = upload(datasets, "bb");
    const parsed = bb.table();
    expect(bb.table()).toBe(parsed);
    expect(aa.table().rows).toEqual([["aa", "1"]]);
    expect(bb.table()).not.toBe(parsed);
    expect(bb.table().rows).toEqual([["bb", "1"]]);
    expect(aa.bytes().toString("utf8")).toBe("name,value\naa,1\n");
    const sample = datasets.require("sample-coffee-sales");
    expect(sample.table()).toBe(sample.table());
  });
});
