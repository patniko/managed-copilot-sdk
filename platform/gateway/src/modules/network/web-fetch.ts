/**
 * `web_fetch` for shared placement: a gateway-executed platform tool that replaces the runtime's built-in, so each
 * fetch is attributed to its session and enforced with that session's network policy and the platform protections
 * (one shared runtime process cannot carry per-session egress identity). Redirects are followed by the gateway and
 * re-evaluated hop by hop.
 */
import type { IncomingMessage } from "node:http";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import type { GatewayEgress } from "./fetcher.js";
import type { PolicyService } from "./policy.js";

export const WEB_FETCH_TOOL = "web_fetch";

export const WEB_FETCH_PARAMETERS = {
  type: "object",
  properties: {
    url: { type: "string", description: "The http(s) URL to fetch." },
    max_length: { type: "number", description: "Maximum number of characters to return (default 5000, maximum 20000)." },
    start_index: { type: "number", description: "Character offset to start from, to continue reading a long page (default 0)." },
    raw: { type: "boolean", description: "Return the raw content instead of converting HTML to readable text (default false)." },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

export const WEB_FETCH_DESCRIPTION =
  "Fetches a URL from the internet and returns its content as readable text (HTML is simplified to markdown-like text). " +
  "Access follows this session's network policy; blocked destinations return an explanation.";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_DECODED_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "Managed-Copilot-web_fetch/0.1";

export interface WebFetchResult {
  readonly textResultForLlm: string;
  readonly resultType: "success" | "failure";
  readonly error?: string;
}

const failure = (message: string): WebFetchResult => ({ textResultForLlm: message, resultType: "failure", error: message });

async function readBody(response: IncomingMessage, signal: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase().trim();
  let stream: Readable = response;
  if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(createGunzip());
  else if (encoding === "deflate") stream = response.pipe(createInflate());
  else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  let raw = 0;
  let truncated = false;
  response.on("data", (chunk: Buffer) => {
    raw += chunk.length;
    if (raw > MAX_BODY_BYTES) {
      truncated = true;
      response.destroy();
    }
  });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error("The request was cancelled");
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_DECODED_BYTES) {
        truncated = true;
        chunks.push(buffer.subarray(0, buffer.length - (size - MAX_DECODED_BYTES)));
        break;
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (!truncated) throw error;
  } finally {
    response.destroy();
  }
  return { body: Buffer.concat(chunks), truncated };
}

function charset(contentType: string): BufferEncoding {
  const match = /charset=([^;]+)/i.exec(contentType);
  const name = match?.[1]?.trim().replace(/"/g, "").toLowerCase();
  if (name === "iso-8859-1" || name === "latin1" || name === "windows-1252" || name === "us-ascii") return "latin1";
  return "utf8";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Converts HTML to compact, markdown-like text: headings, links, lists, and paragraphs; scripts and styles removed. */
export function htmlToText(html: string, baseUrl?: string): { readonly title?: string; readonly text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/\s+/g, " ").trim()) : undefined;
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(body) ?? /<article[\s>][\s\S]*?<\/article>/i.exec(body);
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(body);
  body = main ? main[0] : bodyMatch ? bodyMatch[1]! : body;
  body = body.replace(/<(script|style|noscript|template|svg|head|iframe|canvas|form|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, code: string) => `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, "")).replace(/\n/g, "\u0000")}\n\`\`\`\n`);
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n\n`);
  body = body.replace(/<a\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_whole, _q, d: string, s: string, b: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const href = decodeEntities(d ?? s ?? b ?? "");
    if (!label) return "";
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return label;
    let absolute = href;
    try {
      absolute = baseUrl ? new URL(href, baseUrl).toString() : href;
    } catch {
      absolute = href;
    }
    return `[${label}](${absolute})`;
  });
  body = body.replace(/<li[^>]*>/gi, "\n- ");
  body = body.replace(/<(br|hr)\s*\/?>/gi, "\n");
  body = body.replace(/<\/(p|div|section|article|header|ul|ol|table|tr|blockquote|h[1-6]|dl|dd|dt|figure|main)>/gi, "\n\n");
  body = body.replace(/<(td|th)[^>]*>/gi, " | ");
  body = body.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  body = body.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  body = body.replace(/<[^>]+>/g, "");
  body = decodeEntities(body);
  body = body
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "\n")
    .trim();
  return { ...(title ? { title } : {}), text: body };
}

export interface WebFetchDependencies {
  readonly policy: PolicyService;
  readonly egress: GatewayEgress;
}

export interface WebFetchArgs {
  readonly url?: unknown;
  readonly max_length?: unknown;
  readonly start_index?: unknown;
  readonly raw?: unknown;
}

/** Runs one `web_fetch` call for a session. Never throws for expected failures; the model gets an explanation. */
export async function webFetch(args: WebFetchArgs, context: { readonly sessionId: string; readonly signal?: AbortSignal }, deps: WebFetchDependencies): Promise<WebFetchResult> {
  if (typeof args.url !== "string" || !args.url.trim()) return failure("web_fetch needs a url.");
  let url: URL;
  try {
    url = new URL(args.url.trim());
  } catch {
    return failure(`"${args.url.slice(0, 200)}" is not a valid URL.`);
  }
  const maxLength = Math.min(20_000, Math.max(1, Math.floor(typeof args.max_length === "number" ? args.max_length : 5_000)));
  const startIndex = Math.max(0, Math.floor(typeof args.start_index === "number" ? args.start_index : 0));
  const raw = args.raw === true;
  const session = deps.policy.session(context.sessionId);
  if (!session) return failure("Web access is unavailable: this session has no network policy binding.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const abort = () => controller.abort();
  context.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let result;
      try {
        result = await deps.egress.request(session.policy, url, {
          headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5", "accept-encoding": "gzip, deflate, br", "user-agent": USER_AGENT },
          signal: controller.signal,
        });
      } catch (error) {
        return failure(`Could not fetch ${url.toString()}: ${controller.signal.aborted ? "the request timed out or was cancelled" : (error as Error).message}.`);
      }
      if (!result.decision.ok) {
        const decision = result.decision;
        if (decision.reason !== "dns_failed") {
          deps.policy.recordForSession(context.sessionId, {
            sandboxId: "",
            at: new Date().toISOString(),
            reason: decision.reason,
            message: decision.message,
            ...(decision.host ? { host: decision.host } : {}),
            ...(decision.port ? { port: decision.port } : {}),
            method: "GET",
            path: url.pathname.slice(0, 512),
          });
          return failure(`Blocked by this session's network policy: ${decision.message}`);
        }
        return failure(decision.message);
      }
      const response = "response" in result ? result.response : undefined;
      if (!response) return failure(`Could not fetch ${url.toString()}.`);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        response.destroy();
        try {
          url = new URL(location, url);
        } catch {
          return failure(`${url.toString()} redirected to an invalid location.`);
        }
        continue;
      }
      const contentType = String(response.headers["content-type"] ?? "");
      const { body, truncated } = await readBody(response, controller.signal);
      let text: string;
      let title: string | undefined;
      if (/^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml))/i.test(contentType) || contentType === "") {
        const decoded = body.toString(charset(contentType));
        if (!raw && /html/i.test(contentType)) {
          const converted = htmlToText(decoded, url.toString());
          text = converted.text;
          title = converted.title;
        } else if (/json/i.test(contentType)) {
          try {
            text = JSON.stringify(JSON.parse(decoded), null, 2);
          } catch {
            text = decoded;
          }
        } else {
          text = decoded;
        }
      } else {
        text = `(${contentType || "binary"} content, ${body.length} bytes, not shown)`;
      }
      const slice = text.slice(startIndex, startIndex + maxLength);
      const more = startIndex + maxLength < text.length;
      const header = [`Contents of ${url.toString()}${status >= 400 ? ` (HTTP ${status})` : ""}:`, ...(title ? [`Title: ${title}`] : [])].join("\n");
      const notes = [
        ...(more ? [`<content truncated: ${text.length - startIndex - maxLength} more characters; call web_fetch with start_index=${startIndex + maxLength} to read more>`] : []),
        ...(truncated ? ["<download truncated at the size limit>"] : []),
        ...(startIndex >= text.length && text.length > 0 ? [`<start_index ${startIndex} is past the end of the content (${text.length} characters)>`] : []),
      ];
      const output = [header, slice, ...notes].filter(Boolean).join("\n\n");
      return status >= 400 ? { textResultForLlm: output, resultType: "failure", error: `HTTP ${status}` } : { textResultForLlm: output, resultType: "success" };
    }
    return failure(`Too many redirects (more than ${MAX_REDIRECTS}) starting from ${args.url}.`);
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
  }
}
