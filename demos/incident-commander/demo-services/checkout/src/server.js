import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { CheckoutError, priceCart } from "./cart.js";

const VERSION = "1.4.2";

function log(level, fields) {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === "string" && /\s/.test(value) ? JSON.stringify(value) : value}`);
  console.log(`${new Date().toISOString()} level=${level} ${pairs.join(" ")}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** POST /checkout: prices the cart and accepts the order. */
export async function handleCheckout(req, res) {
  const started = Date.now();
  const id = randomUUID().slice(0, 6);
  let cart = {};
  try {
    cart = await readBody(req);
    const order = { id, ...priceCart(cart) };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(order));
    log("info", { msg: "request", req: id, method: "POST", path: "/checkout", status: 200, duration_ms: Date.now() - started, items: cart.items.length, coupon: cart.coupon ?? "none" });
  } catch (error) {
    const status = error instanceof CheckoutError ? error.status : 500;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: status === 500 ? "Something went wrong." : error.message }));
    log(status === 500 ? "error" : "warn", { msg: status === 500 ? "request failed" : "request rejected", req: id, method: "POST", path: "/checkout", status, duration_ms: Date.now() - started, items: cart.items?.length ?? 0, coupon: cart.coupon ?? "none", error: String(error) });
    if (status === 500) console.log(error.stack.split("\n").slice(1, 4).join("\n"));
  }
}

export function createApp() {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/checkout") return void handleCheckout(req, res);
    if (req.method === "GET" && req.url === "/health") return void res.writeHead(200).end("ok");
    res.writeHead(404).end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  createApp().listen(port, () => log("info", { msg: "starting checkout-service", version: VERSION, port }));
}
