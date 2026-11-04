// A logging forward proxy for qualifying sandbox egress: logs what arrives (CONNECT target or absolute URL, the
// Proxy-Authorization user but never its secret, the source address, or the first bytes of anything that is not HTTP)
// and forwards it. Qualification only; the platform's egress proxy is services/egress.
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const log = (entry) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

function proxyUser(header) {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !value) return `${scheme} (not basic)`;
  return Buffer.from(value, "base64").toString("utf8").split(":")[0];
}

const server = createServer((req, res) => {
  const entry = { kind: "request", method: req.method, url: req.url, host: req.headers.host, user: proxyUser(req.headers["proxy-authorization"]), source: req.socket.remoteAddress, headers: Object.keys(req.headers) };
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  log(entry);
  let target;
  try {
    target = new URL(req.url);
  } catch {
    // Origin-form: the request was not addressed to a proxy. Echo what arrived.
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(entry));
    return;
  }
  const upstream = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on("error", (error) => {
    log({ kind: "upstream-error", url: req.url, error: error.message });
    if (!res.headersSent) res.writeHead(502).end(error.message);
  });
  req.pipe(upstream);
});

server.on("connect", (req, socket, head) => {
  log({ kind: "connect", target: req.url, user: proxyUser(req.headers["proxy-authorization"]), source: socket.remoteAddress, headers: Object.keys(req.headers) });
  const [host, port] = req.url.split(":");
  const upstream = connect(Number(port) || 443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", (error) => {
    log({ kind: "connect-error", target: req.url, error: error.message });
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  socket.on("error", () => upstream.destroy());
});

server.on("clientError", (error, socket) => {
  const raw = error.rawPacket ? Buffer.from(error.rawPacket) : Buffer.alloc(0);
  log({ kind: "not-http", error: error.code, source: socket.remoteAddress, firstBytes: raw.subarray(0, 32).toString("hex"), tls: raw[0] === 0x16 });
  socket.destroy();
});

server.listen(3128, "0.0.0.0", () => log({ kind: "listening", port: 3128 }));
