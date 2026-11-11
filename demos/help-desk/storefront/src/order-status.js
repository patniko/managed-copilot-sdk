// The status "My orders" shows next to each order, from the carrier's tracking scans. Scans arrive from the carriers'
// webhooks as `{ at, location, description }`, in any order, and each carrier words them its own way, so the label is
// matched loosely from the latest scan's description.

/** The labels My orders shows. */
export const LABELS = ["Processing", "In transit", "Delayed", "Delivered"];

/** The carrier's latest scan, by time. */
export function latestScan(scans) {
  return [...scans].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
}

/** The label My orders shows for a shipment: "Processing" until the carrier first scans the package. */
export function statusLabel(scans) {
  if (!Array.isArray(scans) || scans.length === 0) return "Processing";
  const { description } = latestScan(scans);
  if (/deliver/i.test(description)) return "Delivered";
  if (/delay|exception|held/i.test(description)) return "Delayed";
  return "In transit";
}
