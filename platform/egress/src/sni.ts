/**
 * Reads the first TLS ClientHello from a tunnel and extracts its server name (SNI), so the proxy can verify that a
 * CONNECT tunnel carries TLS for the host it was authorized for. Handles ClientHellos split across TCP segments and
 * TLS records.
 */
import type { Duplex } from "node:stream";

export type ClientHelloResult =
  | { readonly kind: "tls"; readonly serverName?: string }
  | { readonly kind: "incomplete" }
  | { readonly kind: "not_tls" }
  | { readonly kind: "malformed" };

const HANDSHAKE = 0x16;
const CLIENT_HELLO = 0x01;
const MAX_RECORD = 16384 + 2048;
const MAX_HELLO = 64 * 1024;

const MALFORMED: ClientHelloResult = { kind: "malformed" };

export function parseClientHello(buffer: Buffer): ClientHelloResult {
  if (buffer.length === 0) return { kind: "incomplete" };
  if (buffer[0] !== HANDSHAKE) return { kind: "not_tls" };
  if (buffer.length >= 2 && buffer[1] !== 0x03) return { kind: "not_tls" };
  const fragments: Buffer[] = [];
  let collected = 0;
  let offset = 0;
  let needed: number | undefined;
  for (;;) {
    if (buffer.length < offset + 5) return { kind: "incomplete" };
    if (buffer[offset] !== HANDSHAKE) return MALFORMED;
    const length = buffer.readUInt16BE(offset + 3);
    if (length === 0 || length > MAX_RECORD) return MALFORMED;
    if (buffer.length < offset + 5 + length) return { kind: "incomplete" };
    fragments.push(buffer.subarray(offset + 5, offset + 5 + length));
    collected += length;
    offset += 5 + length;
    if (needed === undefined && collected >= 4) {
      const head = Buffer.concat(fragments);
      if (head[0] !== CLIENT_HELLO) return MALFORMED;
      needed = 4 + head.readUIntBE(1, 3);
      if (needed > MAX_HELLO) return MALFORMED;
    }
    if (needed !== undefined && collected >= needed) return parseHelloBody(Buffer.concat(fragments).subarray(4, needed));
  }
}

function parseHelloBody(body: Buffer): ClientHelloResult {
  let p = 2 + 32; // legacy_version, random
  const need = (count: number) => p + count <= body.length;
  if (!need(1)) return MALFORMED;
  p += 1 + body[p]!; // session id
  if (!need(2)) return MALFORMED;
  p += 2 + body.readUInt16BE(p); // cipher suites
  if (!need(1)) return MALFORMED;
  p += 1 + body[p]!; // compression methods
  if (p === body.length) return { kind: "tls" };
  if (!need(2)) return MALFORMED;
  const end = p + 2 + body.readUInt16BE(p);
  p += 2;
  if (end > body.length) return MALFORMED;
  while (p + 4 <= end) {
    const type = body.readUInt16BE(p);
    const length = body.readUInt16BE(p + 2);
    p += 4;
    if (p + length > end) return MALFORMED;
    if (type === 0x0000) return parseServerName(body.subarray(p, p + length));
    p += length;
  }
  return p === end ? { kind: "tls" } : MALFORMED;
}

function parseServerName(data: Buffer): ClientHelloResult {
  if (data.length < 2) return MALFORMED;
  const end = 2 + data.readUInt16BE(0);
  if (end > data.length) return MALFORMED;
  let p = 2;
  while (p + 3 <= end) {
    const type = data[p]!;
    const length = data.readUInt16BE(p + 1);
    p += 3;
    if (p + length > end) return MALFORMED;
    if (type === 0) {
      const name = data.toString("latin1", p, p + length);
      return /^[\x21-\x7e]+$/.test(name) ? { kind: "tls", serverName: name } : MALFORMED;
    }
    p += length;
  }
  return { kind: "tls" };
}

/**
 * Buffers bytes from `socket` (starting with `initial`) until a complete ClientHello is available, the data is
 * clearly not TLS, or the timeout expires (`incomplete`). The socket is paused afterwards; forward `data` first.
 */
export function readClientHello(
  socket: Duplex,
  initial: Buffer,
  options: { readonly timeoutMs: number },
): Promise<{ readonly result: ClientHelloResult; readonly data: Buffer }> {
  return new Promise((resolve) => {
    let data = initial;
    let done = false;
    const finish = (result: ClientHelloResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onClose);
      socket.off("close", onClose);
      socket.off("error", onClose);
      socket.pause();
      resolve({ result, data });
    };
    const check = () => {
      const result = parseClientHello(data);
      if (result.kind !== "incomplete") finish(result);
      else if (data.length > MAX_HELLO + 5 * 8) finish(MALFORMED);
    };
    const onData = (chunk: Buffer) => {
      data = data.length === 0 ? chunk : Buffer.concat([data, chunk]);
      check();
    };
    const onClose = () => finish({ kind: "incomplete" });
    const timer = setTimeout(onClose, options.timeoutMs);
    socket.on("data", onData);
    socket.once("end", onClose);
    socket.once("close", onClose);
    socket.once("error", onClose);
    if (data.length > 0) check();
    if (!done) socket.resume();
  });
}
