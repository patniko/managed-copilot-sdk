import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FACTORY_NOT_CONNECTED, readProject, SoftwareFactory, workOrderName, workOrderUrl } from "../src/server/factory.js";
import { STOREFRONT_DIR } from "./fakes.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that answers with `respond`, recording each request. */
function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ORDER = {
  id: "wo_12",
  number: 12,
  title: "Fix: promo codes rejected at checkout",
  status: "queued",
  createdAt: "2026-11-03T10:00:00.000Z",
  taskCount: 0,
  origin: { app: "help-desk", name: "Help Desk", label: "Promo codes · 2 tickets", key: "r1:promo-codes" },
};

describe("Software Factory client", () => {
  it("isn't connected without SOFTWARE_FACTORY_URL, and says how to connect it", async () => {
    const factory = new SoftwareFactory(undefined, "http://localhost:7480");
    expect(factory.configured).toBe(false);
    expect(factory.publicUrl).toBeUndefined();
    await expect(factory.list()).rejects.toMatchObject({ code: "factory_unavailable", status: 503, message: FACTORY_NOT_CONNECTED });
  });

  it("creates and lists work orders as JSON, server to server", async () => {
    const { fetcher, calls } = fakeFetch((call) => (call.init.method === "POST" ? json(201, ORDER) : json(200, [{ ...ORDER, status: "building" }, { id: "wo_odd", status: "dreaming" }])));
    const factory = new SoftwareFactory("http://localhost:7480/", undefined, fetcher);
    expect(factory.configured).toBe(true);
    expect(factory.publicUrl).toBe("http://localhost:7480");
    const request = { title: "Fix: promo codes rejected at checkout", brief: "Fix the promotion codes, with tests.", maxReviewRounds: 2 as const };
    expect(await factory.create(request)).toEqual({ id: "wo_12", number: 12, title: ORDER.title, status: "queued", origin: ORDER.origin });
    expect(calls[0]).toMatchObject({ url: "http://localhost:7480/api/work-orders", init: { method: "POST", headers: { "content-type": "application/json" } } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(request);
    expect(await factory.list()).toEqual([{ id: "wo_12", number: 12, title: ORDER.title, status: "building", origin: ORDER.origin }]);
    expect(calls[1]).toMatchObject({ url: "http://localhost:7480/api/work-orders", init: { method: "GET" } });
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it("links people to a work order at the address they use", () => {
    const factory = new SoftwareFactory("http://software-factory", "https://software-factory.example.io/");
    expect(factory.publicUrl).toBe("https://software-factory.example.io");
    expect(workOrderUrl(factory.publicUrl!, "wo_12")).toBe("https://software-factory.example.io/#/wo/wo_12");
    expect(workOrderName(12)).toBe("WO-0012");
  });

  it("explains failures in plain words, with Software Factory's own message when it gives one", async () => {
    const answering = (respond: () => Response) => new SoftwareFactory("http://localhost:7480", undefined, fakeFetch(respond).fetcher);
    await expect(
      answering(() => {
        throw new TypeError("fetch failed");
      }).list(),
    ).rejects.toMatchObject({ code: "factory_unreachable", status: 502, message: "Software Factory didn't answer at http://localhost:7480. Check that it's running, or set SOFTWARE_FACTORY_URL." });
    await expect(answering(() => json(400, { error: { code: "invalid_request", message: "The brief must be 20–8,000 characters." } })).create({ title: "Fix", brief: "Too short" })).rejects.toMatchObject({
      code: "factory_rejected",
      status: 502,
      message: "The brief must be 20–8,000 characters.",
    });
    await expect(answering(() => json(503, { error: { code: "platform_unavailable", message: "Managed Copilot isn't connected yet." } })).list()).rejects.toMatchObject({
      code: "factory_unavailable",
      status: 503,
      message: "Software Factory isn't available right now: Managed Copilot isn't connected yet.",
    });
    await expect(answering(() => new Response("<html>Bad gateway</html>", { status: 502 })).list()).rejects.toMatchObject({ status: 503, message: "Software Factory isn't available right now (HTTP 502)." });
    await expect(answering(() => json(200, { workOrders: [] })).list()).rejects.toMatchObject({ code: "factory_error", status: 502 });
    await expect(answering(() => json(201, { ok: true })).create({ title: "Fix", brief: "Fix the promotion codes." })).rejects.toMatchObject({ code: "factory_error", status: 502 });
  });

  it("reads the storefront as a project: package.json, README.md, src, and test, with POSIX paths and LF line endings", async () => {
    const files = await readProject(STOREFRONT_DIR);
    expect(files.map((file) => file.path)).toEqual(["package.json", "README.md", "src/cart.js", "src/order-status.js", "src/promotions.js", "test/cart.test.js", "test/order-status.test.js", "test/promotions.test.js"]);
    for (const file of files) expect(file.content, file.path).not.toContain("\r");
    await expect(readProject(join(STOREFRONT_DIR, "missing"))).rejects.toMatchObject({ code: "project_missing", status: 500 });
  });
});
