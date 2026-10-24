// Deadlines of the SDK's calls to the gateway: a call the deployment holds (an ingress during a gateway handover)
// fails with `timeout` and the next call works; long waits and streamed transfers are bounded by their own terms; the
// caller's AbortSignal is honored; the event stream reconnects when its connection or heartbeats stop.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PlatformEvent } from "@managed-copilot/protocol";
import { createArtifactsApi } from "../src/features/artifacts.js";
import { ensureEventStream } from "../src/features/events.js";
import { promoteSession } from "../src/features/promote.js";
import { HttpClient, timings } from "../src/http.js";
import { ManagedCopilot } from "../src/managed.js";
import type { ManagedContext } from "../src/types.js";

const defaults = { ...timings };

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("call deadlines", () => {
  let server: Server;
  let base: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;
  const held: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => {
    Object.assign(timings, defaults);
    for (const res of held.splice(0)) res.destroy();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails a call the deployment holds with timeout, and the next call succeeds", async () => {
    let first = true;
    handler = (_req, res) => {
      if (first) {
        // Like an ingress holding the request while the gateway behind it is replaced.
        first = false;
        held.push(res);
        return;
      }
      json(res, 200, { ok: true });
    };
    timings.requestMs = 150;
    const http = new HttpClient(base, "t");
    const started = Date.now();
    await expect(http.get("/v1/sessions")).rejects.toMatchObject({
      code: "timeout",
      message: `The Managed Copilot deployment at ${base} did not answer GET /v1/sessions within 150 ms. It may be restarting or unreachable; try again shortly.`,
      details: { method: "GET", path: "/v1/sessions", timeoutMs: 150, stage: "answer" },
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    await expect(http.get("/v1/sessions")).resolves.toEqual({ ok: true });
  });

  it("bounds ManagedCopilot.connect, and connects on the next try", async () => {
    let holdMe = true;
    handler = (req, res) => {
      if (req.url === "/v1/me" && holdMe) {
        holdMe = false;
        held.push(res);
        return;
      }
      if (req.url === "/v1/info") return json(res, 200, { name: "copilot", version: "0.1.0", environments: [], capabilities: [] });
      json(res, 200, { id: 1, login: "alice" });
    };
    timings.connectMs = 150;
    await expect(ManagedCopilot.connect({ url: base, gitHubToken: "t" })).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("did not answer GET /v1/me within 150 ms") });
    const managed = await ManagedCopilot.connect({ url: base, gitHubToken: "t" });
    expect(managed.account).toEqual({ id: 1, login: "alice" });
    await managed.close();
  });

  it("lets a call with its own bound outlast the default, and honors the caller's signal", async () => {
    handler = (_req, res) => {
      setTimeout(() => json(res, 200, { slow: true }), 300);
    };
    timings.requestMs = 100;
    const http = new HttpClient(base, "t");
    await expect(http.get("/slow")).rejects.toMatchObject({ code: "timeout" });
    await expect(http.get("/slow", { timeoutMs: 5_000 })).resolves.toEqual({ slow: true });
    const controller = new AbortController();
    const reason = new Error("stopped by the caller");
    setTimeout(() => controller.abort(reason), 20);
    await expect(http.get("/slow", { signal: controller.signal, timeoutMs: 5_000 })).rejects.toBe(reason);
  });

  it("bounds the publication long poll and promotion by their own waits", async () => {
    const waits: number[] = [];
    handler = (req, res) => {
      const url = new URL(req.url!, base);
      if (url.pathname.endsWith("/promote")) {
        setTimeout(() => json(res, 200, { sessionId: "s-1", placement: "sandbox", sandboxId: "sbx_1", generation: 1 }), 300);
        return;
      }
      waits.push(Number(url.searchParams.get("timeoutMs")));
      setTimeout(() => json(res, 200, { turnId: "turn-1", state: "published", artifacts: [] }), 300);
    };
    timings.requestMs = 100;
    const http = new HttpClient(base, "t");
    const ctx = { httpFor: () => http } as unknown as ManagedContext;
    await expect(createArtifactsApi(ctx, "s-1").waitForPublication({ timeoutMs: 5_000 })).resolves.toMatchObject({ state: "published" });
    expect(waits).toHaveLength(1);
    await expect(promoteSession(ctx, "s-1")).resolves.toMatchObject({ placement: "sandbox" });
  });

  it("bounds a streamed download by its progress, not its size", async () => {
    handler = (req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      if (req.url === "/steady") {
        let sent = 0;
        const timer = setInterval(() => {
          res.write("x".repeat(10));
          if (++sent === 8) {
            clearInterval(timer);
            res.end();
          }
        }, 50);
        return;
      }
      res.write("partial");
      held.push(res);
    };
    timings.requestMs = 100;
    timings.streamIdleMs = 300;
    const http = new HttpClient(base, "t");
    expect(await (await http.fetch("GET", "/steady")).text()).toBe("x".repeat(80));
    const stalled = await http.fetch("GET", "/stalled");
    await expect(stalled.text()).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("Reading the answer to GET /stalled") });
  });

  it("bounds a streamed upload by its progress, then its answer by the deadline", async () => {
    handler = async (req, res) => {
      let size = 0;
      try {
        for await (const chunk of req) size += (chunk as Buffer).length;
      } catch {
        // The client abandoned a stalled upload.
        return;
      }
      if (req.url === "/silent") {
        held.push(res);
        return;
      }
      json(res, 200, { size });
    };
    timings.requestMs = 100;
    timings.streamIdleMs = 300;
    const http = new HttpClient(base, "t");
    let chunks = 0;
    const steady = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks++ === 6) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 60));
        controller.enqueue(new Uint8Array(10));
      },
    });
    expect(await (await http.fetch("PUT", "/upload", { rawBody: steady })).json()).toEqual({ size: 60 });
    const stalledSource = { cancelled: false };
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        stalledSource.cancelled = true;
      },
    });
    await expect(http.fetch("PUT", "/upload", { rawBody: stalled })).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("Sending PUT /upload"),
      details: { method: "PUT", path: "/upload", timeoutMs: 300, stage: "send" },
    });
    // The stalled source is released (a file stream's descriptor closes), not left locked.
    await waitUntil(() => stalledSource.cancelled);
    await expect(http.fetch("PUT", "/silent", { rawBody: new Uint8Array(1_000) })).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("did not answer PUT /silent within 100 ms"),
    });
  });

  it("releases an upload's source when the request ends without taking all of it", async () => {
    handler = (_req, res) => {
      // Refuses at once, without reading the upload (like an existing file with overwrite: false).
      json(res, 409, { error: { code: "conflict", message: "outputs/report.md already exists" } });
    };
    const endless = () => {
      const state = { cancelled: false };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { state, stream };
    };
    const refused = endless();
    await expect(new HttpClient(base, "t").fetch("PUT", "/refuse", { rawBody: refused.stream })).rejects.toMatchObject({ code: "conflict", message: "outputs/report.md already exists" });
    await waitUntil(() => refused.state.cancelled);

    const unreachable = endless();
    await expect(new HttpClient("http://127.0.0.1:9", "t").fetch("PUT", "/x", { rawBody: unreachable.stream })).rejects.toMatchObject({ code: "capability_unavailable" });
    await waitUntil(() => unreachable.state.cancelled);

    const controller = new AbortController();
    const reason = new Error("stopped before it started");
    controller.abort(reason);
    const aborted = endless();
    await expect(new HttpClient(base, "t").fetch("PUT", "/x", { rawBody: aborted.stream, signal: controller.signal })).rejects.toBe(reason);
    await waitUntil(() => aborted.state.cancelled);
  });

  it("reconnects the event stream when its connection or heartbeats stop, resuming after the last event", async () => {
    const lastIds: (string | undefined)[] = [];
    const event = (id: string): string => `id: ${id}\nevent: session.created\ndata: ${JSON.stringify({ id, type: "session.created", createdAt: new Date().toISOString(), data: {} })}\n\n`;
    handler = (req, res) => {
      lastIds.push(req.headers["last-event-id"] as string | undefined);
      held.push(res);
      // The first connection is never answered.
      if (lastIds.length === 1) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      // The second sends an event and then falls silent (no heartbeats); the third continues after it.
      res.write(event(lastIds.length === 2 ? "evt-1" : "evt-2"));
    };
    timings.connectMs = 150;
    timings.eventsIdleMs = 200;
    timings.eventsRetryMs = 10;
    const received: string[] = [];
    const ctx = {
      http: new HttpClient(base, "t"),
      listeners: new Map([["*", new Set([(platformEvent: PlatformEvent) => received.push(platformEvent.id)])]]),
      disposables: new Set<() => void>(),
    } as unknown as ManagedContext;
    ensureEventStream(ctx);
    try {
      await waitUntil(() => received.includes("evt-2"));
      expect(received).toEqual(["evt-1", "evt-2"]);
      expect(lastIds.slice(0, 3)).toEqual([undefined, undefined, "evt-1"]);
    } finally {
      for (const dispose of ctx.disposables) await dispose();
    }
  });
});
