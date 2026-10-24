import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isManagedCopilotError, ManagedCopilotError } from "@managed-copilot/protocol";
import { readDiscovery, resolveToken, resolveUrl, validateDeploymentUrl } from "../src/connection.js";
import { HttpClient } from "../src/http.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("connection resolution", () => {
  it("prefers explicit values, then the environment", async () => {
    process.env.MANAGED_COPILOT_URL = "https://from-env.example/";
    expect(await resolveUrl("https://explicit.example")).toBe("https://explicit.example");
    expect(await resolveUrl()).toBe("https://from-env.example");
  });

  it("only sends credentials over https, or plain http to loopback", () => {
    expect(validateDeploymentUrl("http://localhost:7400")).toBe("http://localhost:7400");
    expect(validateDeploymentUrl("http://127.0.0.1:7400/")).toBe("http://127.0.0.1:7400");
    expect(validateDeploymentUrl("http://[::1]:7400")).toBe("http://[::1]:7400");
    for (const bad of ["http://copilot.contoso.example", "https://user:pass@copilot.contoso.example", "https://copilot.contoso.example/?x=1", "ftp://copilot.contoso.example", "not a url"]) {
      expect(() => validateDeploymentUrl(bad), bad).toThrowError(ManagedCopilotError);
    }
  });

  it("validates the local discovery record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-discovery-"));
    try {
      const file = join(dir, "local.json");
      writeFileSync(file, JSON.stringify({ name: "copilot", url: "http://localhost:7400", pid: process.pid, startedAt: new Date().toISOString(), version: "0.1.0" }));
      expect((await readDiscovery(file)).url).toBe("http://localhost:7400");
      writeFileSync(file, JSON.stringify({ name: "copilot", url: "http://evil.example:7400", pid: process.pid }));
      await expect(readDiscovery(file)).rejects.toMatchObject({ code: "invalid_request" });
      writeFileSync(file, JSON.stringify({ name: "copilot", url: "http://localhost:7400", pid: 2 ** 22 + 12345 }));
      await expect(readDiscovery(file)).rejects.toMatchObject({ code: "capability_unavailable" });
      await expect(readDiscovery(join(dir, "missing.json"))).rejects.toMatchObject({ code: "capability_unavailable" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
