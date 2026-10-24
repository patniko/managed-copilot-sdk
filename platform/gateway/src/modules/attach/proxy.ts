import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { filterAhpClientFrame } from "@managed-copilot/protocol";
import { WebSocket, type RawData } from "ws";
import type { Logger } from "../../log.js";
import type { AhpHost } from "./hosts.js";

/** `ws` treats its transport as a net.Socket; tunnels from the sandbox relay are plain duplex streams. */
function asSocket(stream: Duplex): Socket {
  const socket = stream as Duplex & Partial<Socket>;
  socket.setNoDelay ??= () => socket as Socket;
  socket.setTimeout ??= () => socket as Socket;
  socket.setKeepAlive ??= () => socket as Socket;
  socket.ref ??= () => socket as Socket;
  socket.unref ??= () => socket as Socket;
  return socket as Socket;
}

/** Opens a WebSocket to the host's loopback listener through the runtime's own network namespace. */
export async function openUpstream(host: AhpHost, protocols: readonly string[]): Promise<WebSocket> {
  const stream = asSocket(await host.runtime.connect(host.port));
  const url = new URL(`ws://127.0.0.1:${host.port}/`);
  url.searchParams.set("tkn", host.token);
  const upstream = new WebSocket(url, [...protocols], {
    createConnection: () => stream,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  });
  return new Promise<WebSocket>((resolve, reject) => {
    const fail = (error: Error) => {
      upstream.terminate();
      reject(error);
    };
    upstream.once("open", () => {
      upstream.off("error", fail);
      resolve(upstream);
    });
    upstream.once("error", fail);
    upstream.once("unexpected-response", (_request, response) => fail(new Error(`The session's AHP listener refused the connection (HTTP ${response.statusCode})`)));
  });
}

function closeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

/** Relays one attached client to its session's AHP listener until either side closes or the lifetime ends. */
export function bridge(client: WebSocket, upstream: WebSocket, options: { readonly log: Logger; readonly sessionId: string; readonly maxLifetimeMs: number }): void {
  const { log, sessionId } = options;
  const lifetime = setTimeout(() => client.close(4408, "Attachment expired. Attach again to continue."), options.maxLifetimeMs);
  lifetime.unref();

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      client.close(1003, "Copilot CLI attach carries JSON text frames only.");
      return;
    }
    const filtered = filterAhpClientFrame(data.toString());
    if (filtered.invalid) {
      client.close(1007, "Copilot CLI attach carries JSON-RPC messages only.");
      return;
    }
    if (filtered.refused.length > 0) log.info("Refused credential-bearing messages from an attached client", { sessionId, methods: filtered.refused });
    for (const reply of filtered.replies) client.send(reply);
    if (filtered.forward !== undefined && upstream.readyState === WebSocket.OPEN) upstream.send(filtered.forward);
  });
  upstream.on("message", (data: RawData, isBinary: boolean) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  client.on("close", () => {
    clearTimeout(lifetime);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000);
  });
  upstream.on("close", (code: number, reason: Buffer) => {
    clearTimeout(lifetime);
    if (client.readyState === WebSocket.OPEN) client.close(closeCode(code), reason.toString().slice(0, 120));
  });
  client.on("error", (error: Error) => log.debug("Attached client socket error", { sessionId, error: error.message }));
  upstream.on("error", (error: Error) => {
    log.warn("Session AHP listener connection failed", { sessionId, error: error.message });
    if (client.readyState === WebSocket.OPEN) client.close(1011, "The session's runtime connection failed.");
  });
}
