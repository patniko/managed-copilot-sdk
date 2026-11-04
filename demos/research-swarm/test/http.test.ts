import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { hostAllowed } from "../src/server/http.js";
import type { Run } from "../src/shared/types.js";
import { startServer } from "./fakes.js";

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const at = "2026-11-04T06:00:00.000Z";
const done: Run = {
  id: "run-done",
  question: "Does Wasm have GC?",
  status: "done",
  researchers: [{ id: "r1", question: "q", state: "done", pages: [], blocked: [], workerId: "w1" }],
  report: { title: "Wasm GC: yes", summary: "Yes [1].", body: "## Support\n\nShipped [1].", sources: [{ n: 1, url: "https://en.wikipedia.org/wiki/WebAssembly", title: "WebAssembly", host: "en.wikipedia.org", readBy: ["r1"] }] },
  model: "claude-sonnet-5",
  cleanedUp: true,
  createdAt: at,
  updatedAt: at,
  finishedAt: at,
};

async function serve() {
  const server = await startServer([done]);
  servers.push(server);
  return server;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("API", () => {
  it("reports health and state", async () => {
    const { url } = await serve();
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok", platform: "connected" });
    const state = (await (await fetch(`${url}/api/state`)).json()) as { runs: unknown[]; swarm: unknown };
    expect(state.runs).toEqual([{ id: "run-done", question: "Does Wasm have GC?", title: "Wasm GC: yes", status: "done", researchers: 1, sources: 1, createdAt: at, finishedAt: at }]);
    expect(state.swarm).toMatchObject({ researchers: { environment: "research-swarm-web", max: 4 } });
  });

  it("starts a run, and explains what it can't do", async () => {
    const { url, platform } = await serve();
    const created = await post(`${url}/api/runs`, { question: "What is RAG?", researchers: 3 });
    expect(created.status).toBe(201);
    const run = (await created.json()) as Run;
    expect(run).toMatchObject({ question: "What is RAG?", status: "planning" });
    expect((await (await fetch(`${url}/api/runs/${run.id}`)).json()) as Run).toMatchObject({ id: run.id });

    const empty = await post(`${url}/api/runs`, { question: "" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: "invalid_request", message: "Write a question first." } });
    expect((await post(`${url}/api/runs`, { prompt: "x" })).status).toBe(400);
    expect(await (await post(`${url}/api/runs`, { question: "Q", researchers: 9 })).json()).toEqual({ error: { code: "invalid_request", message: "Ask for 2 to 4 researchers." } });
    expect((await post(`${url}/api/runs`, { question: "Q", researchers: "two" })).status).toBe(400);
    expect((await fetch(`${url}/api/runs`, { method: "POST", body: "{}" })).status).toBe(415);
    expect((await fetch(`${url}/api/runs/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/runs`, { method: "PUT" })).status).toBe(405);

    platform.setStatus({ state: "unavailable", message: "Managed Copilot isn't reachable yet." });
    const offline = await post(`${url}/api/runs`, { question: "Another" });
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: { code: "upstream_unavailable", message: "Managed Copilot isn't reachable yet." } });
  });

  it("exports a report as Markdown, and removes runs", async () => {
    const { url } = await serve();
    const exported = await fetch(`${url}/api/runs/run-done/report.md`);
    expect(exported.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(exported.headers.get("content-disposition")).toBe('attachment; filename="wasm-gc-yes.md"');
    expect(await exported.text()).toContain("1. [WebAssembly](https://en.wikipedia.org/wiki/WebAssembly) (en.wikipedia.org)");
    expect((await fetch(`${url}/api/runs/run-done`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${url}/api/runs/run-done`)).status).toBe(404);
  });

  it("refuses other host names and cross-site requests", async () => {
    const { url } = await serve();
    expect(hostAllowed("localhost:7425")).toBe(true);
    expect(hostAllowed("research-swarm.localhost")).toBe(true);
    expect(hostAllowed("research-swarm.example.io", "research-swarm.example.io")).toBe(true);
    expect(hostAllowed("attacker.example")).toBe(false);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/api/state`, { headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await post(`${url}/api/runs`, { question: "Q" }, { origin: "https://attacker.example" })).status).toBe(403);
  });

  it("explains an unbuilt UI", async () => {
    const { url } = await serve();
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Research Swarm's UI isn't built yet");
  });
});
