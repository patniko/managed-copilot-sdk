import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isManagedCopilotError } from "@managed-copilot/protocol";
import { resolveToken, resolveUrl } from "../src/connection.js";
import { HttpClient } from "../src/http.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("connection resolution", () => {
  it("prefers explicit values, then the environment", async () => {
    process.env.MANAGED_COPILOT_URL = "http://from-env:1";
    expect(await resolveUrl("http://explicit:2")).toBe("http://explicit:2");
    expect(await resolveUrl()).toBe("http://from-env:1");
  });

  it("reads tokens in the documented order", async () => {
    process.env.GITHUB_TOKEN = "gh-token";
    process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
    expect(await resolveToken("explicit")).toBe("explicit");
    expect(await resolveToken()).toBe("copilot-token");
  });
});

describe("HttpClient", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ auth: req.headers.authorization }));
        return;
      }
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "session_busy", message: "busy" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends the bearer token and parses JSON", async () => {
    expect(await new HttpClient(base, "t0k").get("/ok")).toEqual({ auth: "Bearer t0k" });
  });

  it("maps error bodies to ManagedCopilotError", async () => {
    const error = await new HttpClient(base, "t").get("/busy").catch((e: unknown) => e);
    expect(isManagedCopilotError(error, "session_busy")).toBe(true);
  });

  it("reports unreachable deployments as capability_unavailable", async () => {
    const error = await new HttpClient("http://127.0.0.1:9", "t").get("/x").catch((e: unknown) => e);
    expect(isManagedCopilotError(error, "capability_unavailable")).toBe(true);
  });
});
