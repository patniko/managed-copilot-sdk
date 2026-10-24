import { createServer, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { connect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseClientHello, readClientHello } from "../src/sni.js";

/** Captures the first bytes a real Node TLS client sends (its ClientHello). */
async function captureClientHello(servername: string | undefined): Promise<Buffer> {
  let server: Server | undefined;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      server = createServer((socket: Socket) => {
        socket.once("data", (data: Buffer) => {
          resolve(data);
          socket.destroy();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as { port: number }).port;
        const client = connect({ host: "127.0.0.1", port, ...(servername ? { servername } : {}), rejectUnauthorized: false });
        client.on("error", () => undefined);
      });
      server.on("error", reject);
    });
  } finally {
    server?.close();
  }
}

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);

function serverNameExtension(names: ReadonlyArray<readonly [number, string]>): Buffer {
  const list = Buffer.concat(names.map(([type, name]) => Buffer.concat([Buffer.from([type]), u16(name.length), Buffer.from(name, "latin1")])));
  return Buffer.concat([u16(list.length), list]);
}

/** A minimal ClientHello record with the given extensions; `rawExtensions` and `trailing` model malformed framing. */
function syntheticHello(extensions: ReadonlyArray<readonly [number, Buffer]>, rawExtensions?: Buffer, trailing?: Buffer): Buffer {
  const block = Buffer.concat([...extensions.map(([type, data]) => Buffer.concat([u16(type), u16(data.length), data])), ...(rawExtensions ? [rawExtensions] : [])]);
  const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), u16(block.length), block, ...(trailing ? [trailing] : [])]);
  const handshake = Buffer.concat([Buffer.from([0x01, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}

describe("ClientHello parsing", () => {
  let hello: Buffer;
  beforeAll(async () => {
    hello = await captureClientHello("api.example.test");
  });

  it("extracts the server name from a real ClientHello", () => {
    expect(parseClientHello(hello)).toEqual({ kind: "tls", serverName: "api.example.test" });
  });

  it("reports missing SNI", async () => {
    const noSni = await captureClientHello(undefined);
    expect(parseClientHello(noSni)).toEqual({ kind: "tls" });
  });

  it("waits for more bytes on partial input", () => {
    for (const length of [1, 3, 5, 20, hello.length - 1]) expect(parseClientHello(hello.subarray(0, length)).kind).toBe("incomplete");
  });

  it("reassembles a ClientHello split across TLS records", () => {
    const body = hello.subarray(5);
    const split = 40;
    const record = (fragment: Buffer) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01, fragment.length >> 8, fragment.length & 0xff]), fragment]);
    const fragmented = Buffer.concat([record(body.subarray(0, split)), record(body.subarray(split))]);
    expect(parseClientHello(fragmented)).toEqual({ kind: "tls", serverName: "api.example.test" });
  });

  it("recognizes non-TLS and malformed data", () => {
    expect(parseClientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n")).kind).toBe("not_tls");
    expect(parseClientHello(Buffer.from("SSH-2.0-OpenSSH_9.6\r\n")).kind).toBe("not_tls");
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x02, 0x00, 0x00, 0x01, 0x00])).kind).toBe("malformed");
    const corrupt = Buffer.from(hello);
    corrupt.writeUInt16BE(0xffff, 5 + 4 + 2 + 32 + 1 + corrupt[5 + 4 + 2 + 32]!);
    expect(parseClientHello(corrupt).kind).toBe("malformed");
  });

  it("rejects ambiguous or trailing extensions instead of trusting the first server name", () => {
    const sni = (...names: Array<readonly [number, string]>) => serverNameExtension(names);
    expect(parseClientHello(syntheticHello([[0x0000, sni([0, "api.example.test"])]]))).toEqual({ kind: "tls", serverName: "api.example.test" });
    expect(parseClientHello(syntheticHello([[0x0000, sni([7, "other"], [0, "api.example.test"])], [0x000a, Buffer.from([0, 2, 0, 0x1d])]]))).toEqual({
      kind: "tls",
      serverName: "api.example.test",
    });
    const cases: Record<string, Buffer> = {
      "two server_name extensions": syntheticHello([
        [0x0000, sni([0, "api.example.test"])],
        [0x0000, sni([0, "evil.example.test"])],
      ]),
      "two host names in one extension": syntheticHello([[0x0000, sni([0, "api.example.test"], [0, "evil.example.test"])]]),
      "an empty server name list": syntheticHello([[0x0000, Buffer.from([0, 0])]]),
      "a repeated extension type": syntheticHello([
        [0x000a, Buffer.from([0, 2, 0, 0x1d])],
        [0x0000, sni([0, "api.example.test"])],
        [0x000a, Buffer.from([0, 2, 0, 0x17])],
      ]),
      "a truncated extension after the server name": syntheticHello([[0x0000, sni([0, "api.example.test"])]], Buffer.from([0x00, 0x0a, 0x00, 0x09, 0x00])),
      "bytes after the extensions": syntheticHello([[0x0000, sni([0, "api.example.test"])]], undefined, Buffer.from([0x00])),
    };
    for (const [name, hello] of Object.entries(cases)) expect(parseClientHello(hello).kind, name).toBe("malformed");
  });

  it("reads a ClientHello that arrives one byte at a time", async () => {
    const stream = new PassThrough();
    const pending = readClientHello(stream, hello.subarray(0, 2), { timeoutMs: 2_000 });
    for (const byte of hello.subarray(2)) stream.write(Buffer.from([byte]));
    const { result, data } = await pending;
    expect(result).toEqual({ kind: "tls", serverName: "api.example.test" });
    expect(data.equals(hello)).toBe(true);
  });

  it("times out as incomplete", async () => {
    const stream = new PassThrough();
    const { result } = await readClientHello(stream, Buffer.alloc(0), { timeoutMs: 50 });
    expect(result.kind).toBe("incomplete");
  });
});

afterAll(() => undefined);
