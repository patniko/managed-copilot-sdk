import { createServer, type IncomingMessage, type Server } from "node:http";
import { isManagedCopilotError, type DeploymentInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultsApi } from "../src/features/vaults.js";
import { HttpClient } from "../src/http.js";
import type { ManagedContext } from "../src/types.js";

describe("managed.vaults", () => {
  const seen: { method: string; url: string; authorization: string | undefined; body: unknown }[] = [];
  let server: Server;
  let ctx: ManagedContext;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      if (req.method === "POST" && req.url === "/v1/vaults") {
        if (body.name === "taken") {
          res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "conflict", message: 'You already have a vault named "taken"' } }));
          return;
        }
        res.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({ id: "vlt_1", name: body.name, kind: "user", credentials: [{ env: "JIRA_TOKEN", hosts: ["contoso.atlassian.net"] }], createdAt: "2026-10-24T00:00:00Z" }),
        );
      } else if (req.method === "GET" && req.url === "/v1/vaults") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: "payments", name: "payments", kind: "apphost", credentials: [], createdAt: "x" }]));
      } else if (req.method === "DELETE" && req.url === "/v1/vaults/vlt_1") {
        res.writeHead(204).end();
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "Vault vlt_2 was not found" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ctx = {
      url,
      token: "connection-token",
      clientName: undefined,
      info: {} as DeploymentInfo,
      account: { id: 1, login: "alice" },
      http: new HttpClient(url, "connection-token"),
      clients: new Set(),
      listeners: new Map(),
      disposables: new Set(),
    } as unknown as ManagedContext;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("creates, lists, and deletes vaults as the connection's account", async () => {
    const vaults = createVaultsApi(ctx);
    const vault = await vaults.create({ name: "jira-42", credentials: [{ env: "JIRA_TOKEN", value: "secret", hosts: ["contoso.atlassian.net"] }] });
    expect(vault).toMatchObject({ id: "vlt_1", name: "jira-42", kind: "user" });
    expect(await vaults.list()).toHaveLength(1);
    await vaults.delete("vlt_1");
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["POST /v1/vaults", "GET /v1/vaults", "DELETE /v1/vaults/vlt_1"]);
    expect(seen.every((entry) => entry.authorization === ["Bearer", "connection-token"].join(" "))).toBe(true);
    expect(seen[0]!.body).toEqual({ name: "jira-42", credentials: [{ env: "JIRA_TOKEN", value: "secret", hosts: ["contoso.atlassian.net"] }] });
  });

  it("acts for another user with gitHubToken", async () => {
    seen.length = 0;
    await createVaultsApi(ctx).list({ gitHubToken: "user-token" });
    expect(seen[0]!.authorization).toBe(["Bearer", "user-token"].join(" "));
  });

  it("surfaces platform errors and validates obvious mistakes locally", async () => {
    const vaults = createVaultsApi(ctx);
    const conflict = await vaults.create({ name: "taken", credentials: [{ env: "A", value: "v", hosts: ["a.example.com"] }] }).catch((error: unknown) => error);
    expect(isManagedCopilotError(conflict, "conflict")).toBe(true);
    expect(isManagedCopilotError(await vaults.delete("vlt_2").catch((error: unknown) => error), "not_found")).toBe(true);
    const before = seen.length;
    expect(isManagedCopilotError(await vaults.create({ name: "x", credentials: [] }).catch((error: unknown) => error), "invalid_request")).toBe(true);
    expect(isManagedCopilotError(await vaults.create({ name: "x", credentials: [{ env: "A", value: "", hosts: ["a.example.com"] }] }).catch((error: unknown) => error), "invalid_request")).toBe(true);
    expect(isManagedCopilotError(await vaults.list({ gitHubToken: "" }).catch((error: unknown) => error), "authentication_required")).toBe(true);
    expect(seen.length).toBe(before);
  });
});
