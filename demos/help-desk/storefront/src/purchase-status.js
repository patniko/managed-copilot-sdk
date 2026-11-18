// The status "My purchases" shows next to each order, from the payment provider's events. Events arrive from the
// provider's webhooks as `{ at, description }`, in any order, and each payment method words them its own way, so the
// label is matched loosely from the latest event's description.

/** The labels My purchases shows. */
export const LABELS = ["Processing", "Pending", "Unlocked", "Refunded"];

/** The payment provider's latest event, by time. */
export function latestEvent(events) {
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
}

/** The label My purchases shows for an order: "Processing" until the payment provider first reports on it. */
export function statusLabel(events) {
  if (!Array.isArray(events) || events.length === 0) return "Processing";
  const { description } = latestEvent(events);
  if (/refund/i.test(description)) return "Refunded";
  if (/unlock/i.test(description)) return "Unlocked";
  if (/pending|held|review/i.test(description)) return "Pending";
  return "Processing";
}
