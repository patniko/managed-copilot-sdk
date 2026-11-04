import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { approveAll } from "@github/copilot-sdk";
import { verifyWebhook } from "@managed-copilot/sdk";
import { lookupOrder } from "./orders.js";

/** Where the AppHost's `snippets` webhook delivers (see apphost.mts). */
export const WEBHOOK_PORT = Number(process.env.SNIPPETS_WEBHOOK_PORT ?? 7485);

export interface WebhookReceiver {
  readonly deliveries: string[];
  close(): Promise<void>;
}

/**
 * The spec's webhook handler (section 12), served locally instead of in Azure Functions: verify the signature
 * against the raw body, then claim and answer the session's listed actions with your tools.
 */
export async function startWebhookReceiver(secret: string): Promise<WebhookReceiver> {
  const deliveries: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try {
      const event = await verifyWebhook({ headers: request.headers, rawBody: Buffer.concat(chunks) }, secret); // rejects a bad signature
      deliveries.push(event.type);
      if (event.type === "session.action_required") {
        await event.handleActions({ tools: [lookupOrder], onPermissionRequest: approveAll });
      }
      response.writeHead(200).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(WEBHOOK_PORT, "127.0.0.1", () => resolve());
  });
  console.log(`Webhook receiver listening on http://localhost:${(server.address() as AddressInfo).port}/api/copilot-events`);
  return {
    deliveries,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
