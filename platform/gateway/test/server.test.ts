import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startGateway, type RunningGateway } from "../src/server.js";

describe("gateway skeleton", () => {
  let gateway: RunningGateway;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mc-gateway-"));
    gateway = await startGateway(loadConfig({ PORT: "0", MANAGED_COPILOT_DATA_DIR: dataDir, MANAGED_COPILOT_WRITE_DISCOVERY: "0" }));
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
});
