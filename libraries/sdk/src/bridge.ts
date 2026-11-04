#!/usr/bin/env node
// Spawned by the stock SDK via RuntimeConnection.forStdio({ path: <this file> }).
// Reads BridgeConfig from MANAGED_COPILOT_BRIDGE, ignores the runtime flags the SDK appends
// (--headless, --no-auto-update, --stdio, ...), and relays framed JSON-RPC between stdio and the gateway.
// Starts no local agent and never prints credentials.
import {
  APP_KEY_HEADER,
  APP_USER_HEADER,
  APP_USER_NAME_HEADER,
  BRIDGE_ENV,
  BRIDGE_HELLO,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_SUBPROTOCOL,
  BRIDGE_WELCOME,
  encodeHeaderValue,
  type BridgeConfig,
  type BridgeHello,
  type BridgeWelcome,
} from "@managed-copilot/protocol";
import { WebSocket } from "ws";

const PREFIX = "[managed-copilot]";

/**
 * Pings the gateway this often (`MANAGED_COPILOT_BRIDGE_PING_MS` overrides it for tests). Proxies in front of a
 * deployment close WebSockets that carry nothing for a while (Azure Container Apps ingress after 240 s), and a
 * half-open connection never reports itself closed: a gateway that answers nothing for three intervals is gone.
 */
const PING_INTERVAL_MS = (() => {
  const override = Number(process.env["MANAGED_COPILOT_BRIDGE_PING_MS"]);
  return Number.isSafeInteger(override) && override > 0 ? override : 30_000;
})();

/** How long a refused bridge keeps answering requests the SDK sent meanwhile before it ends. */
const REFUSAL_GRACE_MS = 1000;

function fail(message: string): never {
  process.stderr.write(`${PREFIX} ${message}\n`);
  process.exit(1);
}

function readConfig(): BridgeConfig {
  const raw = process.env[BRIDGE_ENV];
  delete process.env[BRIDGE_ENV];
  if (!raw) fail(`This program is started by @managed-copilot/sdk; ${BRIDGE_ENV} is not set.`);
  let config: Partial<BridgeConfig>;
  try {
    config = JSON.parse(raw) as Partial<BridgeConfig>;
  } catch {
    fail(`${BRIDGE_ENV} is not valid JSON.`);
  }
  if (
    typeof config.url !== "string" ||
    typeof config.environment !== "object" ||
    config.environment === null ||
    (config.token !== undefined && (typeof config.token !== "string" || !config.token)) ||
    (config.appKey !== undefined && (typeof config.appKey !== "string" || !config.appKey)) ||
    (config.appUser !== undefined && (typeof config.appUser !== "object" || config.appUser === null || typeof config.appUser.id !== "string")) ||
    (!config.token && !(config.appKey && config.appUser))
  ) {
    fail(`${BRIDGE_ENV} is incomplete (url, environment, and a GitHub token or an app key with an app user are required).`);
  }
  return config as BridgeConfig;
}

/** The upgrade request's credentials: a GitHub token, an app key, and the app user it acts for. */
function credentialHeaders(config: BridgeConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.token) headers["authorization"] = `Bearer ${config.token}`;
  if (config.appKey) headers[APP_KEY_HEADER] = config.appKey;
  if (config.appUser) {
    headers[APP_USER_HEADER] = encodeHeaderValue(config.appUser.id);
    if (config.appUser.name) headers[APP_USER_NAME_HEADER] = encodeHeaderValue(config.appUser.name);
  }
  return headers;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function checkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("The gateway URL is invalid.");
  }
  if (url.username || url.password) fail("The gateway URL must not embed credentials.");
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:" && (LOOPBACK.has(url.hostname) || /^127\./.test(url.hostname))) return url;
  fail(`Refusing to send credentials to ${url.origin}: remote deployments must use https.`);
}

/** Splits LSP frames (`Content-Length: N\r\n\r\n<body>`) from the SDK's stdin. */
function frameReader(onMessage: (body: string) => void): (chunk: Buffer) => void {
  const chunks: Buffer[] = [];
  let size = 0;
  /** Total bytes the current frame needs (header + body), once its header is parsed. */
  let needed = 0;
  let headerLength = 0;
  const contiguous = (): Buffer => {
    if (chunks.length > 1) {
      const joined = Buffer.concat(chunks, size);
      chunks.length = 0;
      chunks.push(joined);
    }
    return chunks[0] ?? Buffer.alloc(0);
  };
  return (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    for (;;) {
      if (needed === 0) {
        const buffer = contiguous();
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (size > 8192) fail("Received a malformed message from the Copilot SDK.");
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const match = /(?:^|\r\n)content-length:\s*(\d{1,10})\s*(?:\r\n|$)/i.exec(header);
        const length = match ? Number(match[1]) : Number.NaN;
        if (!Number.isSafeInteger(length) || length < 0) fail("Received a malformed message from the Copilot SDK.");
        if (length > BRIDGE_MAX_FRAME_BYTES) fail(`A message from the Copilot SDK exceeds ${BRIDGE_MAX_FRAME_BYTES} bytes; send large files with managed.files(session).`);
        headerLength = headerEnd + 4;
        needed = headerLength + length;
      }
      if (size < needed) return;
      const buffer = contiguous();
      onMessage(buffer.subarray(headerLength, needed).toString("utf8"));
      const rest = buffer.subarray(needed);
      chunks.length = 0;
      size = rest.length;
      if (size > 0) chunks.push(rest);
      needed = 0;
      headerLength = 0;
    }
  };
}

function writeFrame(body: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

/** Close reasons are `<error code>: <message>`. */
function describeClose(code: number, reason: string): string {
  const separator = reason.indexOf(": ");
  const message = separator > 0 ? reason.slice(separator + 2) : reason || "the connection closed";
  const errorCode = separator > 0 ? reason.slice(0, separator) : `close code ${code}`;
  return `Managed Copilot closed the connection: ${message} (${errorCode})`;
}

function main(): void {
  const config = readConfig();
  const url = checkUrl(config.url);
  const ws = new WebSocket(url, [BRIDGE_SUBPROTOCOL], {
    headers: credentialHeaders(config),
    perMessageDeflate: false,
    maxPayload: BRIDGE_MAX_FRAME_BYTES,
    // Longer than the gateway's GitHub verification deadline, so its explicit error wins over a generic timeout.
    handshakeTimeout: 45_000,
  });
  const pending: string[] = [];
  let ready = false;
  let stdinEnded = false;

  /**
   * The gateway refused the connection, or could not be reached, before welcoming it (an environment this caller may
   * not use, for example). The SDK is waiting on requests it already sent (`connect`), or is about to send them: answer
   * each with the refusal, so the caller gets that explicit error instead of a dropped connection, then end.
   */
  let refusal: string | undefined;
  const answer = (body: string): void => {
    let request: { id?: unknown; method?: unknown };
    try {
      request = JSON.parse(body) as { id?: unknown; method?: unknown };
    } catch {
      return;
    }
    if ((typeof request.id !== "number" && typeof request.id !== "string") || typeof request.method !== "string") return;
    writeFrame(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: `${PREFIX} ${refusal}` } }));
  };
  const refuse = (message: string): void => {
    // Once, and nothing more from the gateway afterwards (an error is followed by a close).
    if (refusal !== undefined) return;
    refusal = message;
    ws.removeAllListeners();
    ws.on("error", () => undefined);
    ws.terminate();
    process.stderr.write(`${PREFIX} ${message}\n`);
    if (ready) process.exit(1);
    for (const body of pending.splice(0)) answer(body);
    // Requests still on their way get the same answer; then the bridge ends, once its answers are written.
    setTimeout(() => process.stdout.write("", () => process.exit(1)), REFUSAL_GRACE_MS);
  };

  const send = (body: string) => {
    if (refusal !== undefined) answer(body);
    else if (ready && ws.readyState === WebSocket.OPEN) ws.send(body);
    else pending.push(body);
  };

  process.stdin.on("data", frameReader(send));
  process.stdin.on("end", () => {
    stdinEnded = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "client stopped");
    setTimeout(() => process.exit(0), 2000).unref();
  });
  process.stdout.on("error", () => process.exit(0));

  ws.on("unexpected-response", (_request, response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => {
      if (chunks.reduce((size, item) => size + item.length, 0) < 65536) chunks.push(chunk);
    });
    response.on("end", () => {
      let message = `HTTP ${response.statusCode}`;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: string; message?: string } };
        if (body.error?.message) message = `${body.error.message} (${body.error.code ?? `HTTP ${response.statusCode}`})`;
      } catch {
        // Keep the status-only message.
      }
      refuse(`Managed Copilot rejected the connection: ${message}`);
    });
  });

  ws.on("open", () => {
    const hello: BridgeHello = { type: BRIDGE_HELLO, version: 1, environment: config.environment, ...(config.clientName ? { clientName: config.clientName } : {}) };
    ws.send(JSON.stringify(hello));
    let heard = Date.now();
    const alive = () => {
      heard = Date.now();
    };
    ws.on("pong", alive);
    ws.on("message", alive);
    const keepalive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - heard > PING_INTERVAL_MS * 3) {
        clearInterval(keepalive);
        ws.terminate();
        const silence = PING_INTERVAL_MS * 3;
        fail(`The connection to Managed Copilot at ${url.origin} stopped responding (no answer for ${silence < 1000 ? `${silence} ms` : `${Math.round(silence / 1000)} s`}).`);
      }
      ws.ping();
    }, PING_INTERVAL_MS);
    keepalive.unref();
    ws.once("close", () => clearInterval(keepalive));
  });

  ws.on("message", (data, isBinary) => {
    const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
    if (!ready) {
      let welcome: Partial<BridgeWelcome> | undefined;
      try {
        welcome = JSON.parse(text) as Partial<BridgeWelcome>;
      } catch {
        welcome = undefined;
      }
      if (!welcome || typeof welcome !== "object") {
        refuse("The gateway answered the handshake with an invalid frame. (capability_unavailable)");
        return;
      }
      if (welcome.type !== BRIDGE_WELCOME) {
        refuse("The gateway answered the handshake with an unexpected frame. (capability_unavailable)");
        return;
      }
      ready = true;
      for (const body of pending.splice(0)) ws.send(body);
      return;
    }
    writeFrame(text);
  });

  ws.on("close", (code, reasonBuffer) => {
    if (stdinEnded || code === 1000) process.exit(0);
    refuse(describeClose(code, reasonBuffer.toString("utf8")));
  });

  ws.on("error", (error: Error & { code?: string }) => {
    if (stdinEnded) process.exit(0);
    // Before the welcome, the SDK is waiting on requests it sent: they get this error rather than a dropped connection.
    refuse(`Cannot reach Managed Copilot at ${url.origin}: ${error.code ?? error.message} (capability_unavailable)`);
  });
}

main();
