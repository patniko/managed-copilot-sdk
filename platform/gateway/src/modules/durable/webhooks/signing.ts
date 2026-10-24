import { createHmac } from "node:crypto";

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` (protocol `WEBHOOK_HEADERS.signature`). */
export function signWebhook(secret: string, body: string | Buffer, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(body).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}
