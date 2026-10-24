// REST routes for workspace files and artifacts (spec sections 5 and 6). Every route is owner-scoped: another
// account's session reads as not found.
import { pipeline } from "node:stream/promises";
import { ManagedCopilotError, ROUTES } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { RequestContext } from "../../http.js";
import type { ArtifactService } from "./artifacts.js";
import type { SandboxService } from "./service.js";

interface OwnedSessions {
  getOwned(accountId: number, sessionId: string): { readonly placement?: string; readonly id: string };
}

const MAX_WAIT_MS = 120_000;

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
