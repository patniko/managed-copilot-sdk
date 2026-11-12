import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach } from "vitest";
import type { DownhillConfig } from "../src/server/config.js";
import { DownhillShop } from "../src/server/downhill.js";
import { createRequestHandler } from "../src/server/http.js";
import { HelpDesk, type SupportDesk } from "../src/server/support.js";

export const WEB_ROOT = fileURLToPath(new URL("./fixtures/web", import.meta.url));
export const STOREFRONT_DIR = fileURLToPath(new URL("../../help-desk/storefront", import.meta.url));
/** Test data lives in the package's ignored `test/.data` folder. */
const DATA_ROOT = fileURLToPath(new URL("./.data", import.meta.url));

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function dataDir(): string {
  mkdirSync(DATA_ROOT, { recursive: true });
  const dir = mkdtempSync(join(DATA_ROOT, "test-"));
  dirs.push(dir);
  return dir;
}

/** The time tests run at: launch day's first start. */
export const START = Date.parse("2026-11-12T18:00:00.000Z");

export interface Clock {
  now: number;
}

export function testConfig(overrides: Partial<DownhillConfig> = {}): DownhillConfig {
  return { port: 0, host: "127.0.0.1", dev: false, packageRoot: ".", webRoot: WEB_ROOT, version: "1.0.0", dataDir: dataDir(), storefrontDir: STOREFRONT_DIR, ...overrides };
}

export function testShop(config: DownhillConfig, clock: Clock = { now: START }, fetcher?: typeof fetch): DownhillShop {
  return new DownhillShop(config, { now: () => clock.now, ...(fetcher ? { fetcher } : {}) });
}

export async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Downhill's server on a free port. */
export async function start(options: { config?: DownhillConfig; support?: SupportDesk; shop?: DownhillShop } = {}): Promise<string> {
  const config = options.config ?? testConfig();
  const shop = options.shop ?? testShop(config);
  return listen(createServer(createRequestHandler({ config, support: options.support ?? new HelpDesk(undefined), shop })));
}

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

/** A stand-in for another demo's API that records what it's sent and answers as told. */
export async function fakeServer(answer: { status: number; body: unknown } | RequestListener): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (raw += chunk));
    req.once("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (typeof answer === "function") return answer(req, res);
      res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    });
  });
  return { url: await listen(server), received };
}

export function raw(url: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end(init.body);
  });
}

export function postJson(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
