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

describe("the storefront checkout funnel", () => {
  const datasets = new Datasets(samples, mkdtempSync(join(tmpdir(), "desk-")), 1024 * 1024);
  datasets.load();
  const funnel = datasets.require("sample-checkout-funnel");
  const table = funnel.table();
  const BANDS = ["under $25", "$25–$39", "$40–$49", "$50–$74", "$75+"];
  /** reached_payment / reached_shipping for each device and cart value, with Data Desk's own aggregate tool. */
  const shippingStep = (filters: { column: string; op: "="; value: string }[] = []) => {
    const { rows } = table.aggregate({ groupBy: ["device", "cart_value"], metrics: [{ fn: "sum", column: "reached_shipping" }, { fn: "sum", column: "reached_payment" }], filters });
    return (device: string, band: string): number => {
      const row = rows.find((candidate) => candidate[0] === device && candidate[1] === band)!;
      return Number(row[3]) / Number(row[2]);
    };
  };

  it("has 12 weeks of checkouts for three devices and five cart values, with counts that add up", () => {
    expect(funnel.summary).toMatchObject({ name: "Storefront checkout funnel", fileName: "checkout-funnel.csv", rows: 180 });
    expect(funnel.summary.columns).toEqual([
      { name: "week", type: "date" },
      { name: "device", type: "text" },
      { name: "cart_value", type: "text" },
      { name: "free_shipping", type: "text" },
      { name: "checkouts", type: "number" },
      { name: "reached_shipping", type: "number" },
      { name: "reached_payment", type: "number" },
      { name: "orders", type: "number" },
      { name: "revenue", type: "number" },
      { name: "conversion", type: "number" },
    ]);
    const weeks = [...new Set(table.rows.map((row) => row[0]!))];
    expect(weeks).toHaveLength(12);
    expect([weeks[0], weeks.at(-1)]).toEqual(["2025-07-07", "2025-09-22"]);
    expect(weeks.every((week) => new Date(`${week}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect([...new Set(table.rows.map((row) => row[1]))].sort()).toEqual(["desktop", "mobile", "tablet"]);
    expect([...new Set(table.rows.map((row) => row[2]))]).toEqual(BANDS);
    for (const row of table.rows) {
      const [checkouts, shipping, payment, orders, revenue, conversion] = row.slice(4).map(Number) as [number, number, number, number, number, number];
      // Free shipping starts at $50.
      expect(row[3]).toBe(row[2] === "$50–$74" || row[2] === "$75+" ? "yes" : "no");
      expect(checkouts >= shipping && shipping >= payment && payment >= orders && orders > 0).toBe(true);
      expect(conversion).toBeCloseTo(orders / checkouts, 3);
      const [low, high] = [[5, 25], [25, 40], [40, 50], [50, 75], [75, 250]][BANDS.indexOf(row[2]!)]!;
      expect(revenue / orders).toBeGreaterThan(low!);
      expect(revenue / orders).toBeLessThan(high!);
    }
  });

  it("shows mobile carts just under free shipping dropping out at the shipping step, week after week", () => {
    const ratio = shippingStep();
    expect(ratio("mobile", "$40–$49")).toBeGreaterThanOrEqual(0.45);
    expect(ratio("mobile", "$40–$49")).toBeLessThanOrEqual(0.5);
    expect(ratio("desktop", "$40–$49")).toBeCloseTo(0.8, 1);
    expect(ratio("mobile", "$50–$74")).toBeCloseTo(0.85, 1);
    for (const band of ["under $25", "$25–$39"]) {
      expect(ratio("mobile", band)).toBeGreaterThan(0.63);
      expect(ratio("mobile", band)).toBeLessThan(0.72);
    }
    // The clear outlier: every other group keeps at least 15 points more of its shoppers.
    const others = ["desktop", "mobile", "tablet"].flatMap((device) => BANDS.filter((band) => device !== "mobile" || band !== "$40–$49").map((band) => ratio(device, band)));
    expect(Math.min(...others) - ratio("mobile", "$40–$49")).toBeGreaterThan(0.15);
    for (const week of new Set(table.rows.map((row) => row[0]!))) {
      const weekly = shippingStep([{ column: "week", op: "=", value: week }])("mobile", "$40–$49");
      expect(weekly).toBeGreaterThanOrEqual(0.45);
      expect(weekly).toBeLessThanOrEqual(0.5);
    }
  });

  it("converts best on desktop and worst on mobile, which has the most checkouts", () => {
    const { rows } = table.aggregate({ groupBy: ["device"], metrics: [{ fn: "sum", column: "checkouts" }, { fn: "sum", column: "orders" }] });
    const device = (name: string) => rows.find((row) => row[0] === name)!.slice(1).map(Number) as [number, number];
    const conversion = (name: string) => device(name)[1] / device(name)[0];
    expect(conversion("desktop")).toBeCloseTo(0.55, 1);
    expect(conversion("tablet")).toBeCloseTo(0.45, 1);
    expect(conversion("mobile")).toBeCloseTo(0.38, 1);
    expect(device("mobile")[0]).toBeGreaterThan(Math.max(device("desktop")[0], device("tablet")[0]));
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
