/** Cookies for browser sign-ins and the GitHub sign-in round trip. */
import type { IncomingMessage, ServerResponse } from "node:http";

/** Browser sign-ins last 30 days and extend while used. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** A GitHub sign-in must come back within 15 minutes. */
export const OAUTH_TTL_MS = 15 * 60_000;

/** `__Host-` cookies are HTTPS-only, host-only, and path `/`: the browser enforces all three. */
export const sessionCookie = (secure: boolean) => (secure ? "__Host-fd_session" : "fd_session");
export const oauthCookie = (secure: boolean) => (secure ? "__Host-fd_oauth" : "fd_oauth");

export function readCookies(req: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function append(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("set-cookie");
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader("set-cookie", [...list, cookie]);
}

export function setCookie(res: ServerResponse, name: string, value: string, options: { secure: boolean; maxAgeMs: number }): void {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(options.maxAgeMs / 1000)}`];
  if (options.secure) parts.push("Secure");
  append(res, parts.join("; "));
}

export function clearCookie(res: ServerResponse, name: string, options: { secure: boolean }): void {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (options.secure) parts.push("Secure");
  append(res, parts.join("; "));
}
