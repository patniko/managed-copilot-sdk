import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startGateway, type RunningGateway } from "../src/server.js";

describe("deployment configuration", () => {
  const env = (environments: Record<string, unknown>) => ({ PORT: "0", MANAGED_COPILOT_CONFIG: JSON.stringify({ name: "copilot", environments }) });

  it("refuses publishing sessions to the GitHub Copilot app at startup instead of ignoring it", () => {
    expect(() => loadConfig(env({ chat: { type: "shared", github: { publish: true } } }))).toThrowError(
      expect.objectContaining({
        code: "transport_unsupported",
        message: 'Environment "chat" sets github.publish, but publishing sessions to the GitHub Copilot app isn\'t supported yet (transport_unsupported). Remove it and use `npx managed-copilot attach` for Copilot CLI.',
      }),
    );
    expect(() => loadConfig(env({ chat: { type: "shared", github: { publish: false } } }))).not.toThrow();
  });
});

describe("gateway skeleton", () => {
  let gateway: RunningGateway;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mc-gateway-"));
    gateway = await startGateway(
      loadConfig({
        PORT: "0",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        // Nothing listens here: every GitHub verification fails at the transport level.
        MANAGED_COPILOT_GITHUB_API_URL: "http://127.0.0.1:9",
        DOCKER_HOST: "tcp://127.0.0.1:1",
        MANAGED_COPILOT_EGRESS: "off",
      }),
    );
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await gateway?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("serves an unauthenticated health check", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("returns structured errors for unknown routes", async () => {
    const response = await fetch(`${base}/v1/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("reports a GitHub outage as a retryable upstream_unavailable with Retry-After", async () => {
    const response = await fetch(`${base}/v1/me`, { headers: { authorization: "Bearer some-user-token" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ error: { code: "upstream_unavailable", details: { upstream: "github", retryAfterSeconds: 5 } } });
  });
});
