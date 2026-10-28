import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { GalleryState, TargetState } from "../shared/catalog.js";
import { checkTarget, cloudUrls, localUrls } from "./targets.js";

export interface CloudLookup {
  readonly url?: string;
  readonly note: string;
}

export interface ConsoleLink {
  readonly url?: string;
  readonly message?: string;
  readonly hint?: string;
}

export interface GalleryOptions {
  readonly offset: number;
  /** Resolves once the Azure deployment is known (or known to be missing). */
  readonly cloud: Promise<CloudLookup>;
  readonly webRoot: string;
  readonly shotsDir: string;
  readonly repoUrl: string;
  /** Returns a one-time operator console sign-in link for a gateway. */
  readonly openConsole: (gatewayUrl: string) => Promise<ConsoleLink>;
  /**
   * Served from the deployment: answers these host names (besides loopback), shows the Azure target only, and never
   * mints console sign-in links, which would sign every visitor in as the gallery's account.
   */
  readonly hosted?: { readonly allowedHosts: readonly string[] };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

const CACHE_MS = 4_000;

function serveFile(root: string, pathname: string, res: ServerResponse, fallback?: string): boolean {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  let file = resolve(join(base, decoded));
  if (file !== base && !file.startsWith(base + sep)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (!fallback || extname(pathname)) return false;
    file = join(base, fallback);
    if (!existsSync(file)) return false;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small page in the gallery's look for a console link that couldn't be made. */
function problemPage(res: ServerResponse, title: string, message: string, hint?: string, status = 502): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Demo gallery</title>
<style>body{font:14px/1.5 -apple-system,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}
main{max-width:520px;padding:32px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;opacity:.85}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;padding:2px 6px;border-radius:6px;background:color-mix(in srgb,CanvasText 8%,transparent)}a{color:#0969da}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${hint ? `<p>${escapeHtml(hint).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>` : ""}<p><a href="/">Back to the gallery</a></p></main></body></html>`);
}

/** The gallery's HTTP handler: the page, its screenshots, live link state, and the console sign-in redirect. */
export function createGallery(options: GalleryOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const local = localUrls(options.offset);
  const hosted = options.hosted;
  const allowedHosts = new Set((hosted?.allowedHosts ?? []).map((host) => host.toLowerCase()));
  let cloud: CloudLookup | undefined;
  void options.cloud.then((found) => (cloud = found));
  let cached: { at: number; state: Promise<GalleryState> } | undefined;

  async function state(): Promise<GalleryState> {
    const localCheck = hosted ? undefined : checkTarget(local);
    let cloudState: TargetState;
    if (!cloud) cloudState = { links: {}, searching: true, note: "Looking for your Azure deployment…" };
    else if (!cloud.url) cloudState = { links: {}, note: cloud.note };
    else {
      const urls = cloudUrls(cloud.url, { console: !hosted });
      const checked = await checkTarget(urls);
      cloudState = { gatewayUrl: urls.gatewayUrl, gateway: checked.gateway, links: checked.links, note: cloud.note };
    }
    const localChecked = await localCheck;
    return {
      ...(localChecked
        ? { local: { gatewayUrl: local.gatewayUrl, gateway: localChecked.gateway, links: localChecked.links, note: "The platform `aspire run` starts on this machine." } }
        : {}),
      cloud: cloudState,
      ...(hosted ? { hosted: true } : {}),
      repoUrl: options.repoUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  return (req, res) => {
    void (async () => {
      // Only this machine's own addresses (and, hosted, the deployment's names): refuses DNS-rebinding pages, which
      // could otherwise mint console sign-in links.
      const host = req.headers.host ?? "";
      const hostname = host.replace(/:\d+$/, "").toLowerCase();
      if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) && !allowedHosts.has(hostname)) {
        res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Open the gallery at http://localhost.");
      }
      const url = new URL(req.url ?? "/", "http://gallery.local");
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Only GET is supported." });

      if (url.pathname === "/api/health") return json(res, 200, { ok: true });
      if (url.pathname === "/api/gallery") {
        const fresh = url.searchParams.has("refresh");
        if (fresh || !cached || Date.now() - cached.at > CACHE_MS || (!cloud && !fresh)) cached = { at: Date.now(), state: state() };
        return json(res, 200, await cached.state);
      }
      if (url.pathname === "/open/console") {
        if (hosted) {
          const gatewayUrl = (await options.cloud).url ?? "https://copilot.<environment-domain>";
          return problemPage(
            res,
            "Open the console from your terminal",
            "The operator console signs you in with your own GitHub account, so this shared page can't open it for you.",
            `Run \`npx managed-copilot console --url ${gatewayUrl}\` from a clone of the repository.`,
            404,
          );
        }
        const target = url.searchParams.get("target") === "cloud" ? "cloud" : "local";
        const gatewayUrl = target === "local" ? local.gatewayUrl : (await options.cloud).url;
        if (!gatewayUrl) return problemPage(res, "No Azure deployment", (await options.cloud).note, "Start the gallery with `pnpm gallery --cloud https://copilot.<environment-domain>`.");
        const link = await options.openConsole(gatewayUrl);
        if (!link.url) return problemPage(res, "Couldn't open the operator console", link.message ?? "The gateway didn't return a sign-in link.", link.hint);
        res.writeHead(302, { location: link.url, "cache-control": "no-store" });
        return res.end();
      }
      if (url.pathname.startsWith("/shots/") && serveFile(options.shotsDir, url.pathname.slice("/shots".length), res)) return;
      if (serveFile(options.webRoot, url.pathname, res, "index.html")) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    })().catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  };
}
