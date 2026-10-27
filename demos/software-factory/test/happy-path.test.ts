import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { HAPPY_PATH_TEMPLATE_ID } from "../src/shared/templates.js";

it("the happy-path script reconnects after a factory restart without creating another work order", async () => {
  const output = await mkdtemp(join(tmpdir(), "factory-follow-"));
  let submissions = 0;
  let connections = 0;
  let stream: ServerResponse | undefined;
  const at = new Date().toISOString();
  const wo = {
    id: "wo_restart", number: 1, title: "Test", mode: "classic", startedAt: at, completedAt: at, stations: [],
    plan: { projectName: "test", tasks: [] }, release: { files: 1, tests: { total: 1, passed: 1, failed: 0, skipped: 0 } },
  };
  const server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/api/state") return json({
      platform: { features: { runs: true }, environments: [], deployment: { name: "test", mode: "local" } },
      templates: [{ id: HAPPY_PATH_TEMPLATE_ID, title: "Test", brief: "A test work order" }],
    });
    if (req.url === "/api/events") {
      connections++;
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      return;
    }
    if (req.url === "/api/work-orders" && req.method === "POST") {
      submissions++;
      req.resume();
      return json({ ...wo, status: "queued" }, 201);
    }
    if (req.url === "/api/work-orders/wo_restart") {
      if (connections === 1) setTimeout(() => stream?.destroy(), 30);
      return json({ ...wo, status: connections > 1 ? "completed" : "building" });
    }
    if (req.url === "/api/work-orders/wo_restart/bundle.zip") return res.writeHead(200).end(Buffer.from("unit-test archive"));
    if (req.url === "/api/work-orders/wo_restart/activity") return json([]);
    json({ error: { message: "Not found" } }, 404);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/scripts/happy-path.ts", "--mode", "classic"], {
      env: { ...process.env, FACTORY_URL: url, HAPPY_PATH_OUTPUT: output }, timeout: 15_000,
    });
    expect(stdout).toContain("reconnecting to wo_restart, not submitting new work");
    expect(stdout).toContain("completed");
    expect(submissions).toBe(1);
    expect(connections).toBe(2);
    expect(await readdir(output)).toEqual(expect.arrayContaining(["test-WO-0001.zip", "test-WO-0001.json", "test-WO-0001-activity.json"]));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
}, 20_000);
