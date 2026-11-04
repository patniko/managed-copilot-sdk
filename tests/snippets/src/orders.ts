import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

/** Your app's data. Tool handlers read it in your process; it never reaches the platform. */
const ORDERS: Record<string, { id: string; status: string; carrier: string; eta: string }> = {
  "1234": { id: "1234", status: "shipped", carrier: "UPS", eta: "Friday" },
  "5678": { id: "5678", status: "processing", carrier: "pending", eta: "next week" },
};

/** Every lookup the agent made, so snippets can show the handler really ran here. */
export const lookups: string[] = [];

export const orders = {
  get(id: string) {
    lookups.push(id);
    return ORDERS[id] ?? { id, status: "not found" };
  },
};

/** The spec's `lookupOrder` tool (section 3), shared by the snippets that reuse it. */
export const lookupOrder = defineTool("lookup_order", {
  description: "Look up an order by id",
  parameters: z.object({ id: z.string() }),
  handler: async ({ id }) => orders.get(id), // runs in YOUR process; your database credentials never leave it
});
