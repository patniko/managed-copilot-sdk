import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { approveAll, defineTool, type PermissionHandler } from "@github/copilot-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError, ToolDeclarationSchema, WEBHOOK_HEADERS, type PendingAction } from "@managed-copilot/protocol";
import { runActions } from "../src/features/actions.js";
import { createSchedulesApi, toToolDeclaration } from "../src/features/schedules.js";
import { verifyWebhook } from "../src/features/webhooks.js";
import { HttpClient } from "../src/http.js";
import type { ManagedContext } from "../src/types.js";

const SECRET = "whsec_sdk_test";

function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request("http://worker.local/api/copilot-events", { method: "POST", body, headers });
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isManagedCopilotError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  if (message) expect((error as Error).message).toMatch(message);
}

// A minimal gateway: lists actions, hands out one claim per action, and records results.
interface FakeGateway {
  actions: PendingAction[];
  claims: { actionId: string; body: Record<string, unknown>; auth: string | undefined }[];
  results: { actionId: string; body: Record<string, unknown> }[];
  conflicts: Set<string>;
  runs: { body: Record<string, unknown> }[];
  failRunNow: number;
}

describe("SDK durable features", () => {
  let server: Server;
  let base: string;
  let gateway: FakeGateway;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
        const url = new URL(req.url ?? "/", "http://x");
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const claim = /^\/v1\/sessions\/s1\/actions\/([^/]+)\/claim$/.exec(url.pathname);
        const result = /^\/v1\/sessions\/s1\/actions\/([^/]+)\/result$/.exec(url.pathname);
        if (url.pathname === "/v1/sessions/s1/actions" && req.method === "GET") {
          expect(url.searchParams.get("state")).toBe("pending");
          return send(200, gateway.actions);
        }
        if (claim) {
          const actionId = decodeURIComponent(claim[1]!);
          gateway.claims.push({ actionId, body, auth: req.headers.authorization });
          if (body.claimToken) return send(200, { action: gateway.actions.find((a) => a.id === actionId), claimToken: body.claimToken, leaseExpiresAt: new Date(Date.now() + 6_000).toISOString() });
          if (gateway.conflicts.has(actionId)) return send(409, { error: { code: "conflict", message: "taken", details: { state: "executing" } } });
          const action = gateway.actions.find((a) => a.id === actionId)!;
          return send(200, { action: { ...action, state: "executing" }, claimToken: `token-${actionId}`, leaseExpiresAt: new Date(Date.now() + 6_000).toISOString() });
        }
        if (result) {
          const actionId = decodeURIComponent(result[1]!);
          gateway.results.push({ actionId, body });
          return send(200, { actionId, state: body.release ? "pending" : body.error ? "failed" : "completed" });
        }
        if (url.pathname === "/v1/schedules/sch_1/run") {
          gateway.runs.push({ body });
          if (gateway.failRunNow > 0) {
            gateway.failRunNow--;
            req.socket.destroy();
            return;
          }
          return send(200, { id: "run_1", scheduleId: "sch_1", occurrenceId: "occ", scheduledFor: new Date().toISOString(), status: "queued", trigger: "manual" });
        }
        send(404, { error: { code: "not_found", message: url.pathname } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    gateway = { actions: [], claims: [], results: [], conflicts: new Set(), runs: [], failRunNow: 0 };
  });

  function toolAction(id: string, tool = "lookup_order", args: unknown = { id: "1234" }): PendingAction {
    return { id, sessionId: "s1", kind: "tool", state: "pending", requestId: `req-${id}`, tool, toolCallId: `call-${id}`, arguments: args, idempotencyKey: `s1:call-${id}`, createdAt: new Date().toISOString() };
  }

  function permissionAction(id: string, payload: unknown = { kind: "shell", fullCommandText: "ls" }): PendingAction {
    return { id, sessionId: "s1", kind: "permission", state: "pending", requestId: `req-${id}`, payload, idempotencyKey: `s1:permission:req-${id}`, createdAt: new Date().toISOString() };
  }

  describe("verifyWebhook", () => {
    const envelope = { id: "evt_1", type: "session.idle", createdAt: new Date().toISOString(), sessionId: "s1", environment: "chat", deployment: "copilot", data: {} };

    it("verifies a Fetch Request over its raw bytes", async () => {
      const body = JSON.stringify(envelope);
      const event = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body), [WEBHOOK_HEADERS.eventId]: "evt_1" }), SECRET);
      expect(event).toMatchObject({ id: "evt_1", type: "session.idle", duplicate: false });
      expect(await event.handleActions({ tools: [] })).toEqual([]);
    });

    it("accepts raw bodies with any header casing and rotated secrets", async () => {
      const body = JSON.stringify(envelope);
      const event = await verifyWebhook({ headers: { "X-Managed-Copilot-Signature": `${sign(body, "old")},v1=${sign(body, SECRET).split("v1=")[1]}` }, rawBody: Buffer.from(body) }, ["new", SECRET]);
      expect(event.id).toBe("evt_1");
    });

    it("rejects bad signatures, tampered bodies, stale timestamps, and mismatched event IDs", async () => {
      const body = JSON.stringify(envelope);
      await expectCode(verifyWebhook(request(body, {}), SECRET), "authentication_required", /Missing/);
      await expectCode(verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body, "wrong") }), SECRET), "authentication_required", /does not match/);
      await expectCode(verifyWebhook(request(`${body} `, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET), "authentication_required", /does not match/);
      const stale = Math.floor(Date.now() / 1000) - 3600;
      await expectCode(verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body, SECRET, stale) }), SECRET), "authentication_required", /replay window/);
      await expectCode(verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: "garbage" }), SECRET), "authentication_required", /Malformed/);
      await expectCode(
        verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body), [WEBHOOK_HEADERS.eventId]: "evt_other" }), SECRET),
        "authentication_required",
        /event ID/,
      );
    });

    it("flags duplicates from the caller's dedupe store", async () => {
      const body = JSON.stringify(envelope);
      const seen = new Set(["evt_1"]);
      const event = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET, { seen: (id) => seen.has(id) });
      expect(event.duplicate).toBe(true);
    });

    it("answers the capability's listed actions with the capability, and only those", async () => {
      gateway.actions = [toolAction("act_1"), toolAction("act_2"), permissionAction("act_3")];
      const lookups: unknown[] = [];
      const lookupOrder = defineTool("lookup_order", {
        description: "Look up an order",
        parameters: { type: "object", properties: { id: { type: "string" } } },
        handler: async (args: { id: string }, invocation) => {
          lookups.push({ args, toolCallId: invocation.toolCallId, sessionId: invocation.sessionId });
          return { id: args.id, status: "shipped" };
        },
      });
      const body = JSON.stringify({
        ...envelope,
        type: "session.action_required",
        capability: { token: "mcc_scoped", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: "s1", actionIds: ["act_1", "act_3"], audience: base },
      });
      const event = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET, { deploymentUrl: `${base}/` });
      const results = await event.handleActions({ tools: [lookupOrder], onPermissionRequest: approveAll });
      expect(results).toEqual([
        { actionId: "act_1", state: "completed" },
        { actionId: "act_3", state: "completed" },
      ]);
      expect(lookups).toEqual([{ args: { id: "1234" }, toolCallId: "call-act_1", sessionId: "s1" }]);
      expect(gateway.claims.every((claim) => claim.auth === "Bearer mcc_scoped")).toBe(true);
      expect(gateway.results).toEqual([
        { actionId: "act_1", body: { claimToken: "token-act_1", result: '{"id":"1234","status":"shipped"}' } },
        { actionId: "act_3", body: { claimToken: "token-act_3", result: { kind: "approve-once" } } },
      ]);
    });

    it("refuses a capability issued for another deployment", async () => {
      const body = JSON.stringify({
        ...envelope,
        type: "session.action_required",
        capability: { token: "mcc_x", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: "s1", actionIds: ["a"], audience: "https://evil.example" },
      });
      const event = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET, { deploymentUrl: base });
      await expectCode(event.handleActions({ tools: [] }), "authentication_required", /not http/);
    });

    it("never sends a capability over plain HTTP to a remote host", async () => {
      const body = JSON.stringify({
        ...envelope,
        type: "session.action_required",
        capability: { token: "mcc_x", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: "s1", actionIds: ["a"], audience: "http://copilot.contoso.example" },
      });
      const event = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET);
      await expectCode(event.handleActions({ tools: [] }), "invalid_request", /plain HTTP/);
    });

    it("treats loopback aliases on the same port as the same local deployment", async () => {
      gateway.actions = [];
      const port = new URL(base).port;
      const body = JSON.stringify({
        ...envelope,
        type: "session.action_required",
        capability: { token: "mcc_local", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: "s1", actionIds: [], audience: base },
      });
      const event = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET, { deploymentUrl: `http://localhost:${port}` });
      expect(await event.handleActions({ tools: [] })).toEqual([]);
      const other = await verifyWebhook(request(body, { [WEBHOOK_HEADERS.signature]: sign(body) }), SECRET, { deploymentUrl: `http://localhost:${Number(port) + 1}` });
      await expectCode(other.handleActions({ tools: [] }), "authentication_required");
    });
  });

  describe("handleActions", () => {
    it("never executes an action another responder claimed", async () => {
      gateway.actions = [toolAction("act_1")];
      gateway.conflicts.add("act_1");
      let calls = 0;
      const tool = defineTool("lookup_order", { handler: async () => ++calls });
      const results = await runActions(new HttpClient(base, "gho_owner"), "s1", { tools: [tool] });
      expect(results).toEqual([{ actionId: "act_1", state: "executing" }]);
      expect(calls).toBe(0);
      expect(gateway.results).toHaveLength(0);
    });

    it("leaves actions without a handler pending", async () => {
      gateway.actions = [toolAction("act_1", "other_tool"), permissionAction("act_2")];
      const results = await runActions(new HttpClient(base, "gho_owner"), "s1", { tools: [defineTool("lookup_order", { handler: () => "x" })] });
      expect(results).toEqual([]);
      expect(gateway.claims).toHaveLength(0);
    });

    it("leaves a prompt known only from its derived form for a person", async () => {
      const { payload: _payload, ...bare } = permissionAction("act_1");
      gateway.actions = [bare];
      let asked = 0;
      const results = await runActions(new HttpClient(base, "gho_owner"), "s1", {
        onPermissionRequest: () => {
          asked++;
          return { kind: "approve-once" };
        },
      });
      expect(results).toEqual([]);
      expect(asked).toBe(0);
      expect(gateway.claims).toHaveLength(0);
    });

    it("reports handler failures as errors and releases undecided permission prompts", async () => {
      gateway.actions = [toolAction("act_1"), permissionAction("act_2", { kind: "shell", managedApprovalRequired: true })];
      const failing = defineTool("lookup_order", {
        handler: async () => {
          throw new Error("orders database is down");
        },
      });
      const undecided: PermissionHandler = approveAll;
      await runActions(new HttpClient(base, "gho_owner"), "s1", { tools: [failing], onPermissionRequest: undecided });
      expect(gateway.results).toEqual([
        { actionId: "act_1", body: { claimToken: "token-act_1", error: "orders database is down" } },
        { actionId: "act_2", body: { claimToken: "token-act_2", release: true } },
      ]);
    });

    it("renews the claim while a slow handler runs", async () => {
      gateway.actions = [toolAction("act_1")];
      const slow = defineTool("lookup_order", { handler: () => new Promise((resolve) => setTimeout(() => resolve("done"), 2_300)) });
      await runActions(new HttpClient(base, "gho_owner"), "s1", { tools: [slow] });
      const renewals = gateway.claims.filter((claim) => claim.body.claimToken === "token-act_1");
      expect(renewals.length).toBeGreaterThanOrEqual(1);
      expect(gateway.results[0]!.body).toEqual({ claimToken: "token-act_1", result: "done" });
    });
  });

  describe("schedules", () => {
    it("serializes defineTool tools to standard declarations without their handlers", () => {
      const zodLike = { toJSONSchema: () => ({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }) };
      const declaration = toToolDeclaration(defineTool("lookup_order", { description: "Look up an order", parameters: zodLike as never, handler: () => "x" }));
      expect(declaration).toEqual({
        name: "lookup_order",
        description: "Look up an order",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        revision: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(declaration).not.toHaveProperty("handler");
      const same = toToolDeclaration(defineTool("lookup_order", { description: "Look up an order", parameters: { required: ["id"], properties: { id: { type: "string" } }, type: "object" } }));
      expect(same.revision).toBe(declaration.revision);
      expect(toToolDeclaration(defineTool("ping", {}))).toEqual({ name: "ping", revision: expect.any(String) });
      expect(() => toToolDeclaration(defineTool("bad name", {}))).toThrow(/Invalid tool name/);
      expect(() => toToolDeclaration(defineTool("x", { parameters: "nope" as never }))).toThrow(/zod schema or a JSON schema/);
    });

    it("keeps the stock tool flags the runtime honors", () => {
      const grep = toToolDeclaration(defineTool("grep", { description: "Search files", overridesBuiltInTool: true, skipPermission: true, handler: () => "x" }));
      expect(grep).toMatchObject({ name: "grep", overridesBuiltInTool: true, skipPermission: true });
      expect(ToolDeclarationSchema.parse(grep)).toEqual(grep);
      const plain = toToolDeclaration(defineTool("grep", { description: "Search files", handler: () => "x" }));
      expect(plain).not.toHaveProperty("skipPermission");
      // The flags change runtime behavior, so they are part of the revision.
      expect(plain.revision).not.toBe(grep.revision);
    });

    it("retries runNow with the same invocation ID", async () => {
      gateway.failRunNow = 1;
      const api = createSchedulesApi({ http: new HttpClient(base, "gho_owner") } as unknown as ManagedContext);
      const run = await api.runNow("sch_1");
      expect(run).toMatchObject({ id: "run_1", status: "queued" });
      expect(gateway.runs).toHaveLength(2);
      expect(gateway.runs[0]!.body.invocationId).toBeTypeOf("string");
      expect(gateway.runs[1]!.body.invocationId).toBe(gateway.runs[0]!.body.invocationId);
      await api.runNow("sch_1", { invocationId: "inv-42" });
      expect(gateway.runs[2]!.body).toEqual({ invocationId: "inv-42" });
    });
  });
});
