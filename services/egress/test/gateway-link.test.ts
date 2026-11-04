import { createServer, type ServerResponse } from "node:http";
import { EGRESS_KEY_HEADER, EGRESS_ROUTES, normalizeNetwork, type EgressRegistration, type EgressReport } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayLink, SecretUnavailableError } from "../src/gateway-link.js";
import { silentLogger } from "../src/log.js";
import { hashCredential, Registry } from "../src/registry.js";
import { listen } from "./fixtures.js";

const KEY = "egress-test-key";

function registration(sandboxId: string, revision = 1): EgressRegistration {
  return { sandboxId, sessionId: `ses_${sandboxId}`, credentialHash: hashCredential("pw"), policy: normalizeNetwork(true), credentials: [], revision };
}

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("gateway link", () => {
  const streams = new Set<ServerResponse>();
  const reports: EgressReport[] = [];
  const hellos: unknown[] = [];
  let snapshot: EgressRegistration[] = [registration("sbx_a")];
  let base = "";
  const server = createServer(async (req, res) => {
    if (req.headers[EGRESS_KEY_HEADER] !== KEY) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (req.url === EGRESS_ROUTES.hello) {
      hellos.push(body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ deployment: "copilot", heartbeatSeconds: 1 }));
    } else if (req.url === EGRESS_ROUTES.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ registrations: snapshot, issuedAt: new Date().toISOString() })}\n\n`);
      streams.add(res);
      res.on("close", () => streams.delete(res));
    } else if (req.url === EGRESS_ROUTES.secret) {
      if (body.placeholder === "revoked") res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "forbidden", message: "That vault was deleted." } }));
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: `value-for-${body.credentialId}` }));
    } else if (req.url === EGRESS_ROUTES.reports) {
      reports.push(...body.reports);
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  const push = (event: string, data: unknown) => {
    for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const registry = new Registry({ staleMs: 300, maxConnectionsPerSandbox: 4 });
  let link: GatewayLink;

  beforeAll(async () => {
    base = `http://127.0.0.1:${await listen(server)}`;
    link = new GatewayLink({ url: base, key: KEY, registry, hello: { instanceId: "i-1", version: "0.1.0", caCertificate: "PEM" }, log: silentLogger });
    link.start();
    await waitFor(() => registry.ready);
  });

  afterAll(async () => {
    await link.stop();
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    server.close();
  });

  it("announces itself with its CA certificate and applies the snapshot", () => {
    expect(hellos[0]).toEqual({ instanceId: "i-1", version: "0.1.0", caCertificate: "PEM" });
    expect(registry.get("sbx_a")?.sessionId).toBe("ses_sbx_a");
  });

  it("applies upserts and removals as they arrive", async () => {
    push("upsert", registration("sbx_b"));
    await waitFor(() => registry.get("sbx_b") !== undefined);
    push("remove", { sandboxId: "sbx_a" });
    await waitFor(() => registry.get("sbx_a") === undefined);
    push("ping", {});
  });

  it("authorizes each vault use with the gateway", async () => {
    const request = { sandboxId: "sbx_b", credentialId: "cred_1", placeholder: "p", host: "api.stripe.com", port: 443, header: "authorization" };
    expect(await link.resolveSecret(request)).toBe("value-for-cred_1");
    const error = await link.resolveSecret({ ...request, placeholder: "revoked" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: "credential_revoked", message: "That vault was deleted." });
  });

  it("batches and de-duplicates reports", async () => {
    const report: EgressReport = { sandboxId: "sbx_b", sessionId: "ses_sbx_b", at: new Date().toISOString(), reason: "host_not_allowed", host: "evil.test", port: 443, message: "blocked" };
    link.report(report);
    link.report(report);
    link.report({ ...report, host: "other.test" });
    await waitFor(() => reports.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reports.map((entry) => entry.host)).toEqual(["evil.test", "other.test"]);
  });

  it("fails closed when the stream drops, then resynchronizes", async () => {
    snapshot = [registration("sbx_c")];
    for (const stream of streams) stream.destroy();
    await waitFor(() => registry.get("sbx_c") !== undefined, 5_000);
    expect(registry.get("sbx_b")).toBeUndefined();
    expect(registry.ready).toBe(true);
  });

  it("reports an unreachable gateway as policy_unavailable", async () => {
    const offline = new GatewayLink({ url: "http://127.0.0.1:9", key: KEY, registry: new Registry({ staleMs: 1, maxConnectionsPerSandbox: 1 }), hello: { instanceId: "x", version: "0", caCertificate: "" }, log: silentLogger });
    const error = await offline.resolveSecret({ sandboxId: "s", credentialId: "c", placeholder: "p", host: "h.test", port: 443, header: "authorization" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "policy_unavailable" });
  });
});
