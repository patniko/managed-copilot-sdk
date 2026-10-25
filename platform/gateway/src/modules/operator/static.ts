// Serves the operator console (platform/console's build) at /console: hashed assets cached for good, every other
// extension-less path answered with index.html (the console routes in the browser). Static files only: the operator
// API under /v1/operator authenticates every request.
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONSOLE_PATH, ManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { RequestContext } from "../../http.js";
import type { Logger } from "../../log.js";

/** The console's Content-Security-Policy: same-origin scripts, styles, and API; GitHub avatars; no framing. */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONSOLE_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Operator console not built</title></head>
<body><h1>The operator console is not built</h1>
<p>Build it with <code>pnpm build</code> at the repository root (or point <code>MANAGED_COPILOT_CONSOLE_DIR</code> at a built console), then reload this page.</p>
<p>The operator API at <code>/v1/operator</code> works without it.</p></body></html>`;

export function consoleDirectory(env: Readonly<Record<string, string | undefined>>): string {
  return env.MANAGED_COPILOT_CONSOLE_DIR ?? fileURLToPath(new URL("../../../../console/dist/", import.meta.url));
}

export function registerConsole(app: GatewayApp, options: { readonly log: Logger }): { readonly directory: string; readonly built: boolean } {
  const directory = consoleDirectory(app.config.env);
  const built = existsSync(join(directory, "index.html"));
  if (!built) options.log.warn("The operator console is not built; /console explains how to build it", { directory });
  let root: string | undefined;
  const resolveRoot = () => {
    try {
      root ??= realpathSync(directory);
    } catch {
      root = undefined;
    }
    return root;
  };

  app.routes.prefix(
    CONSOLE_PATH,
    (ctx: RequestContext) => {
      const { res } = ctx;
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      if (ctx.url.pathname === CONSOLE_PATH) {
        res.writeHead(308, { location: `${CONSOLE_PATH}/${ctx.url.search}` });
        res.end();
        return;
      }
      const base = resolveRoot();
      if (!base || !existsSync(join(base, "index.html"))) {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(NOT_BUILT);
        return;
      }
      const rest = ctx.params["*"] ?? "";
      const segments = rest.split("/").filter(Boolean);
      if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) {
        throw new ManagedCopilotError("not_found", "No such console file");
      }
      const extension = extname(segments[segments.length - 1] ?? "");
      let file = join(base, "index.html");
      if (extension) {
        const candidate = join(base, ...segments);
        let real: string | undefined;
        try {
          real = realpathSync(candidate);
        } catch {
          real = undefined;
        }
        if (!real || !real.startsWith(`${base}${sep}`) || !statSync(real).isFile()) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("Not found");
          return;
        }
        file = real;
      }
      const isIndex = file === join(base, "index.html");
      const hashedAsset = segments[0] === "assets";
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": statSync(file).size,
        "cache-control": isIndex ? "no-store" : hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      });
      if (ctx.req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(file)
        .on("error", () => res.destroy())
        .pipe(res);
    },
    { auth: "none" },
  );
  return { directory, built };
}
