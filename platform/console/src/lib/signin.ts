/** Console sign-in helpers: the ticket fragment and the terminal command that issues one. */

/**
 * The one-time ticket in a sign-in URL fragment (`#ticket=...`). Fragments never reach the server; the console strips
 * it from the address bar before redeeming it.
 */
export function readTicket(hash: string | undefined | null): string | undefined {
  if (!hash) return undefined;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of raw.split("&")) {
    if (!part.startsWith("ticket=")) continue;
    let ticket: string;
    try {
      // decodeURIComponent (not URLSearchParams) so a literal "+" in a ticket is never read as a space.
      ticket = decodeURIComponent(part.slice("ticket=".length)).trim();
    } catch {
      return undefined;
    }
    return ticket ? ticket : undefined;
  }
  return undefined;
}

export function hasTicket(hash: string | undefined | null): boolean {
  return Boolean(hash && hash.includes("ticket="));
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * The command that opens the console signed in. Local gateways are found automatically; any other origin is passed
 * with `--url`.
 */
export function consoleCommand(origin: string): string {
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname) ? "npx managed-copilot console" : `npx managed-copilot console --url ${url.origin}`;
  } catch {
    return "npx managed-copilot console";
  }
}
