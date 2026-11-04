/** Starts a real Front Desk HTTP server over a temporary data directory, a fake platform, and a fake GitHub. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.js";
import { EmailAccounts } from "../src/server/auth/email.js";
import { GitHubAuth } from "../src/server/auth/github.js";
import { RateLimiter } from "../src/server/auth/ratelimit.js";
import { loadConfig, type FrontDeskConfig } from "../src/server/config.js";
import { Conversations } from "../src/server/conversations.js";
import { createRequestHandler } from "../src/server/http.js";
import { Hub } from "../src/server/hub.js";
import { People } from "../src/server/people.js";
import { Sealer } from "../src/server/seal.js";
import { Store } from "../src/server/store.js";
import { FakeGitHub, FakePlatform } from "./fakes.js";

export interface Harness {
  readonly url: string;
  readonly config: FrontDeskConfig;
  readonly store: Store;
  readonly platform: FakePlatform;
  readonly github: FakeGitHub;
  readonly conversations: Conversations;
  browser(): Browser;
  close(): Promise<void>;
}

export interface Response<T = any> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** One browser: its own cookie jar, and same-origin requests like the web UI sends. */
export interface Browser {
  readonly cookies: Map<string, string>;
  get<T = any>(path: string, headers?: Record<string, string>): Promise<Response<T>>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response<T>>;
  delete<T = any>(path: string, headers?: Record<string, string>): Promise<Response<T>>;
  /** Opens `/api/events` and collects what arrives; `ended` says whether the server closed it. */
  events(): Promise<{ readonly received: ServerEvent[]; ended(): boolean; close(): void }>;
}

export async function startHarness(env: Record<string, string> = {}, options: { gh?: () => Promise<string> } = {}): Promise<Harness> {
  const github = new FakeGitHub();
  await github.start();
  const dataDir = mkdtempSync(join(tmpdir(), "front-desk-test-"));
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  const config = loadConfig({
    PORT: String(port),
    FRONT_DESK_PUBLIC_URL: url,
    FRONT_DESK_DATA_DIR: dataDir,
    FRONT_DESK_DEV: "0",
    FRONT_DESK_SEALING_KEY: "test-sealing-key-0123456789abcdef",
    FRONT_DESK_GITHUB_CLIENT_ID: github.clientId,
    FRONT_DESK_GITHUB_CLIENT_SECRET: github.clientSecret,
    FRONT_DESK_GITHUB_URL: github.url,
    FRONT_DESK_GITHUB_API_URL: github.url,
    ...env,
  });
  const store = new Store(join(dataDir, "front-desk.db"));
  const sealer = Sealer.fromSecret(config.sealingKey!);
  const limiter = new RateLimiter();
  const platform = new FakePlatform();
  const githubAuth = new GitHubAuth({ config, store, sealer, ...(options.gh ? { ghToken: options.gh } : {}) });
  const email = new EmailAccounts(store, limiter, config.inviteCode);
  const people = new People(store, githubAuth, config);
  const hub = new Hub();
  const conversations = new Conversations({
    store,
    platform,
    people,
    hub,
    config,
    onSignInExpired: (userId) => {
      githubAuth.forget(userId);
      store.deleteBrowserSessionsOf(userId);
      hub.disconnect(userId);
    },
  });
  server.on("request", createRequestHandler({ config, store, people, github: githubAuth, email, conversations, hub, limiter, platform }));

  const browser = (): Browser => {
    const cookies = new Map<string, string>();
    const request = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response<T>> => {
      const response = await fetch(`${url}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(method !== "GET" ? { origin: url } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(";");
        const index = pair!.indexOf("=");
        const name = pair!.slice(0, index).trim();
        const value = pair!.slice(index + 1).trim();
        if (attributes.some((attribute) => /max-age=0/i.test(attribute.trim())) || !value) cookies.delete(name);
        else cookies.set(name, value);
      }
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // Not JSON.
      }
      return { status: response.status, body: parsed as T, headers: response.headers };
    };
    return {
      cookies,
      get: (path, headers) => request("GET", path, undefined, headers),
      post: (path, body = {}, headers) => request("POST", path, body, headers),
      delete: (path, headers) => request("DELETE", path, undefined, headers),
      events: async () => {
        const controller = new AbortController();
        const received: ServerEvent[] = [];
        const response = await fetch(`${url}/api/events`, { headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`events: HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let ended = false;
        void (async () => {
          let buffer = "";
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let index: number;
              while ((index = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                const data = block.split("\n").find((line) => line.startsWith("data: "));
                if (data) received.push(JSON.parse(data.slice(6)) as ServerEvent);
              }
            }
          } catch {
            // Closed.
          }
          ended = true;
        })();
        return { received, ended: () => ended, close: () => controller.abort() };
      },
    };
  };

  return {
    url,
    config,
    store,
    platform,
    github,
    conversations,
    browser,
    close: async () => {
      hub.close();
      await conversations.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await github.stop();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Waits until `check` passes (or fails after `timeoutMs`). */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Signs a browser in with GitHub through the real web flow against the fake GitHub. */
export async function signInWithGitHub(harness: Harness, browser: Browser, account: { id: number; login: string; name?: string }, token: string): Promise<void> {
  harness.github.accounts.set(token, account);
  const start = await browser.get("/auth/github");
  if (start.status !== 302) throw new Error(`expected a redirect to GitHub, got ${start.status}`);
  const { code, state } = harness.github.approve(start.headers.get("location")!, token);
  const back = await browser.get(`/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  if (back.status !== 302 || back.headers.get("location") !== "/") throw new Error(`GitHub sign-in failed: ${back.status} ${back.headers.get("location")}`);
}
