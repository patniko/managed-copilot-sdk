import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deployDemo, deployWebhook, nextVersion, signature, type DeployRequest } from "../src/server/deploy.js";
import { diffFile } from "../src/server/diff.js";

describe("diffs", () => {
  it("shows a one-line fix as one hunk with context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "e", "guard", "f", "g", "h", "i", "j"].join("\n");
    const change = diffFile("src/x.js", before, after);
    expect(change).toMatchObject({ path: "src/x.js", status: "modified", added: 1, removed: 0 });
    expect(change.lines.map((line) => `${line.kind}:${line.text}`)).toEqual(["gap:@@ -3,6 +3,7 @@", "context:c", "context:d", "context:e", "add:guard", "context:f", "context:g", "context:h"]);
    expect(change.lines[4]).toMatchObject({ newLine: 6 });
  });

  it("shows a new file as additions, and separate hunks for distant changes", () => {
    expect(diffFile("test/new.test.js", undefined, "one\ntwo\n")).toMatchObject({ status: "added", added: 2, removed: 0 });
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 2", "LINE 2").replace("line 27", "LINE 27");
    const change = diffFile("big.js", before, after);
    expect(change.lines.filter((line) => line.kind === "gap")).toHaveLength(2);
    expect(change).toMatchObject({ added: 2, removed: 2 });
    expect(diffFile("same.js", before, before).lines).toEqual([]);
  });
});

const REQUEST: DeployRequest = {
  incident: "INC-1001",
  service: "checkout",
  version: "1.4.2",
  summary: "Treat expired coupons as no discount",
  tests: "10 passed",
  files: [{ path: "src/discounts.js", content: "export {};\n" }],
  approvedBy: "octocat",
  approvedAt: "2026-11-04T07:15:00.000Z",
  idempotencyKey: "session-1:call-1",
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function pipeline(status: number, answer: unknown): Promise<{ url: string; received: { headers: IncomingMessage["headers"]; body: string }[] }> {
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/deploy`, received };
}

describe("deploys", () => {
  it("bumps the patch version", () => {
    expect(nextVersion("1.4.2")).toBe("1.4.3");
    expect(nextVersion("v2")).toBeUndefined();
    expect(nextVersion(undefined)).toBeUndefined();
  });

  it("releases the demo service to its simulated production", () => {
    expect(deployDemo(REQUEST)).toMatchObject({ ok: true, target: "demo", version: "1.4.3", previousVersion: "1.4.2", message: expect.stringContaining("v1.4.3") });
  });

  it("posts the approved release to your pipeline, signed", async () => {
    const { url, received } = await pipeline(202, { version: "1.4.3", message: "Rolling out." });
    const outcome = await deployWebhook({ url, secret: "deploy-secret" }, REQUEST);
    expect(outcome).toMatchObject({ ok: true, target: "webhook", version: "1.4.3", message: expect.stringContaining("Rolling out.") });
    const [{ headers, body }] = received as [(typeof received)[number]];
    expect(JSON.parse(body)).toMatchObject({ type: "incident.deploy_approved", incident: "INC-1001", version: "1.4.3", previousVersion: "1.4.2", approvedBy: "octocat", files: REQUEST.files });
    expect(headers["idempotency-key"]).toBe("session-1:call-1");
    const [t, v1] = String(headers["x-incident-commander-signature"]).split(",").map((part) => part.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "deploy-secret").update(`${t}.${body}`).digest("hex"));
  });

  it("reports a refusal or an unreachable pipeline without claiming success", async () => {
    const { url } = await pipeline(409, { message: "A deploy is already running." });
    expect(await deployWebhook({ url }, REQUEST)).toMatchObject({ ok: false, message: expect.stringContaining("HTTP 409") });
    expect(await deployWebhook({ url: "http://127.0.0.1:1/deploy" }, REQUEST)).toMatchObject({ ok: false, message: expect.stringContaining("may not have deployed") });
  });

  it("signs like the platform's webhooks", () => {
    const signed = signature("secret", "{}", 1_700_000_000_000);
    expect(signed).toBe(`t=1700000000,v1=${createHmac("sha256", "secret").update("1700000000.{}").digest("hex")}`);
  });
});
