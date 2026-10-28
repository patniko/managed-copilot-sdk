// REST routes for workspace files and artifacts (spec sections 5 and 6). Every route is owner-scoped: another
// account's session reads as not found.
import { pipeline } from "node:stream/promises";
import {
  EnvironmentRequestSchema,
  ManagedCopilotError,
  ROUTES,
  SANDBOX_LIMITS,
  type CreateSandboxRequest,
  type EnvironmentRequest,
  type ExecCaller,
  type ExecInputRequest,
  type ExecRequest,
  type SessionInfo,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Principal, RequestContext } from "../../http.js";
import type { ArtifactService } from "./artifacts.js";
import type { SandboxService } from "./service.js";

interface OwnedSessions {
  getOwned(accountId: number, sessionId: string): { readonly placement?: string; readonly id: string; readonly environment?: string };
}

interface WorkspaceSessions {
  createWorkspace?(principal: Principal, request: { readonly environment: string | EnvironmentRequest; readonly sessionId?: string }): Promise<{ readonly sessionId: string; readonly created: boolean }>;
  info(accountId: number, sessionId: string): Promise<SessionInfo>;
}

const MAX_WAIT_MS = 120_000;
/** A command that is not a background one is stopped after this long unless the caller sets `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function pattern(route: (id: string, ...rest: string[]) => string, ...rest: string[]): string {
  return route(":id", ...rest.map((name) => `:${name}`)).replace(/%3A/gi, ":");
}

export function registerSandboxRoutes(app: GatewayApp, options: { service: SandboxService; artifacts: ArtifactService }): void {
  const { service, artifacts } = options;

  const owned = (ctx: RequestContext): string => {
    const sessionId = ctx.params["id"]!;
    const sessions = app.service("sessions") as unknown as OwnedSessions;
    const record = sessions.getOwned(ctx.principal!.accountId, sessionId);
    if (record.placement !== undefined && record.placement !== "sandbox") {
      throw new ManagedCopilotError("invalid_request", `Session ${sessionId} runs in a shared environment, which has no sandbox files or artifacts. Use an isolated environment.`, { sessionId });
    }
    return sessionId;
  };

  const stream = async (ctx: RequestContext, body: NodeJS.ReadableStream & { destroy(error?: Error): void }, headers: Record<string, string | number>): Promise<void> => {
    ctx.res.writeHead(200, headers);
    ctx.res.on("close", () => {
      if (!ctx.res.writableFinished) body.destroy();
    });
    try {
      await pipeline(body, ctx.res);
    } catch {
      ctx.res.destroy();
    }
  };

  app.routes.get(pattern(ROUTES.files), async (ctx) => {
    const sessionId = owned(ctx);
    return service.listFiles(sessionId, ctx.query.get("path") ?? "", { recursive: ctx.query.get("recursive") === "true" });
  });

  app.routes.get(pattern(ROUTES.fileContent), async (ctx) => {
    const sessionId = owned(ctx);
    const path = ctx.query.get("path");
    if (!path) throw new ManagedCopilotError("invalid_request", "Pass ?path= with a workspace-relative file path.");
    const file = await service.readFile(sessionId, path);
    await stream(ctx, file.body, {
      "content-type": "application/octet-stream",
      "content-length": file.entry.size,
      "x-file-modified-at": file.entry.modifiedAt,
      "cache-control": "no-store",
    });
    return undefined;
  });

  app.routes.put(pattern(ROUTES.fileContent), async (ctx) => {
    const sessionId = owned(ctx);
    const path = ctx.query.get("path");
    if (!path) throw new ManagedCopilotError("invalid_request", "Pass ?path= with a workspace-relative file path.");
    const declared = ctx.req.headers["content-length"];
    const size = declared === undefined ? undefined : Number(declared);
    if (size !== undefined && (!Number.isFinite(size) || size < 0)) throw new ManagedCopilotError("invalid_request", "Invalid Content-Length.");
    const entry = await service.writeFile(sessionId, path, ctx.req, { overwrite: ctx.query.get("overwrite") !== "false", ...(size !== undefined ? { size } : {}) });
    ctx.status(201);
    return entry;
  });

  // Commands run directly in sandboxes (`managed.exec`) and workspace-only sandboxes (`managed.sandboxes.create`) ---

  /** Operators turn these customer APIs off per environment with `exec: false`. */
  const execAllowed = (environment: string | undefined): void => {
    if (environment === undefined) return;
    if (app.config.deployment.environments[environment]?.exec === false) {
      throw new ManagedCopilotError("policy_violation", `Running commands directly is turned off for environment ${environment}.`, { environment });
    }
  };

  const execSession = (ctx: RequestContext): string => {
    const sessionId = owned(ctx);
    const sessions = app.service("sessions") as unknown as OwnedSessions;
    execAllowed(sessions.getOwned(ctx.principal!.accountId, sessionId).environment);
    return sessionId;
  };

  const caller = (ctx: RequestContext): ExecCaller => ({ kind: "api", accountId: ctx.principal!.accountId, ...(ctx.principal!.login ? { login: ctx.principal!.login } : {}) });

  /** Cancels a wait when the caller goes away. */
  const closed = (ctx: RequestContext): AbortSignal => {
    const controller = new AbortController();
    ctx.res.once("close", () => {
      if (!ctx.res.writableFinished) controller.abort();
    });
    return controller.signal;
  };

  app.routes.post(ROUTES.sandboxes, async (ctx) => {
    const body = await ctx.json<Partial<CreateSandboxRequest>>();
    const environment = body.environment;
    if (typeof environment !== "string" && (typeof environment !== "object" || environment === null || Array.isArray(environment))) {
      throw new ManagedCopilotError("invalid_request", "Pass environment: the name of an isolated environment (or an environment descriptor).");
    }
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") throw new ManagedCopilotError("invalid_request", "sessionId must be a string.");
    let request: string | EnvironmentRequest = environment;
    if (typeof environment === "object") {
      const parsed = EnvironmentRequestSchema.safeParse(environment);
      if (!parsed.success) throw new ManagedCopilotError("invalid_request", `Invalid environment descriptor: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      request = parsed.data;
    }
    execAllowed(typeof request === "string" ? request : request.name);
    const sessions = app.service("sessions") as unknown as WorkspaceSessions;
    if (typeof sessions.createWorkspace !== "function") throw new ManagedCopilotError("capability_unavailable", "This gateway cannot create workspace-only sandboxes.");
    const { sessionId, created } = await sessions.createWorkspace(ctx.principal!, { environment: request, ...(body.sessionId ? { sessionId: body.sessionId } : {}) });
    ctx.status(created ? 201 : 200);
    return sessions.info(ctx.principal!.accountId, sessionId);
  });

  app.routes.post(pattern(ROUTES.exec), async (ctx) => {
    const sessionId = execSession(ctx);
    const body = await ctx.json<Partial<ExecRequest>>();
    if (typeof body.command !== "string") throw new ManagedCopilotError("invalid_request", "Pass command: the bash command to run.");
    const background = body.background === true;
    const waitMs = Math.min(Math.max(Number(body.waitMs ?? (background ? 0 : SANDBOX_LIMITS.exec.maxWaitMs)) || 0, 0), SANDBOX_LIMITS.exec.maxWaitMs);
    const timeoutMs = body.timeoutMs ?? (background ? undefined : DEFAULT_TIMEOUT_MS);
    return service.exec(sessionId, body.command, {
      ...(body.id !== undefined ? { id: body.id } : {}),
      background,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      waitMs,
      ...(body.stdin !== undefined ? { stdin: body.stdin } : {}),
      caller: caller(ctx),
    });
  });

  app.routes.get(pattern(ROUTES.exec), (ctx) => service.listExecs(execSession(ctx)));

  app.routes.get(pattern(ROUTES.execItem, "execId"), (ctx) => {
    const sessionId = execSession(ctx);
    const offset = Number(ctx.query.get("offset") ?? 0);
    const waitMs = Number(ctx.query.get("waitMs") ?? 0);
    if (!Number.isInteger(offset) || offset < 0) throw new ManagedCopilotError("invalid_request", "offset must be a non-negative whole number.");
    return service.readExec(sessionId, ctx.params["execId"]!, { offset, waitMs: Number.isFinite(waitMs) ? waitMs : 0, signal: closed(ctx) });
  });

  app.routes.post(pattern(ROUTES.execInput, "execId"), async (ctx) => {
    const sessionId = execSession(ctx);
    const body = await ctx.json<Partial<ExecInputRequest>>();
    return service.writeExec(sessionId, ctx.params["execId"]!, { ...(body.data !== undefined ? { data: body.data } : {}), eof: body.eof === true });
  });

  app.routes.post(pattern(ROUTES.execStop, "execId"), (ctx) => service.stopExec(execSession(ctx), ctx.params["execId"]!, { reason: "Stopped by its owner." }));

  app.routes.get(pattern(ROUTES.artifacts), (ctx) => {
    const sessionId = owned(ctx);
    const versions = ctx.query.get("versions") === "all" ? "all" : "latest";
    return artifacts.list(sessionId, { versions });
  });

  app.routes.get(pattern(ROUTES.artifactPublication), async (ctx) => {
    const sessionId = owned(ctx);
    const requested = Number(ctx.query.get("timeoutMs") ?? 30_000);
    const timeoutMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_WAIT_MS) : 30_000;
    const turnId = ctx.query.get("turnId") ?? undefined;
    return artifacts.waitForPublication(sessionId, { ...(turnId ? { turnId } : {}), timeoutMs });
  });

  app.routes.get(pattern(ROUTES.artifactContent, "artifactId"), async (ctx) => {
    const sessionId = owned(ctx);
    const { info, body } = await artifacts.open(sessionId, ctx.params["artifactId"]!);
    await stream(ctx, body, {
      "content-type": info.contentType ?? "application/octet-stream",
      "content-length": info.size,
      "x-artifact-path": encodeURIComponent(info.path),
      "x-artifact-version": info.version,
      etag: `"${info.digest}"`,
      "cache-control": "private, max-age=31536000, immutable",
    });
    return undefined;
  });
}
