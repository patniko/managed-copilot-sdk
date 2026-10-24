/**
 * Gateway MCP adapter for shared placement. Admission rewrites each remote MCP server of a shared session to an
 * adapter route; the shared runtime calls the adapter, and the adapter forwards each request to the original server
 * under that session's network policy (DNS-validated, no redirects), attaching the session's vault MCP credential at
 * request time so no secret ever sits in the runtime's configuration. Supports Streamable HTTP (`type: "http"`) and
 * the legacy SSE transport (`type: "sse"`, whose `endpoint` events are rewritten to adapter routes).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { ManagedCopilotError, type EgressBlockReason } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Database } from "../../db.js";
import type { RequestContext } from "../../http.js";
import type { Logger } from "../../log.js";
import type { GatewayEgress } from "./fetcher.js";
import type { PolicyService } from "./policy.js";

export const MCP_CAPABILITY_HEADER = "x-managed-copilot-mcp";
const ROUTE_PREFIX = "/internal/mcp";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

interface RouteRow {
  route_id: string;
  session_id: string;
  name: string;
  url: string;
}

export interface McpAdapterOptions {
  readonly db: Database;
  readonly policy: PolicyService;
  readonly egress: GatewayEgress;
  /** HMAC key for route capabilities. */
  readonly key: Buffer;
  /** Base URL the shared runtime uses to reach this gateway. */
  readonly baseUrl: () => string;
  readonly log: Logger;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code: status === 403 ? "policy_violation" : status === 404 ? "not_found" : "internal", message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** Rewrites legacy SSE `endpoint` events so the runtime posts messages back through the adapter. */
function endpointRewriter(rewrite: (endpoint: string) => string): Transform {
  let buffer = "";
  let event = "";
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString("utf8");
      let out = "";
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        const content = line.replace(/\r?\n$/, "");
        if (content === "") event = "";
        else if (content.startsWith("event:")) event = content.slice(6).trim();
        if (event === "endpoint" && content.startsWith("data:")) out += `data: ${rewrite(content.slice(5).trim())}\n`;
        else out += line;
      }
      callback(null, out);
    },
    flush(callback) {
      callback(null, buffer);
    },
  });
}

export class McpAdapter {
  readonly #options: McpAdapterOptions;

  constructor(options: McpAdapterOptions) {
    this.#options = options;
  }

  #capability(routeId: string): string {
    return createHmac("sha256", this.#options.key).update(`mcp:${routeId}`).digest("base64url");
  }

  /** Rewrites one shared-session MCP server entry to its adapter route. Throws when the session's policy forbids it. */
  async adapt(sessionId: string, name: string, server: Record<string, unknown>, options: { readonly baseUrl?: string } = {}): Promise<Record<string, unknown>> {
    const session = this.#options.policy.session(sessionId);
    if (!session) throw new ManagedCopilotError("invalid_request", `Session ${sessionId} has no network binding; bind it before admitting MCP servers`);
    if (server["type"] !== "http" && server["type"] !== "sse") throw new ManagedCopilotError("capability_unavailable", `MCP server "${name}": only remote http and sse servers can be used in shared environments`);
    let url: URL;
    try {
      url = new URL(String(server["url"]));
    } catch {
      throw new ManagedCopilotError("invalid_request", `MCP server "${name}" has an invalid URL`);
    }
    url.hash = "";
    const decision = await this.#options.egress.evaluate(session.policy, url);
    if (!decision.ok) {
      if (decision.reason === "dns_failed") throw new ManagedCopilotError("invalid_request", `MCP server "${name}": ${decision.message}`);
      this.#record(sessionId, decision.reason, `MCP server "${name}": ${decision.message}`, url, "ADMIT");
      throw new ManagedCopilotError("policy_violation", `MCP server "${name}" is not reachable under this session's network policy: ${decision.message}`);
    }
    const target = url.toString();
    const db = this.#options.db;
    let row = db.prepare("SELECT * FROM network_mcp_routes WHERE session_id = ? AND name = ? AND url = ?").get(sessionId, name, target) as RouteRow | undefined;
    if (!row) {
      const routeId = `mcp_${randomBytes(12).toString("hex")}`;
      db.prepare("INSERT INTO network_mcp_routes (route_id, session_id, name, url, created_at) VALUES (?, ?, ?, ?, ?)").run(routeId, sessionId, name, target, new Date().toISOString());
      row = { route_id: routeId, session_id: sessionId, name, url: target };
    }
    const base = (options.baseUrl ?? this.#options.baseUrl()).replace(/\/+$/, "");
    const headers = { ...((server["headers"] as Record<string, string> | undefined) ?? {}), [MCP_CAPABILITY_HEADER]: this.#capability(row.route_id) };
    this.#options.log.info("MCP server routed through the adapter", { sessionId, name, host: url.hostname, routeId: row.route_id });
    return { ...server, url: `${base}${ROUTE_PREFIX}/${row.route_id}`, headers };
  }

  #record(sessionId: string, reason: EgressBlockReason, message: string, url: URL, method: string): void {
    this.#options.policy.recordForSession(sessionId, {
      sandboxId: "",
      at: new Date().toISOString(),
      reason,
      message,
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      method,
      path: url.pathname.slice(0, 512),
    });
  }

  register(app: GatewayApp): void {
    for (const method of ["GET", "POST", "DELETE", "PUT", "PATCH"]) {
      app.routes.add(method, `${ROUTE_PREFIX}/:routeId`, (ctx) => this.#handle(ctx, false), { auth: "none" });
      app.routes.add(method, `${ROUTE_PREFIX}/:routeId/endpoint`, (ctx) => this.#handle(ctx, true), { auth: "none" });
    }
  }

  async #handle(ctx: RequestContext, endpoint: boolean): Promise<undefined> {
    const { req, res } = ctx;
    const routeId = ctx.params["routeId"] ?? "";
    const presented = req.headers[MCP_CAPABILITY_HEADER];
    const expected = this.#capability(routeId);
    if (typeof presented !== "string" || presented.length !== expected.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
      sendError(res, 403, "This MCP adapter route needs its capability header");
      return undefined;
    }
    const row = this.#options.db.prepare("SELECT * FROM network_mcp_routes WHERE route_id = ?").get(routeId) as RouteRow | undefined;
    const session = row ? this.#options.policy.session(row.session_id) : undefined;
    if (!row || !session) {
      sendError(res, 404, "This MCP route no longer exists; its session was deleted");
      return undefined;
    }
    const origin = new URL(row.url);
    let target = new URL(row.url);
    if (endpoint) {
      const next = ctx.query.get("u");
      try {
        target = new URL(next ?? "", origin);
      } catch {
        sendError(res, 400, "Invalid MCP message endpoint");
        return undefined;
      }
      if (target.origin !== origin.origin) {
        sendError(res, 403, "The MCP server announced a message endpoint on a different origin, which the adapter does not follow");
        return undefined;
      }
    } else {
      for (const [key, value] of ctx.query) target.searchParams.append(key, value);
    }
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key) || key === MCP_CAPABILITY_HEADER) continue;
      headers[key] = value;
    }
    const contentLength = req.headers["content-length"];
    if (contentLength !== undefined) headers["content-length"] = contentLength;
    let credential: { header: string; value: string } | undefined;
    try {
      credential = this.#options.policy.mcpCredential(session.sessionId, row.url);
    } catch (error) {
      sendError(res, 503, (error as Error).message);
      return undefined;
    }
    if (credential) headers[credential.header] = credential.value;
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    let result;
    try {
      result = await this.#options.egress.request(session.policy, target, { method: req.method ?? "GET", headers, body: req, signal: controller.signal });
    } catch (error) {
      sendError(res, 502, `Could not reach MCP server "${row.name}": ${(error as Error).message}`);
      return undefined;
    }
    if (!result.decision.ok) {
      if (result.decision.reason !== "dns_failed") this.#record(session.sessionId, result.decision.reason, `MCP server "${row.name}": ${result.decision.message}`, target, req.method ?? "GET");
      sendError(res, result.decision.status, result.decision.message);
      return undefined;
    }
    const response = (result as { response: IncomingMessage }).response;
    const status = response.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      response.destroy();
      sendError(res, 502, `MCP server "${row.name}" answered with a redirect; the adapter does not follow redirects`);
      return undefined;
    }
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(key)) responseHeaders[key] = value;
    }
    const sse = /text\/event-stream/i.test(String(response.headers["content-type"] ?? "")) && !response.headers["content-encoding"];
    if (!sse && response.headers["content-length"] !== undefined) responseHeaders["content-length"] = response.headers["content-length"];
    res.writeHead(status, response.statusMessage, responseHeaders);
    const base = `${ROUTE_PREFIX}/${row.route_id}/endpoint?u=`;
    const body = sse && req.method === "GET" ? response.pipe(endpointRewriter((announced) => `${base}${encodeURIComponent(announced)}`)) : response;
    body.pipe(res);
    response.on("error", () => res.destroy());
    return undefined;
  }
}
