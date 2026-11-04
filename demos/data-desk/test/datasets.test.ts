import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datasets, displayName, sandboxFileName, SAMPLES, suggestPrompts } from "../src/server/datasets.js";
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
