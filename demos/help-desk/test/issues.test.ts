import { describe, expect, it } from "vitest";
import { groupIssues, issueWorkOrder, type ReportedConversation } from "../src/server/issues.js";
import type { BugArea, BugReport, RoutedWorkOrder } from "../src/shared/types.js";

const at = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, "0")}:00.000Z`;
const report = (area: BugArea, minute: number, extra: Partial<BugReport> = {}): BugReport => ({
  area,
  title: "Out for delivery shown as Delivered",
  whatHappened: "My orders says Delivered; the carrier says out for delivery.",
  expected: "My orders says Out for delivery until it's delivered.",
  at: at(minute),
  ...extra,
});

/** A customer's conversation: what they wrote, the agent's report, and its reply. */
function conversation(index: number, bug: BugReport, words: string): ReportedConversation {
  const minute = Number(bug.at.slice(14, 16));
  return {
    customerId: `c${String(index).padStart(2, "0")}`,
    name: `Customer ${index}`,
    bug,
    items: [
      { kind: "message", id: `u${index}`, from: "customer", text: words, at: at(minute - 1) },
      { kind: "tool", id: `t${index}`, name: "report_bug", args: { area: bug.area, title: bug.title }, at: bug.at, status: "done", result: { ok: true } },
      { kind: "message", id: `a${index}`, from: "agent", text: "I reported it to our engineering team.", at: at(minute + 1) },
      { kind: "message", id: `v${index}`, from: "customer", text: "Thanks!", at: at(minute + 2) },
    ],
  };
}

describe("software issues", () => {
  it("group reports by area, in the order the areas were first reported; an area sent already stays listed", () => {
    const routed: RoutedWorkOrder = { workOrderId: "wo_1", number: 1, title: "Fix: wrong order status on My orders", status: "completed", url: "http://factory.test/#/wo/wo_1" };
    const issues = groupIssues(
      [
        { customerId: "c18", name: "Ben Carter", bug: report("promo-codes", 5) },
        { customerId: "c08", name: "Lucas Silva", bug: report("cart", 3, { orderId: "CO-48198" }) },
        { customerId: "c05", name: "Aisha Khan", bug: report("promo-codes", 4) },
      ],
      new Map([["order-status", routed]]),
    );
    expect(issues.map((issue) => [issue.area, issue.title, issue.reports.map((each) => each.customerId)])).toEqual([
      ["cart", "Wrong quantities in the cart", ["c08"]],
      ["promo-codes", "Promo codes rejected at checkout", ["c05", "c18"]],
      ["order-status", "Wrong order status on My orders", []],
    ]);
    expect(issues[0]?.reports[0]).toEqual({ customerId: "c08", name: "Lucas Silva", whatHappened: report("cart", 3).whatHappened, orderId: "CO-48198", at: at(3) });
    expect(issues[2]?.routed).toEqual(routed);
    expect(issues[0]?.routed).toBeUndefined();
  });

  it("quote what customers wrote up to their report, oldest first, and always end with the ask", () => {
    const short = Array.from({ length: 20 }, (_, index) => conversation(index + 1, report("order-status", 40 - index, { orderId: `CO-4${index}`, expected: `Expectation ${index % 3}.` }), `It says delivered (${index + 1}).`));
    const request = issueWorkOrder({ area: "order-status", runId: "r1", appUrl: "https://help-desk.example.io", reports: short, project: [{ path: "package.json", content: "{}" }] });

    expect(request.title).toBe("Fix: wrong order status on My orders");
    expect(request.origin).toEqual({ app: "help-desk", name: "Help Desk", label: "Order status · 20 tickets", url: "https://help-desk.example.io/#/c/c20", key: "r1:order-status" });
    expect(request.project).toEqual({ name: "contoso-storefront", files: [{ path: "package.json", content: "{}" }] });
    expect(request.maxReviewRounds).toBe(2);
    expect(request.brief).toContain("received 20 reports");
    expect(request.brief).toMatch(/^1\. \*\*Customer 20\*\*, order CO-419, wrote:\n\n {3}> It says delivered \(20\)\.$/m);
    expect(request.brief).toMatch(/^8\. \*\*Customer 13\*\*/m);
    expect(request.brief).toContain("12 more reports in BUG_REPORT.md.");
    expect(request.brief).toContain("- Expectation 1.\n- Expectation 0.\n- Expectation 2.");
    // What the customer wrote before the report, not after it.
    expect(request.brief).not.toContain("Thanks!");
    expect(request.context?.[0]?.content).toContain("### 20. Out for delivery shown as Delivered");
    expect(request.context?.[1]?.content).toContain("## Customer 1\n\nCustomer: It says delivered (1).");

    const long = "The label on My orders is wrong. ".repeat(20);
    const lengthy = Array.from({ length: 20 }, (_, index) => conversation(index + 1, report("order-status", 40 - index, { whatHappened: long }), long.repeat(5)));
    const big = issueWorkOrder({ area: "order-status", runId: "r1", appUrl: "https://help-desk.example.io", reports: lengthy, project: [] });
    expect(big.brief.length).toBeLessThanOrEqual(8_000);
    expect(big.brief).toMatch(/\d+ more reports in BUG_REPORT\.md\./);
    expect(big.brief.endsWith("the support conversations in `.factory/context/transcripts.md`.")).toBe(true);
    for (const file of big.context ?? []) expect(file.content.length, file.path).toBeLessThanOrEqual(60_000);
    expect(big.context?.[0]?.content).toContain("### 20. Out for delivery shown as Delivered");
  });
});
