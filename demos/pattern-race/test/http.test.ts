import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RaceError } from "../src/server/errors.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import type { JobId } from "../src/shared/jobs.js";
import type { AppState, RaceSnapshot } from "../src/shared/types.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const STATE: AppState = { platform: { state: "connected" }, lanes: [], model: { id: "claude-sonnet-5", name: "Claude Sonnet 5" }, serverNow: 1 };

async function serve(races: { start: (job: JobId) => RaceSnapshot; stop: () => void }): Promise<string> {
  const handler = createRequestHandler({ races, hub: { attach: () => undefined }, state: () => STATE, config: { webRoot: "does-not-exist" } });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

const started = { id: "r1", job: "code", model: "m", expected: [], startedAt: 1, state: "running", lanes: [] } satisfies RaceSnapshot;

describe("API", () => {
  it("answers health and state", async () => {
    const url = await serve({ start: () => started, stop: () => undefined });
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok", platform: "connected" });
    expect(await (await fetch(`${url}/api/state`)).json()).toEqual(STATE);
  });

  it("starts a race of a known job", async () => {
    const jobs: JobId[] = [];
    const url = await serve({ start: (job) => (jobs.push(job), started), stop: () => undefined });
    const response = await fetch(`${url}/api/race`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: "code" }) });
    expect(response.status).toBe(201);
    expect(jobs).toEqual(["code"]);
    const bad = await fetch(`${url}/api/race`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: "mine" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "invalid_request", message: 'job must be "answer", "code", or "split".' } });
  });

  it("answers a refused start or stop with its code and words", async () => {
    const url = await serve({
      start: () => {
        throw new RaceError("race_running", "A race is already running. Stop it or wait for it to finish.", 409);
      },
      stop: () => {
        throw new RaceError("not_running", "No race is running.", 409);
      },
    });
    const start = await fetch(`${url}/api/race`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: "answer" }) });
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: { code: string } }).error.code).toBe("race_running");
    const stop = await fetch(`${url}/api/race/stop`, { method: "POST" });
    expect(stop.status).toBe(409);
  });

  it("refuses cross-site requests, other host names, and unknown routes", async () => {
    const url = await serve({ start: () => started, stop: () => undefined });
    const crossSite = await fetch(`${url}/api/race/stop`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    expect((await fetch(`${url}/api/race`)).status).toBe(405);
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
    expect(hostAllowed("localhost:7420")).toBe(true);
    expect(hostAllowed("pattern-race.localhost")).toBe(true);
    expect(hostAllowed("evil.example")).toBe(false);
    expect(hostAllowed("race.example.io", "race.example.io,pattern-race")).toBe(true);
  });

  it("says the UI isn't built when it isn't", async () => {
    const url = await serve({ start: () => started, stop: () => undefined });
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Pattern Race's UI isn't built yet");
  });
});
