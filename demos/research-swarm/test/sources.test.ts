import { describe, expect, it } from "vitest";
import { buildReport, checkDraft, citedNumbers, cleanTitle, parsePages, reportMarkdown, SourceRegistry } from "../src/server/sources.js";
import type { Run } from "../src/shared/types.js";

const log = (entries: readonly unknown[]) => entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n");

describe("page titles", () => {
  it("drops the site's name and arXiv IDs, keeping the page's own words", () => {
    expect(cleanTitle("WebAssembly - Wikipedia", "https://en.wikipedia.org/wiki/WebAssembly")).toBe("WebAssembly");
    expect(cleanTitle("WebAssembly | MDN", "https://developer.mozilla.org/en-US/docs/WebAssembly")).toBe("WebAssembly");
    expect(cleanTitle("Python support for free threading — Python 3.15.2 documentation", "https://docs.python.org/3/howto/free-threading-python.html")).toBe("Python support for free threading");
    expect(cleanTitle("asyncio — Asynchronous I/O — Python 3.13 documentation", "https://docs.python.org/3/library/asyncio.html")).toBe("asyncio — Asynchronous I/O");
    expect(cleanTitle("The Node.js Event Loop | Node.js Learn", "https://nodejs.org/learn")).toBe("The Node.js Event Loop");
    expect(cleanTitle("GitHub - WebAssembly/gc: Branch of the spec repo scoped to GC integration · GitHub", "https://github.com/WebAssembly/gc")).toBe("WebAssembly/gc: Branch of the spec repo scoped to GC integration");
    expect(cleanTitle("[2005.11401] Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", "https://arxiv.org/abs/2005.11401")).toBe("Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks");
    expect(cleanTitle("Node.js — Run JavaScript Everywhere", "https://nodejs.org/")).toBe("Node.js — Run JavaScript Everywhere");
  });

  it("falls back to the URL's last segment, and stays short", () => {
    expect(cleanTitle("", "https://raw.githubusercontent.com/WebAssembly/gc/main/README.md")).toBe("README.md");
    expect(cleanTitle("   ", "https://nodejs.org/")).toBe("nodejs.org");
    expect(cleanTitle("x".repeat(400), "https://a.example/").length).toBe(160);
  });
});

describe("source logs", () => {
  it("reads the pages a researcher recorded, once each, ignoring anything malformed", () => {
    const pages = parsePages(
      log([
        { n: 1, url: "https://en.wikipedia.org/wiki/WebAssembly#History", title: "WebAssembly - Wikipedia", at: "2026-11-04T06:00:00Z" },
        "not json",
        { n: 2, url: "javascript:alert(1)", title: "x" },
        { n: 3, url: "https://en.wikipedia.org/wiki/WebAssembly", title: "again" },
        ["array"],
        { n: 4, url: "https://developer.mozilla.org/en-US/docs/WebAssembly", title: 42, at: "yesterday" },
        "",
      ]),
    );
    expect(pages).toEqual([
      { url: "https://en.wikipedia.org/wiki/WebAssembly", title: "WebAssembly", host: "en.wikipedia.org", at: "2026-11-04T06:00:00Z" },
      { url: "https://developer.mozilla.org/en-US/docs/WebAssembly", title: "WebAssembly", host: "developer.mozilla.org" },
    ]);
  });

  it("takes at most 40 pages from one researcher", () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({ url: `https://en.wikipedia.org/wiki/P${index}`, title: `P${index}` }));
    expect(parsePages(log(entries))).toHaveLength(40);
  });

  it("numbers pages once, in the order first seen, never renumbers them, and keeps every reader", () => {
    const registry = new SourceRegistry();
    registry.add("r2", [{ url: "https://a.example/1", title: "A1", host: "a.example" }]);
    registry.add("r10", [
      { url: "https://b.example/1", title: "B1", host: "b.example" },
      { url: "https://a.example/1", title: "A1", host: "a.example" },
    ]);
    registry.add("r1", [
      { url: "https://a.example/1", title: "A1", host: "a.example" },
      { url: "https://a.example/2", title: "A2", host: "a.example" },
    ]);
    registry.add("r1", [{ url: "https://a.example/1", title: "A1", host: "a.example" }]);
    expect(registry.sources.map((source) => [source.n, source.url, source.readBy])).toEqual([
      [1, "https://a.example/1", ["r1", "r2", "r10"]],
      [2, "https://b.example/1", ["r10"]],
      [3, "https://a.example/2", ["r1"]],
    ]);
  });
});

describe("reports", () => {
  const sources = [1, 2, 3, 4].map((n) => ({ n, url: `https://en.wikipedia.org/wiki/S${n}`, title: `Source ${n}`, host: "en.wikipedia.org", readBy: [`r${n}`] }));

  it("finds citations in every form the lead writes them", () => {
    expect(citedNumbers("A [3]. B [1][4]. C [2, 3]. D [1](https://x.example). Not [a] or [^1].")).toEqual([3, 1, 4, 2, 3, 1]);
  });

  it("refuses citations that aren't pages a researcher read, and a body without any", () => {
    expect(checkDraft({ title: "T", summary: "S [1].", body: "Claim [7]. Other [9][1]." }, sources)).toEqual([
      "[7], [9] aren't sources from list_sources. Cite only the numbers list_sources returned, or remove the claim.",
    ]);
    expect(checkDraft({ title: "T", summary: "S", body: "Claim without a source." }, sources)).toEqual(["Cite your sources: end every factual sentence with numbers from list_sources, like [2]."]);
    expect(checkDraft({ title: " ", summary: "", body: "" }, sources)).toHaveLength(3);
    expect(checkDraft({ title: "T", summary: "Nothing was found.", body: "No pages answered this." }, [])).toEqual([]);
    expect(checkDraft({ title: "T", summary: "S [2].", body: "Claim [1]." }, sources)).toEqual([]);
  });

  it("keeps only cited sources, renumbered by first appearance", () => {
    const report = buildReport({ title: "  Wasm   GC ", summary: "It works [3].", body: "## How\n\nObjects [3][1]. Browsers [1, 4]. Link form [4](https://x.example)." }, sources);
    expect(report.title).toBe("Wasm GC");
    expect(report.summary).toBe("It works [1].");
    expect(report.body).toBe("## How\n\nObjects [1][2]. Browsers [2][3]. Link form [3].");
    expect(report.sources.map((source) => [source.n, source.url, source.readBy])).toEqual([
      [1, "https://en.wikipedia.org/wiki/S3", ["r3"]],
      [2, "https://en.wikipedia.org/wiki/S1", ["r1"]],
      [3, "https://en.wikipedia.org/wiki/S4", ["r4"]],
    ]);
  });

  it("exports the question, the report, and its numbered sources as Markdown", () => {
    const report = buildReport({ title: "Wasm GC", summary: "Yes [2].", body: "## Support\n\nAll major browsers [2]." }, sources);
    const run: Run = {
      id: "run-1",
      question: "Does Wasm   have GC?",
      status: "done",
      researchers: [
        { id: "r1", question: "q", state: "done", pages: [], blocked: [], workerId: "w1" },
        { id: "r2", question: "q", state: "done", pages: [], blocked: [], workerId: "w2" },
      ],
      report: { ...report, sources: [{ ...report.sources[0]!, title: "Source [2]" }] },
      model: "claude-sonnet-5",
      createdAt: "2026-11-04T06:00:00.000Z",
      updatedAt: "2026-11-04T06:03:00.000Z",
      finishedAt: "2026-11-04T06:03:00.000Z",
    };
    expect(reportMarkdown(run)).toBe(
      [
        "# Wasm GC",
        "",
        "> Does Wasm have GC?",
        "",
        "Yes [1].",
        "",
        "## Support",
        "",
        "All major browsers [1].",
        "",
        "## Sources",
        "",
        "1. [Source \\[2\\]](https://en.wikipedia.org/wiki/S2) (en.wikipedia.org)",
        "",
        "---",
        "",
        "Researched with Research Swarm on Managed Copilot on 2026-11-04: a lead on the shared runtime and 2 researchers, each in a sandbox of its own.",
        "",
      ].join("\n"),
    );
  });
});
