import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_NOT_CONNECTED, toCsv } from "../src/shared/factory.js";
import { parseHash } from "../src/shared/routes.js";
import type { OutputFile, ResultView } from "../src/shared/types.js";
import { withRoutings } from "../src/server/analysis.js";
import { Datasets } from "../src/server/datasets.js";
import { DeskError } from "../src/server/errors.js";
import { createFactory, FactoryTracker, NO_FACTORY, nextRoutingNumber, parseFactoryUrl, SoftwareFactory, type WorkOrderRequest } from "../src/server/factory.js";
import { composeHandoff, parseHandoffRequest, shorten, slug, type HandoffSource } from "../src/server/handoff.js";
import { appOrigin } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { AnalysisManager, originLabel } from "../src/server/manager.js";
import { Store, type StoredRouting } from "../src/server/store.js";
import { parseCsv } from "../src/server/table.js";
import { event, FakeFactory, FakePlatform, PACKAGE_ROOT, testConfig } from "./fakes.js";

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const datasets = new Datasets(join(PACKAGE_ROOT, "datasets"), mkdtempSync(join(tmpdir(), "desk-")), 1024 * 1024);
datasets.load();
const funnel = datasets.require("sample-checkout-funnel");

const ANSWER = "Mobile shoppers with **$40–$49** carts drop out at the shipping step, when the $5.99 fee appears.\n\n- 47% of them reach payment\n- 80% on desktop, 85% on mobile at $50–$74";
const QUESTION = "Where do mobile shoppers drop out of checkout, by cart value?";
const NOTE = "Build a free-shipping progress bar experiment for mobile carts under $50: variant assignment, the bar's copy and threshold logic, and the metrics to watch.";

function result(id: string, title: string, rows: string[][], columns = ["device", "cart_value", "sum(reached_shipping)", "sum(reached_payment)"]): ResultView {
  return { id, title, columns, rows, total: rows.length, unit: "group", at: "2026-11-04T10:00:00.000Z" };
}

const byDevice = result("call-1", "Funnel by device and cart value", [
  ["desktop", "$40–$49", "3434", "2754"],
  ["mobile", "$40–$49", "4790", "2246"],
  ["mobile", "$50–$74", "4851", "4118"],
]);
const chart: OutputFile = { path: "drop-off.svg", version: 2, size: 120, publishedAt: "2026-11-04T10:01:00.000Z", kind: "chart" };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>Drop-off</title></svg>';

function source(overrides: Partial<HandoffSource> = {}, outputs: Record<string, string | Uint8Array> = { "drop-off.svg": SVG }): HandoffSource {
  return {
    dataset: funnel,
    results: [byDevice],
    origins: new Map([["call-1", { tool: "aggregate", detail: "sum(reached_shipping), sum(reached_payment) by device, cart_value" }]]),
    answer: { text: ANSWER, question: QUESTION },
    readOutput: async (path) => {
      const content = outputs[path];
      if (content === undefined) throw new DeskError("not_found", "That file isn't one of this analysis's outputs.", 404);
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return { file: { ...chart, path, size: bytes.byteLength, kind: path.endsWith(".svg") ? "chart" : "file" }, bytes };
    },
    link: "http://localhost:7430/#/a/session-1",
    ...overrides,
  };
}

const request = (include: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseHandoffRequest({ title: "Free-shipping progress bar for mobile carts", note: NOTE, include, ...extra });

describe("tables for the factory", () => {
  it("are CSV with quotes where needed, and read back the same", () => {
    const columns = ["name", "note", "amount"];
    const rows = [
      ["Ada", 'said "hi"', "1"],
      ["Lin, Bo", "two\nlines", "2"],
      [" padded ", "", "3"],
    ];
    const text = toCsv(columns, rows);
    expect(text).toBe('name,note,amount\nAda,"said ""hi""",1\n"Lin, Bo","two\nlines",2\n" padded ",,3\n');
    expect(parseCsv(text)).toEqual({ header: columns, rows });
  });

  it("are named after their titles", () => {
    expect(slug("Funnel by device & cart value (12 weeks)")).toBe("funnel-by-device-cart-value-12-weeks");
    expect(slug("Café crème")).toBe("cafe-creme");
    expect(slug("!!!")).toBe("table");
    expect(slug("Shipping-step drop-off by device and cart value, all twelve weeks of the storefront")).toBe("shipping-step-drop-off-by-device-and-cart-value-all-twelve");
    expect(slug("x".repeat(80))).toBe("x".repeat(60));
  });
});

describe("a hand-off to Software Factory", () => {
  it("sends INSIGHT.md, the table on screen, the selected rows, the charts, and the dataset", async () => {
    const handoff = await composeHandoff(
      source(),
      request({ view: { kind: "result", resultId: "call-1" }, selections: [{ table: { kind: "result", resultId: "call-1" }, rows: [2, 1, 2] }], outputs: ["drop-off.svg"], dataset: true, answer: true }),
      new Date("2026-11-10T12:00:00Z"),
    );
    expect(handoff.files.map((file) => file.path)).toEqual([
      "INSIGHT.md",
      "data/funnel-by-device-and-cart-value.csv",
      "data/funnel-by-device-and-cart-value-selection.csv",
      "artifacts/drop-off.svg",
      "data/checkout-funnel.csv",
    ]);
    const content = (path: string) => handoff.files.find((file) => file.path === path)!.content;
    expect(content("data/funnel-by-device-and-cart-value.csv")).toBe(toCsv(byDevice.columns, byDevice.rows));
    expect(content("data/funnel-by-device-and-cart-value-selection.csv")).toBe(toCsv(byDevice.columns, [byDevice.rows[1]!, byDevice.rows[2]!]));
    expect(content("artifacts/drop-off.svg")).toBe(SVG);
    expect(content("data/checkout-funnel.csv")).toBe(funnel.bytes().toString("utf8"));
    // The factory takes descriptions up to 200 characters.
    expect(handoff.files.every((file) => file.description && file.description.length <= 200)).toBe(true);
    expect(handoff.files[1]!.description).toBe("Copilot's aggregate of the dataset: sum(reached_shipping), sum(reached_payment) by device, cart_value; 3 groups; on screen when sent");

    const insight = content("INSIGHT.md");
    expect(insight).toContain("# Free-shipping progress bar for mobile carts\n");
    expect(insight).toContain("Sent from Data Desk on 2026-11-10, from an analysis of **Storefront checkout funnel**: http://localhost:7430/#/a/session-1");
    expect(insight).toContain(`## What to build\n\n${NOTE}\n`);
    expect(insight).toContain(`Copilot's latest answer in the analysis, to "${QUESTION}":\n\n> Mobile shoppers with **$40–$49** carts`);
    expect(insight).toContain("> - 47% of them reach payment");
    expect(insight).toContain("**Storefront checkout funnel**: Contoso Outdoors, 12 weeks. 180 rows in `checkout-funnel.csv`.");
    expect(insight).toContain("| `week` | date | 2025-07-07 to 2025-09-22 |");
    expect(insight).toContain("| `device` | text | desktop, mobile, tablet |");
    expect(insight).toContain(
      '- `data/funnel-by-device-and-cart-value.csv`: "Funnel by device and cart value": Copilot\'s aggregate of the dataset with Data Desk\'s `aggregate` tool (sum(reached_shipping), sum(reached_payment) by device, cart_value); 3 groups. On screen in Data Desk when this was sent.',
    );
    expect(insight).toContain('- `data/funnel-by-device-and-cart-value-selection.csv`: 2 rows the person selected in "Funnel by device and cart value".');
    expect(insight).toContain("- `artifacts/drop-off.svg`: A chart Copilot drew with Python in its sandbox (`outputs/drop-off.svg`, version 2).");
    expect(insight).toContain("- `data/checkout-funnel.csv`: The whole dataset, 180 rows.");

    expect(handoff.brief.startsWith(`${NOTE}\n\n---\n\n**From Data Desk:** an analysis of Storefront checkout funnel (Contoso Outdoors, 12 weeks), 180 rows.`)).toBe(true);
    expect(handoff.brief).toContain(`Copilot's insight, asked "${QUESTION}":\n\n> Mobile shoppers with **$40–$49** carts`);
    expect(handoff.brief).toContain("Read `.factory/context/INSIGHT.md` first");
    expect(handoff.brief).toContain("`.factory/context/data/funnel-by-device-and-cart-value.csv`, `.factory/context/data/funnel-by-device-and-cart-value-selection.csv`");
    expect(handoff.brief.length).toBeGreaterThanOrEqual(20);
    expect(handoff.brief.length).toBeLessThanOrEqual(8_000);
    expect(handoff.items).toEqual(["Funnel by device and cart value (3 groups)", "2 selected rows of Funnel by device and cart value", "drop-off.svg", "checkout-funnel.csv (180 rows)", "Copilot's answer"]);
  });

  it("sends the dataset's rows the grid shows, and names each file once", async () => {
    const first = await composeHandoff(source(), request({ view: { kind: "dataset", rows: 50 }, selections: [{ table: { kind: "dataset" }, rows: [0, 179] }] }));
    expect(first.files.map((file) => file.path)).toEqual(["INSIGHT.md", "data/checkout-funnel-first-50-rows.csv", "data/checkout-funnel-selection.csv"]);
    expect(first.files[1]!.content.trimEnd().split("\n")).toHaveLength(51);
    expect(first.files[2]!.content.trimEnd().split("\n").slice(1)).toEqual([funnel.table().rows[0]!.join(","), funnel.table().rows[179]!.join(",")]);
    expect(first.items).toEqual(["The first 50 rows of checkout-funnel.csv", "2 selected rows of checkout-funnel.csv"]);
    // No answer included: the brief and INSIGHT.md say what to build without one.
    expect(first.files[0]!.content).toContain("Not included: what to build, above, says what matters.");
    expect(first.brief).not.toContain("Copilot's insight");

    // The grid showed every row: that's the dataset. Sent whole as well, the view isn't sent twice.
    const all = await composeHandoff(source(), request({ view: { kind: "dataset", rows: 200 } }));
    expect(all.files.map((file) => file.path)).toEqual(["INSIGHT.md", "data/checkout-funnel.csv"]);
    const whole = await composeHandoff(source(), request({ view: { kind: "dataset", rows: 50 }, dataset: true }));
    expect(whole.files.map((file) => file.path)).toEqual(["INSIGHT.md", "data/checkout-funnel.csv"]);
    expect(whole.files[0]!.content).toContain("- `data/checkout-funnel.csv`: The whole dataset, 180 rows (Data Desk's grid showed its first 50 rows).");

    const twins = source({ results: [byDevice, result("call-2", "Funnel by device and cart value", [["tablet", "$40–$49", "1", "1"]])] });
    const named = await composeHandoff(twins, request({ view: { kind: "result", resultId: "call-1" }, results: ["call-1", "call-2"] }));
    expect(named.files.map((file) => file.path)).toEqual(["INSIGHT.md", "data/funnel-by-device-and-cart-value.csv", "data/funnel-by-device-and-cart-value-2.csv"]);
  });

  it("keeps to the factory's limits, and says what to send less of", async () => {
    const many = Array.from({ length: 12 }, (_, index) => result(`call-${index}`, `Table ${index}`, [["a", "b", "1", "1"]]));
    await expect(composeHandoff(source({ results: many }), request({ results: many.map((table) => table.id) }))).rejects.toThrow(
      "That's 13 files; the factory takes up to 12. Send fewer tables or files.",
    );

    const big = (id: string, kilobytes: number) => result(id, `Big ${id}`, Array.from({ length: kilobytes }, () => ["x".repeat(1_020)]), ["value"]);
    await expect(composeHandoff(source({ results: [big("a", 300)] }), request({ results: ["a"] }))).rejects.toThrow(
      /^data\/big-a\.csv is 30\d KB; the factory takes files up to 256 KB\. Send fewer rows\.$/,
    );
    const tooMuch = composeHandoff(source({ results: [big("a", 200), big("b", 200), big("c", 200)] }), request({ results: ["a", "b", "c"] }));
    await expect(tooMuch).rejects.toThrow(/^That's 6\d\d KB; the factory takes up to 512 KB of context\. Send fewer rows or files\.$/);
    await expect(tooMuch).rejects.toMatchObject({ code: "payload_too_large", status: 413 });

    const huge = source({}, { "huge.svg": new Uint8Array(300 * 1024).fill(32) });
    await expect(composeHandoff(huge, request({ outputs: ["huge.svg"] }))).rejects.toThrow("huge.svg is 300 KB; the factory takes files up to 256 KB. Leave it out.");
    await expect(composeHandoff(source(), request({ outputs: ["chart.png"] }))).rejects.toThrow("chart.png isn't a chart or text file Data Desk can send.");
    const binary = source({}, { "notes.txt": new Uint8Array([0xff, 0xfe, 0x00]) });
    await expect(composeHandoff(binary, request({ outputs: ["notes.txt"] }))).rejects.toThrow("notes.txt isn't a text file, so it can't be sent.");
    const nul = source({}, { "data.json": "{\u0000}" });
    await expect(composeHandoff(nul, request({ outputs: ["data.json"] }))).rejects.toThrow("data.json isn't a text file, so it can't be sent.");
    const long = result("call-1", "x".repeat(120), [["a", "b", "1", "1"]]);
    const described = await composeHandoff(source({ results: [long], origins: new Map([["call-1", { tool: "aggregate", detail: "y".repeat(300) }]]) }), request({ results: ["call-1"] }));
    expect(described.files[1]!.description!.length).toBe(200);
  });

  it("refuses what isn't in the analysis anymore", async () => {
    await expect(composeHandoff(source(), request({ results: ["call-9"] }))).rejects.toThrow(/isn't in this analysis anymore/);
    await expect(composeHandoff(source(), request({ selections: [{ table: { kind: "result", resultId: "call-1" }, rows: [3] }] }))).rejects.toThrow(/aren't in that table anymore/);
    await expect(composeHandoff(source({ answer: undefined }), request({ answer: true }))).rejects.toThrow(/hasn't answered yet/);
    await expect(composeHandoff(source(), request({ outputs: ["gone.svg"] }))).rejects.toThrow(/isn't one of this analysis's outputs/);
  });

  it("checks the request: a title, what to build, and what to send", () => {
    expect(() => parseHandoffRequest({ title: "Hi", note: NOTE })).toThrow("Give it a title of 3 to 120 characters.");
    expect(() => parseHandoffRequest({ title: "x".repeat(121), note: NOTE })).toThrow(/title of 3 to 120/);
    expect(() => parseHandoffRequest({ title: "A title", note: "Build" })).toThrow("Say what the factory should build, in a sentence or two.");
    expect(() => parseHandoffRequest({ title: "A title", note: "x".repeat(4_001) })).toThrow("Keep what to build under 4,000 characters.");
    expect(() => request({ view: { kind: "chart" } })).toThrow(/current view isn't valid/);
    expect(() => request({ view: { kind: "dataset", rows: 0 } })).toThrow(/current view isn't valid/);
    expect(() => request({ selections: [{ table: { kind: "dataset" }, rows: [-1] }] })).toThrow(/selected rows aren't valid/);
    expect(() => request({ selections: [{ table: { kind: "dataset" }, rows: [] }] })).toThrow(/selected rows aren't valid/);
    expect(() => request({ results: "call-1" })).toThrow(/tables to send aren't valid/);
    expect(() => request({ answer: "yes" })).toThrow(/Pick what to send again/);
    expect(() => request([] as unknown as Record<string, unknown>)).toThrow(/Pick what to send/);
    expect(request({ selections: [{ table: { kind: "dataset" }, rows: [5, 1, 5] }], results: ["a", "a"], dataset: false }, { title: "  Two \n lines\u0007  " })).toEqual({
      title: "Two lines",
      note: NOTE,
      include: { selections: [{ table: { kind: "dataset" }, rows: [1, 5] }], results: ["a"] },
    });
  });

  it("quotes a long insight in short in the brief, ending at a sentence", () => {
    const long = `${"The shipping fee drives mobile shoppers away. ".repeat(60)}`;
    const cut = shorten(long, 300);
    expect(cut.length).toBeLessThanOrEqual(302);
    expect(cut.endsWith(". …")).toBe(true);
    expect(shorten("Short.", 300)).toBe("Short.");
  });
});

describe("Software Factory's API", () => {
  const created = { id: "wo_1", number: 12, title: "A title", status: "queued", createdAt: "2026-11-10T12:00:00.000Z", origin: { app: "data-desk", name: "Data Desk", key: "s:1" } };
  const order: WorkOrderRequest = { title: "A title", brief: NOTE, maxReviewRounds: 2, origin: { app: "data-desk", name: "Data Desk" }, context: [{ path: "INSIGHT.md", content: "# A title\n" }] };
  const answering = (status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []) =>
    new SoftwareFactory({
      url: "http://factory.test",
      publicUrl: "https://factory.example.com",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

  it("creates work orders and lists them, server to server", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const factory = answering(201, created, calls);
    await expect(factory.create(order)).resolves.toEqual({ ...created, origin: { app: "data-desk", name: "Data Desk", key: "s:1" } });
    expect(calls[0]!.url).toBe("http://factory.test/api/work-orders");
    expect(calls[0]!.init).toMatchObject({ method: "POST", headers: { accept: "application/json", "content-type": "application/json" } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(order);
    expect(factory.publicUrl).toBe("https://factory.example.com");
    await expect(answering(200, [created, { id: 3 }, { ...created, id: "wo_2", status: "paused" }]).list()).resolves.toEqual([expect.objectContaining({ id: "wo_1" })]);
  });

  it("passes on the factory's own words, and says when it doesn't answer", async () => {
    const refused = answering(400, { error: { code: "invalid_request", message: "The brief must be 20 to 8,000 characters." } }).create(order);
    await expect(refused).rejects.toMatchObject({ code: "invalid_request", status: 400, message: "The brief must be 20 to 8,000 characters." });
    await expect(answering(413, { error: { code: "payload_too_large", message: "Too much context." } }).create(order)).rejects.toMatchObject({ status: 413, message: "Too much context." });
    await expect(answering(403, { error: { code: "forbidden", message: "This host name isn't allowed." } }).create(order)).rejects.toMatchObject({ status: 502, message: "This host name isn't allowed." });
    await expect(answering(404, "<html>").create(order)).rejects.toMatchObject({ status: 502, message: "Software Factory at http://factory.test answered 404. Check SOFTWARE_FACTORY_URL." });
    await expect(answering(503, { error: { code: "platform_unavailable", message: "Managed Copilot isn't connected yet." } }).create(order)).rejects.toMatchObject({
      status: 502,
      message: "Software Factory couldn't take it: Managed Copilot isn't connected yet.",
    });
    await expect(answering(502, "Bad gateway").list()).rejects.toThrow("Software Factory didn't answer at http://factory.test.");
    await expect(answering(201, "not json").create(order)).rejects.toThrow("Software Factory at http://factory.test sent an answer Data Desk doesn't understand.");
    const down = new SoftwareFactory({ url: "http://factory.test", fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch });
    await expect(down.create(order)).rejects.toMatchObject({ code: "factory_unreachable", status: 502, message: "Software Factory didn't answer at http://factory.test." });
    const stuck = new SoftwareFactory({
      url: "http://factory.test",
      timeoutMs: 30,
      fetch: ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch,
    });
    await expect(stuck.list()).rejects.toThrow("Software Factory didn't answer at http://factory.test.");
  });

  it("is configured with an http address, or not at all", async () => {
    expect(parseFactoryUrl(" http://localhost:7480/ ")).toBe("http://localhost:7480");
    expect(parseFactoryUrl("http://software-factory")).toBe("http://software-factory");
    expect(parseFactoryUrl("https://factory.example.com/base//")).toBe("https://factory.example.com/base");
    for (const value of [undefined, "", "factory", "ftp://factory", "http://user:secret@factory", "http://factory/?a=1"]) expect(parseFactoryUrl(value)).toBeUndefined();
    expect(createFactory({})).toBe(NO_FACTORY);
    expect(createFactory({ factoryUrl: "http://localhost:7480" })).toMatchObject({ configured: true, publicUrl: "http://localhost:7480" });
    expect(createFactory({ factoryUrl: "http://software-factory", factoryPublicUrl: "https://factory.example.com" }).publicUrl).toBe("https://factory.example.com");
    await expect(NO_FACTORY.create(order)).rejects.toMatchObject({ code: "factory_unavailable", status: 503, message: FACTORY_NOT_CONNECTED });
  });
});

describe("where a work order says it came from", () => {
  it("links back to the analysis at Data Desk's address as the browser sees it", () => {
    expect(appOrigin({ headers: { origin: "https://data-desk.example.com", host: "data-desk.example.com" } })).toBe("https://data-desk.example.com");
    expect(appOrigin({ headers: { host: "localhost:7430" } })).toBe("http://localhost:7430");
    expect(appOrigin({ headers: { origin: "null", host: "localhost:7430" } })).toBe("http://localhost:7430");
    expect(parseHash(new URL("http://localhost:7430/#/a/session%3A1").hash)).toEqual({ kind: "analysis", id: "session:1" });
  });

  it("names the analysis and its dataset, once when they're the same", () => {
    expect(originLabel("Storefront checkout funnel", "Storefront checkout funnel")).toBe("Storefront checkout funnel");
    expect(originLabel("Mobile drop-off", "Storefront checkout funnel")).toBe("Mobile drop-off · Storefront checkout funnel");
    expect(originLabel("x".repeat(200), "Data")).toHaveLength(120);
  });
});

function routing(overrides: Partial<StoredRouting> = {}): StoredRouting {
  return { workOrderId: "wo_12", number: 12, title: "Free-shipping progress bar", url: "http://factory.test/#/wo/wo_12", status: "queued", sentAt: "2026-11-04T10:00:30.000Z", items: ["Copilot's answer"], key: "session-1:1", ...overrides };
}

describe("following the work orders Data Desk sent", () => {
  let store: Store;
  let factory: FakeFactory;
  let changed: string[];
  let trackers: FactoryTracker[];

  beforeEach(() => {
    store = new Store(mkdtempSync(join(tmpdir(), "desk-")));
    store.add({ id: "session-1", datasetId: "sample-checkout-funnel", title: "Storefront checkout funnel" });
    factory = new FakeFactory();
    changed = [];
    trackers = [];
  });

  afterEach(() => {
    for (const tracker of trackers) tracker.close();
  });

  const tracker = (intervalMs = 5_000) => {
    const created = new FactoryTracker(factory, store, (id) => changed.push(id), intervalMs);
    trackers.push(created);
    return created;
  };
  const sent = (overrides: Partial<StoredRouting> = {}) => {
    const value = routing(overrides);
    store.update("session-1", (stored) => {
      stored.factory = [...(stored.factory ?? []), value];
    });
    factory.orders.unshift({ id: value.workOrderId, number: value.number, title: value.title, status: value.status, origin: { app: "data-desk", name: "Data Desk", key: value.key } });
  };

  it("records each status change, with the factory's reason when it fails, and stops when nothing is active", async () => {
    sent();
    const following = tracker(20);
    following.follow();
    factory.set("wo_12", "building");
    await settle(60);
    expect(store.get("session-1")!.factory![0]!.status).toBe("building");
    expect(changed).toContain("session-1");
    factory.set("wo_12", "failed", "The release's tests failed.");
    await settle(60);
    expect(store.get("session-1")!.factory![0]).toMatchObject({ status: "failed", error: "The release's tests failed." });
    const calls = factory.listCalls;
    await settle(80);
    expect(factory.listCalls).toBe(calls);
    expect(following.following).toBe(false);
  });

  it("picks up after a restart, and finds a work order sent just before it", async () => {
    sent({ status: "planning" });
    factory.set("wo_12", "completed");
    // Created in the factory, never recorded here: Data Desk stopped before the factory answered.
    factory.orders.unshift({ id: "wo_13", number: 13, title: "Another", status: "building", createdAt: "2026-11-04T10:05:00.000Z", origin: { app: "data-desk", name: "Data Desk", key: "session-1:2" } });
    factory.orders.unshift({ id: "wo_14", number: 14, title: "Someone else's", status: "building", origin: { app: "help-desk", name: "Help Desk", key: "session-1:3" } });
    tracker().start();
    await settle(20);
    expect(store.get("session-1")!.factory).toEqual([
      routing({ status: "completed" }),
      { workOrderId: "wo_13", number: 13, title: "Another", url: "http://factory.test/#/wo/wo_13", status: "building", sentAt: "2026-11-04T10:05:00.000Z", items: [], key: "session-1:2" },
    ]);
    expect(nextRoutingNumber(store.get("session-1")!.factory!)).toBe(3);
  });

  it("stops following a work order the factory doesn't have anymore", async () => {
    sent();
    factory.orders = [];
    const following = tracker();
    for (let poll = 0; poll < 2; poll++) await following.poll();
    expect(store.get("session-1")!.factory![0]!.gone).toBeUndefined();
    await following.poll();
    expect(store.get("session-1")!.factory![0]!.gone).toBe(true);
    expect(following.active).toBe(false);
  });

  it("keeps the last status while the factory doesn't answer", async () => {
    sent({ status: "building" });
    factory.failure = new DeskError("factory_unreachable", "Software Factory didn't answer at http://factory.test.", 502);
    await expect(tracker().poll()).resolves.toBe(false);
    expect(store.get("session-1")!.factory![0]!.status).toBe("building");
    expect(changed).toEqual([]);
  });

  it("shows each one in the conversation after the item that was last when it was sent", () => {
    const items = [
      { kind: "user" as const, id: "u1", text: QUESTION, at: "2026-11-04T10:00:00.000Z", via: "app" as const },
      { kind: "assistant" as const, id: "m1", text: ANSWER, at: "2026-11-04T10:00:40.000Z" },
      { kind: "user" as const, id: "u2", text: "Thanks", at: "2026-11-04T10:01:00.000Z", via: "app" as const },
    ];
    // Data Desk's clock says 10:00:30, before the answer's own time: the line still goes after the answer.
    const placed = withRoutings(items, [routing({ after: "m1" }), routing({ workOrderId: "wo_13", sentAt: "2026-11-04T10:00:50.000Z" })]);
    expect(placed.map((item) => item.id)).toEqual(["u1", "m1", "factory-wo_12", "factory-wo_13", "u2"]);
    expect(placed[2]).toMatchObject({ kind: "factory", routing: { workOrderId: "wo_12", status: "queued", items: ["Copilot's answer"] } });
    expect(placed[2]!.kind === "factory" && "key" in placed[2]!.routing).toBe(false);
  });
});

describe("sending an analysis to Software Factory", () => {
  let hubs: EventHub[] = [];

  afterEach(async () => {
    for (const hub of hubs) hub.close();
    hubs = [];
  });

  async function started(factory = new FakeFactory()) {
    const dataDir = mkdtempSync(join(tmpdir(), "desk-"));
    const config = testConfig(dataDir);
    const local = new Datasets(config.samplesDir, dataDir, config.maxUploadBytes);
    local.load();
    const hub = new EventHub();
    hubs.push(hub);
    const platform = new FakePlatform();
    const store = new Store(dataDir);
    const manager = new AnalysisManager(platform, config, store, local, hub, factory, 20);
    manager.start();
    const view = await manager.create("sample-checkout-funnel");
    const session = platform.sessions.get(view.id)!;
    session.emit(event("user.message", { content: QUESTION }));
    session.emit(event("tool.execution_start", { toolCallId: "call-1", toolName: "aggregate", arguments: { title: byDevice.title, groupBy: ["device", "cart_value"], metrics: [{ fn: "sum", column: "reached_shipping" }] } }));
    session.emit(event("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: JSON.stringify({ title: byDevice.title, matched: 3, columns: byDevice.columns, rows: byDevice.rows }) } }));
    session.emit(event("assistant.message", { messageId: "m1", content: ANSWER }));
    session.emit(event("session.idle", {}, { ephemeral: true }));
    return { manager, factory, store, id: view.id, close: () => manager.close() };
  }

  const body = { title: "Free-shipping progress bar for mobile carts", note: NOTE, include: { view: { kind: "result", resultId: "call-1" }, answer: true } };

  it("creates a work order from the analysis, records it, and follows it", async () => {
    const { manager, factory, store, id, close } = await started();
    try {
      const sent = await manager.sendToFactory(id, body, "http://localhost:7430");
      const request = factory.created[0]!;
      expect(Object.keys(request).sort()).toEqual(["brief", "context", "maxReviewRounds", "origin", "title"]);
      expect(request).toMatchObject({
        title: "Free-shipping progress bar for mobile carts",
        maxReviewRounds: 2,
        origin: { app: "data-desk", name: "Data Desk", label: "Storefront checkout funnel", url: `http://localhost:7430/#/a/${id}`, key: `${id}:1` },
      });
      expect(request.context.map((file) => file.path)).toEqual(["INSIGHT.md", "data/funnel-by-device-and-cart-value.csv"]);
      expect(request.brief.startsWith(NOTE)).toBe(true);
      expect(sent.routing).toEqual({
        workOrderId: "wo_12",
        number: 12,
        title: "Free-shipping progress bar for mobile carts",
        url: "http://factory.test/#/wo/wo_12",
        status: "queued",
        sentAt: expect.any(String),
        items: ["Funnel by device and cart value (3 groups)", "Copilot's answer"],
      });
      expect(sent.analysis.items.map((item) => item.kind)).toEqual(["user", "step", "assistant", "factory"]);
      expect(store.get(id)!.factory).toEqual([expect.objectContaining({ workOrderId: "wo_12", key: `${id}:1`, after: "m1" })]);

      factory.set("wo_12", "building");
      await settle(80);
      expect((await manager.view(id)).factory).toEqual([expect.objectContaining({ status: "building" })]);

      // Sent again: a new work order, with its own key.
      await manager.sendToFactory(id, body, "http://localhost:7430");
      expect(factory.created[1]!.origin.key).toBe(`${id}:2`);
      expect((await manager.view(id)).factory?.map((entry) => entry.number)).toEqual([12, 13]);
    } finally {
      await close();
    }
  });

  it("records nothing when the factory refuses, and says why", async () => {
    const { manager, factory, store, id, close } = await started();
    try {
      factory.failure = new DeskError("invalid_request", "The brief must be 20 to 8,000 characters.");
      await expect(manager.sendToFactory(id, body, "http://localhost:7430")).rejects.toThrow("The brief must be 20 to 8,000 characters.");
      expect(store.get(id)!.factory).toBeUndefined();
      await expect(manager.sendToFactory(id, { ...body, title: "" }, "http://localhost:7430")).rejects.toThrow(/title of 3 to 120/);
      await expect(manager.sendToFactory("nope", body, "http://localhost:7430")).rejects.toMatchObject({ status: 404 });
    } finally {
      await close();
    }
  });
});
