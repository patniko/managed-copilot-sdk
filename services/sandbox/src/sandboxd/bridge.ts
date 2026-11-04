import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";
import type { Log } from "../shared/log.js";

/** Closes a WebSocket without throwing: close reasons are capped at 123 bytes, and a socket that cannot close cleanly is terminated. */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  let text = reason;
  while (Buffer.byteLength(text, "utf8") > 120) text = text.slice(0, -1);
  try {
    if (ws.readyState === ws.OPEN) ws.close(code, text);
    else if (ws.readyState === ws.CONNECTING) ws.terminate();
  } catch {
    ws.terminate();
  }
}

/**
 * Bridges authenticated WebSocket upgrades to loopback TCP ports inside the sandbox: `/v1/runtime` to the stock
 * runtime's JSON-RPC port, `/v1/tunnel?port=` to another loopback listener (CLI attach). Binary frames carry raw
 * bytes in both directions; either side closing closes the other.
 */
export class LoopbackBridge {
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  readonly #log: Log;
  readonly #open = new Map<WebSocket, { socket: Socket; kind: "runtime" | "tunnel" }>();

  constructor(log: Log) {
    this.#log = log;
  }

  get openConnections(): number {
    return this.#open.size;
  }

  accept(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, kind: "runtime" | "tunnel"): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = connect(port, "127.0.0.1");
      tcp.setNoDelay(true);
      this.#open.set(ws, { socket: tcp, kind });
      const stream = createWebSocketStream(ws, { allowHalfOpen: false });
      let closed = false;
      const close = (reason: string) => {
        if (closed) return;
        closed = true;
        this.#open.delete(ws);
        tcp.destroy();
        stream.destroy();
        closeQuietly(ws, 1000, reason);
        this.#log.debug("bridge closed", { kind, port, reason });
      };
      ws.on("error", (error) => close(`websocket error: ${error.message}`));
      tcp.on("error", (error) => close(`tcp error: ${error.message}`));
      tcp.on("close", () => close("tcp closed"));
      stream.on("error", (error) => close(`websocket error: ${error.message}`));
      stream.on("close", () => close("websocket closed"));
      stream.pipe(tcp);
      tcp.pipe(stream);
      this.#log.debug("bridge opened", { kind, port });
    });
  }

  /** Closes bridged connections, e.g. when the runtime exits. */
  closeAll(kind?: "runtime" | "tunnel"): void {
    for (const [ws, entry] of this.#open) {
      if (kind && entry.kind !== kind) continue;
      this.#open.delete(ws);
      entry.socket.destroy();
      closeQuietly(ws, 1012, "runtime restarting");
    }
  }
}
