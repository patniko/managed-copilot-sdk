import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "../src/shared/types.js";
import { loadConfig } from "../src/server/config.js";
import { Datasets, displayName, sandboxFileName, SAMPLES, suggestPrompts, type Dataset, type DatasetsOptions } from "../src/server/datasets.js";
import { DOWNHILL_SALES_COLUMNS, downhillSales, remoteSamples } from "../src/server/remote.js";
import { Table } from "../src/server/table.js";
import { dataTools, systemMessage } from "../src/server/tools.js";
import { csvResponse, DOWNHILL_SALES, fakeDownhill, PACKAGE_ROOT } from "./fakes.js";

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

describe("Downhill's bundled data", () => {
  const datasets = new Datasets(samples, mkdtempSync(join(tmpdir(), "desk-")), 1024 * 1024);
  datasets.load();
  const COURSES = ["Citadel Coast", "Sunset Mesa", "Alpine Peaks", "Dreamscape", "Dune Coast", "Sunset Blocks"];
  /** One metric per group, with Data Desk's own aggregate tool, as the agent would ask for it. */
  const metric = (dataset: Dataset, groupBy: string[], metrics: { fn: "sum" | "avg" | "count"; column?: string }[], filters: { column: string; op: "=" | ">=" | "<"; value: string | number }[] = []) => {
    const { rows } = dataset.table().aggregate({ groupBy, metrics, filters });
    return (...key: string[]): number[] => rows.find((row) => key.every((value, index) => row[index] === value))!.slice(key.length).map(Number);
  };

  it("has six weeks of beta runs for every course, where Dune Coast crashes the most from build 0.9.4", () => {
    const runs = datasets.require("sample-downhill-runs");
    expect(runs.summary).toMatchObject({ name: "Downhill beta runs", fileName: "downhill-beta-runs.csv", rows: 252 });
    const table = runs.table();
    expect([...new Set(table.rows.map((row) => row[3]))]).toEqual(COURSES);
    expect([...new Set(table.rows.map((row) => row[2]))]).toEqual(["0.9.1", "0.9.2", "0.9.3", "0.9.4", "0.9.5", "0.9.6"]);
    for (const row of table.rows) {
      const [players, total, finished, crashes] = row.slice(4, 8).map(Number) as [number, number, number, number];
      expect(players > 0 && total > players && finished <= total && crashes < total).toBe(true);
    }
    const rate = (...key: string[]) => {
      const [crashes, total] = metric(runs, key.length === 1 ? ["course"] : ["course", "week"], [{ fn: "sum", column: "crashes" }, { fn: "sum", column: "runs" }])(...key);
      return crashes! / total!;
    };
    const others = COURSES.filter((course) => course !== "Dune Coast").map((course) => rate(course));
    expect(rate("Dune Coast") - Math.max(...others)).toBeGreaterThan(0.05);
    for (const week of ["1", "2", "3"]) expect(rate("Dune Coast", week)).toBeCloseTo(0.2, 1);
    for (const week of ["4", "5", "6"]) expect(rate("Dune Coast", week)).toBeGreaterThan(0.4);
    for (const week of ["1", "6"]) expect(rate("Sunset Blocks", week)).toBeCloseTo(0.26, 1);
  });

  it("shows Auto running like High on integrated graphics, with first-minute quits to match", () => {
    const frameRate = datasets.require("sample-downhill-frame-rate");
    expect(frameRate.summary).toMatchObject({ name: "Downhill beta frame rate", fileName: "downhill-beta-frame-rate.csv", rows: 90 });
    const integrated = metric(frameRate, ["quality"], [{ fn: "avg", column: "median_fps" }, { fn: "avg", column: "first_minute_quit_rate" }], [{ column: "gpu", op: "=", value: "integrated" }]);
    const [auto, autoQuits] = integrated("Auto") as [number, number];
    expect(auto).toBeLessThan(30);
    expect(Math.abs(auto - integrated("High")[0]!)).toBeLessThan(3);
    expect(integrated("Low")[0]).toBeGreaterThan(50);
    expect(integrated("Medium")[0]).toBeGreaterThan(40);
    expect(autoQuits).toBeGreaterThan(2 * Math.max(integrated("Low")[1]!, integrated("Medium")[1]!));
    // On faster graphics, Auto's lower render scale is enough.
    const faster = metric(frameRate, ["gpu", "quality"], [{ fn: "avg", column: "median_fps" }]);
    expect(faster("mid-range", "Auto")[0]).toBeGreaterThan(55);
    expect(faster("high-end", "Auto")[0]).toBe(60);
    // Auto is the default, so most sessions use it.
    const sessions = metric(frameRate, ["quality"], [{ fn: "sum", column: "sessions" }]);
    expect(sessions("Auto")[0]).toBeGreaterThan(["Low", "Medium", "High", "Ultra"].reduce((sum, quality) => sum + sessions(quality)[0]!, 0));
  });

  it("has launch day's support tickets so far, where the launch code's rejections surge once the banner goes live", () => {
    const tickets = datasets.require("sample-downhill-tickets");
    expect(tickets.summary).toMatchObject({ name: "Downhill support tickets", fileName: "downhill-support-tickets.csv" });
    const table = tickets.table();
    expect(table.rows.every((row) => Number(row[1]) >= 0 && Number(row[1]) < 180)).toBe(true);
    // Open tickets have no resolution time or score yet.
    expect(table.rows.every((row) => (row[6] === "open") === (row[7] === "" && row[8] === ""))).toBe(true);
    const promo = (filters: { column: string; op: ">=" | "<"; value: number }[]) => metric(tickets, ["topic"], [{ fn: "count" }], filters)("Promo code rejected")[0]!;
    const before = promo([{ column: "minutes_since_launch", op: "<", value: 135 }]);
    const after = promo([{ column: "minutes_since_launch", op: ">=", value: 135 }]);
    expect(after).toBeGreaterThan(5 * before);
    const { rows } = table.aggregate({ groupBy: ["topic"], metrics: [{ fn: "avg", column: "minutes_to_resolve" }, { fn: "avg", column: "csat" }], sortBy: "avg(minutes_to_resolve)", descending: true });
    expect(rows[0]![0]).toBe("Promo code rejected");
    expect(Math.min(...rows.map((row) => Number(row[2])))).toBe(Number(rows[0]![2]));
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
    const sample = datasets.require("sample-downhill-runs");
    expect(sample.table()).toBe(sample.table());
  });
});

describe("Downhill's shop sales, live", () => {
  const SAMPLE = downhillSales("http://downhill.test");
  const SALES_URL = "http://downhill.test/api/sales.csv";
  const ROWS = DOWNHILL_SALES.trim().split("\n").length - 1;

  function live(fetch: typeof globalThis.fetch, maxBytes = 64 * 1024, options: DatasetsOptions = {}, dataDir = mkdtempSync(join(tmpdir(), "desk-"))) {
    const datasets = new Datasets(samples, dataDir, maxBytes, { remote: [SAMPLE], fetch, ...options });
    datasets.load();
    return datasets;
  }

  /** Runs one of an analysis's tools on a dataset, as the runtime does. */
  async function call(dataset: Dataset, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = dataTools({ dataset }).find((candidate) => candidate.name === name)!;
    return (await tool.handler!(args, { sessionId: "s", toolCallId: "c", toolName: name, arguments: args })) as Record<string, unknown>;
  }

  it("is offered only when DOWNHILL_URL is set", () => {
    expect(remoteSamples(loadConfig({}))).toEqual([]);
    expect(remoteSamples(loadConfig({ DOWNHILL_URL: "downhill" }))).toEqual([]);
    expect(remoteSamples(loadConfig({ DOWNHILL_URL: " http://localhost:7455/ " })).map((sample) => sample.url)).toEqual(["http://localhost:7455/api/sales.csv"]);
    expect(live(fakeDownhill().fetch).remoteSamples()).toEqual([{ id: "live-downhill-sales", name: "Downhill shop sales", description: "Live from Downhill's shop, since launch" }]);
    expect(new Datasets(samples, mkdtempSync(join(tmpdir(), "desk-")), 1024).remoteSamples()).toEqual([]);
  });

  it("fetches a fresh copy each time it's picked; an analysis keeps the copy it started with", async () => {
    // After the fix is deployed, the banner's code works.
    const fixed = `${DOWNHILL_SALES}2026-11-18 10:41:05,221,purchase,DH-21760,Neon Mona,outfit,4.99,trail15,applied,0.75,4.24,Mateo R.,simulated\n`;
    const downhill = fakeDownhill((call) => csvResponse(call === 1 ? DOWNHILL_SALES : fixed));
    const datasets = live(downhill.fetch);
    const before = await datasets.open("live-downhill-sales");
    const after = await datasets.open("live-downhill-sales");
    expect(downhill.calls).toEqual([SALES_URL, SALES_URL]);
    expect(after.summary.id).not.toBe(before.summary.id);
    expect([before.summary.rows, after.summary.rows]).toEqual([ROWS, ROWS + 1]);
    expect(after.table().rows.at(-1)).toEqual(expect.arrayContaining(["trail15", "applied"]));
    expect(before.table().rows).toHaveLength(ROWS);
    // The picker keeps offering the sample rather than its copies.
    expect(datasets.list().map((dataset) => dataset.id)).toEqual(SAMPLES.map((sample) => sample.id));
  });

  it("becomes a dataset the way an upload does: the export's rows and columns, its prompts, and notes for the agent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const copy = await live(fakeDownhill().fetch, 64 * 1024, {}, dataDir).open("live-downhill-sales");
    expect(copy.summary).toMatchObject({ name: "Downhill shop sales", fileName: "downhill-sales.csv", sample: false, rows: ROWS, bytes: Buffer.byteLength(DOWNHILL_SALES) });
    expect(copy.summary.description).toMatch(/^Downhill's sales as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(copy.summary.columns).toEqual([
      { name: "time", type: "date" },
      { name: "minutes_since_launch", type: "number" },
      { name: "event", type: "text" },
      { name: "order_id", type: "text" },
      { name: "item", type: "text" },
      { name: "kind", type: "text" },
      { name: "price_usd", type: "number" },
      { name: "promo_code", type: "text" },
      { name: "promo_result", type: "text" },
      { name: "discount_usd", type: "number" },
      { name: "total_usd", type: "number" },
      { name: "player", type: "text" },
      { name: "source", type: "text" },
    ]);
    expect(copy.summary.prompts.map((prompt) => prompt.needs)).toEqual(["tools", "code"]);
    expect(copy.bytes().toString("utf8")).toBe(DOWNHILL_SALES);
    expect(systemMessage(copy)).toContain("- About the data: Each row is a checkout in Downhill's in-game shop");

    // Still there for its analysis after a restart, even without DOWNHILL_URL.
    const restarted = new Datasets(samples, dataDir, 64 * 1024);
    restarted.load();
    expect(restarted.get(copy.summary.id)?.summary).toEqual(copy.summary);
    expect(restarted.get(copy.summary.id)?.notes).toBe(copy.notes);
    expect(restarted.list().map((dataset) => dataset.id)).not.toContain(copy.summary.id);
  });

  it("answers its first prompt with Data Desk's own tools: the codes rejected in the last hour, newest first", async () => {
    const copy = await live(fakeDownhill().fetch).open("live-downhill-sales");
    // The agent reads the newest row's minute from the description, then filters the hour before it.
    const described = (await call(copy, "describe_dataset", {})) as { columns: ColumnInfo[] };
    const newest = Number(described.columns.find((column) => column.name === "minutes_since_launch")!.max);
    expect(newest).toBe(203);
    const filters = [
      { column: "promo_result", op: "=", value: "rejected" },
      { column: "minutes_since_launch", op: ">=", value: newest - 60 },
    ];
    const listed = (await call(copy, "query_rows", { title: "Promo codes rejected in the last hour", filters, sortBy: "time", descending: true })) as { matched: number; columns: string[]; rows: string[][] };
    expect(listed.matched).toBe(17);
    // Your own failed sale tops the list: the newest live row.
    const newestRow = Object.fromEntries(listed.columns.map((column, index) => [column, listed.rows[0]![index]]));
    expect(newestRow).toMatchObject({ event: "promo_rejected", promo_code: "trail15", player: "presenter", source: "live" });
    const codes = (await call(copy, "aggregate", { title: "Rejected codes", groupBy: ["promo_code"], metrics: [{ fn: "count" }], filters })) as { rows: string[][] };
    expect(codes.rows).toEqual([["trail15", "17"]]);
  });

  it.each([
    ["it answers with an error", () => csvResponse("Busy", { status: 503, statusText: "Service Unavailable" }), "it answered HTTP 503 Service Unavailable."],
    [
      "nothing answers",
      () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7455"), { code: "ECONNREFUSED" }) })),
      "nothing answered (connection refused).",
    ],
    ["it sends a web page", () => new Response("<!doctype html><title>Downhill</title>", { headers: { "content-type": "text/html; charset=utf-8" } }), "it sent a web page, not a CSV file."],
    ["it sends another file", () => csvResponse("time,event\n2026-11-18 07:01:52,purchase\n"), `the file doesn't have the columns Data Desk expects (missing ${DOWNHILL_SALES_COLUMNS.filter((column) => column !== "time" && column !== "event").join(", ")}).`],
    ["it has no sales yet", () => csvResponse(`${DOWNHILL_SALES_COLUMNS.join(",")}\n`), "the file has a header but no rows."],
  ])("says why in plain words, and keeps nothing, when %s", async (_, answer, why) => {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const datasets = live(fakeDownhill(answer).fetch, 64 * 1024, {}, dataDir);
    await expect(datasets.open("live-downhill-sales")).rejects.toMatchObject({ code: "sample_unavailable", status: 502, message: `Couldn't load Downhill's sales from ${SALES_URL}: ${why}` });
    expect(readdirSync(join(dataDir, "uploads"))).toEqual([]);
  });

  it("refuses a file larger than the upload limit", async () => {
    const tooLarge = `Couldn't load Downhill's sales from ${SALES_URL}: the file is larger than 4 KB, the most Data Desk reads.`;
    // Read up to the limit, whether or not the server says how large the file is.
    await expect(live(fakeDownhill().fetch, 4 * 1024).open("live-downhill-sales")).rejects.toThrow(tooLarge);
    const declared = fakeDownhill(() => csvResponse(DOWNHILL_SALES, { headers: { "content-length": String(5 * 1024 * 1024) } }));
    await expect(live(declared.fetch, 4 * 1024).open("live-downhill-sales")).rejects.toThrow(tooLarge);
  });

  it("gives up after its deadline, before an answer or partway through the file", async () => {
    const late = `Couldn't load Downhill's sales from ${SALES_URL}: it didn't answer within 0.05 seconds.`;
    const silent = fakeDownhill(() => new Promise<Response>(() => undefined));
    await expect(live(silent.fetch, 64 * 1024, { fetchTimeoutMs: 50 }).open("live-downhill-sales")).rejects.toThrow(late);
    const stalled = fakeDownhill(() => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("time,")) })));
    await expect(live(stalled.fetch, 64 * 1024, { fetchTimeoutMs: 50 }).open("live-downhill-sales")).rejects.toThrow(late);
  });
});
