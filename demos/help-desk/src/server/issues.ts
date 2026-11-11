// Software issues: the current simulation's bug reports grouped by the part of the store's website they're about, and
// the work order Software Factory gets for one issue: a brief, the reports and conversations as context, and the
// storefront codebase to fix. Pure: the desk supplies the tickets and the codebase's files.
import { BUG_AREA_INFO, BUG_AREAS, type BugArea, type BugReport, type MessageItem, type RoutedWorkOrder, type SoftwareIssue, type TranscriptItem } from "../shared/types.js";
import type { FactoryFile, WorkOrderRequest } from "./factory.js";

/** The storefront codebase: the project Software Factory changes. */
export const STOREFRONT = "contoso-storefront";

const MAX_BRIEF = 8_000;
/** The most reports the brief quotes; BUG_REPORT.md has every one. */
const BRIEF_REPORTS = 8;
/** Each context file stays well under Software Factory's limits (256 KB a file, 512 KB together). */
const MAX_CONTEXT = 60_000;

/** A ticket's bug report. */
export interface Reported {
  readonly customerId: string;
  readonly name: string;
  readonly bug: BugReport;
}

/** A ticket's bug report and its conversation, for a work order. */
export interface ReportedConversation extends Reported {
  readonly items: readonly TranscriptItem[];
}

export function isBugArea(value: string): value is BugArea {
  return (BUG_AREAS as readonly string[]).includes(value);
}

/** The key a work order's origin carries, so Help Desk finds an issue's work order again after a restart. */
export function issueKey(runId: string, area: BugArea): string {
  return `${runId}:${area}`;
}

const oldestFirst = <T extends Reported>(reports: readonly T[]): T[] => [...reports].sort((a, b) => a.bug.at.localeCompare(b.bug.at));
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const unique = (texts: readonly string[]) => [...new Set(texts.map((text) => text.trim()))];

/** One issue per area that has reports, in the order the areas were first reported. An area sent already stays listed. */
export function groupIssues(reports: readonly Reported[], routed: ReadonlyMap<BugArea, RoutedWorkOrder>): SoftwareIssue[] {
  const byArea = new Map<BugArea, Reported[]>();
  for (const report of oldestFirst(reports)) byArea.set(report.bug.area, [...(byArea.get(report.bug.area) ?? []), report]);
  const areas = [...byArea.keys(), ...BUG_AREAS.filter((area) => routed.has(area) && !byArea.has(area))];
  return areas.map((area) => {
    const sent = routed.get(area);
    return {
      area,
      title: BUG_AREA_INFO[area].issue,
      reports: (byArea.get(area) ?? []).map(({ customerId, name, bug }) => ({ customerId, name, whatHappened: bug.whatHappened, ...(bug.orderId ? { orderId: bug.orderId } : {}), at: bug.at })),
      ...(sent ? { routed: sent } : {}),
    };
  });
}

export interface IssueWorkOrderInput {
  readonly area: BugArea;
  readonly runId: string;
  /** Help Desk's address as the operator uses it, for the link back from Software Factory. */
  readonly appUrl: string;
  readonly reports: readonly ReportedConversation[];
  /** The storefront codebase's files. */
  readonly project: readonly FactoryFile[];
}

/** The work order that asks Software Factory to fix a software issue in the storefront codebase. */
export function issueWorkOrder({ area, runId, appUrl, reports, project }: IssueWorkOrderInput): WorkOrderRequest {
  const sorted = oldestFirst(reports);
  const info = BUG_AREA_INFO[area];
  const first = sorted[0];
  return {
    title: `Fix: ${lowerFirst(info.issue)}`,
    brief: brief(area, sorted),
    maxReviewRounds: 2,
    origin: {
      app: "help-desk",
      name: "Help Desk",
      label: `${info.label} · ${plural(sorted.length, "ticket")}`,
      // The first reporting customer's conversation, with the issue's status next to it.
      ...(first ? { url: `${appUrl}/#/c/${encodeURIComponent(first.customerId)}` } : {}),
      key: issueKey(runId, area),
    },
    context: [
      { path: "BUG_REPORT.md", content: bugReport(area, sorted), description: "Contoso Outdoors support's reports of this issue: each customer's words, the order, and what should have happened" },
      { path: "transcripts.md", content: transcripts(sorted), description: "The reporting customers' support conversations, as plain text" },
    ],
    project: { name: STOREFRONT, files: project },
  };
}

/** What the customer wrote up to the report (their last three messages): the words to quote. */
function customerWords(report: ReportedConversation): string {
  const said = report.items
    .filter((item): item is MessageItem => item.kind === "message" && item.from === "customer" && item.at <= report.bug.at)
    .map((item) => item.text.trim())
    .filter(Boolean);
  return clip(said.slice(-3).join("\n\n") || report.bug.whatHappened, 600);
}

/** Markdown block quote lines, indented to sit inside a list item. */
const quote = (text: string, indent = ""): string[] => text.split("\n").map((line) => `${indent}>${line.trim() ? ` ${line.trim()}` : ""}`);
const sentence = (text: string) => text.trim().replace(/[.!?…]+$/, "");

function brief(area: BugArea, reports: readonly ReportedConversation[]): string {
  const head = [
    `Contoso Outdoors support received ${reports.length === 1 ? "a report" : `${reports.length} reports`} from customers who ran into the same problem on the store's website: ${lowerFirst(BUG_AREA_INFO[area].issue)}. Each customer's support agent checked their order and reported it to engineering.`,
    "",
    "## What customers reported",
    "",
  ];
  const tail = [
    "## Expected behavior",
    "",
    ...unique(reports.map((report) => report.bug.expected))
      .slice(0, BRIEF_REPORTS)
      .map((text) => `- ${clip(text, 300)}`),
    "",
    "## What to do",
    "",
    `The attached project, \`${STOREFRONT}\`, is the code behind the store's website (Node 22 or later, no dependencies; \`npm test\` runs its tests).`,
    "",
    "1. Find the cause of these reports in the code, and fix it.",
    "2. Add regression tests that reproduce what the customers reported: they fail without the fix and pass with it.",
    "3. Keep the existing tests passing.",
    "",
    "The structured reports are in `.factory/context/BUG_REPORT.md`, and the support conversations in `.factory/context/transcripts.md`.",
  ];
  // The reports fill what's left, so the ask always fits.
  let budget = MAX_BRIEF - [...head, ...tail].join("\n").length - 100;
  const quoted: string[] = [];
  for (const [index, report] of reports.slice(0, BRIEF_REPORTS).entries()) {
    const block = [
      `${index + 1}. **${report.name}**${report.bug.orderId ? `, order ${report.bug.orderId}` : ""}, wrote:`,
      "",
      ...quote(customerWords(report), "   "),
      "",
      `   Their support agent found: ${clip(sentence(report.bug.title), 120)}. ${clip(report.bug.whatHappened, 400)}`,
      "",
    ].join("\n");
    if (block.length + 1 > budget) break;
    quoted.push(block);
    budget -= block.length + 1;
  }
  const more = reports.length - quoted.length;
  return clip([...head, ...quoted, ...(more > 0 ? [`${plural(more, "more report")} in BUG_REPORT.md.`, ""] : []), ...tail].join("\n"), MAX_BRIEF);
}

/** BUG_REPORT.md: the issue's reports, structured. */
function bugReport(area: BugArea, reports: readonly ReportedConversation[]): string {
  const info = BUG_AREA_INFO[area];
  const lines = [
    `# ${info.issue}`,
    "",
    `Reported to Contoso Outdoors support by ${plural(reports.length, "customer")}, through Help Desk. Each customer's support agent wrote the report during the conversation, after checking the customer's order with the store's tools.`,
    "",
    `- Area: ${info.label} (\`${area}\`)`,
    `- Reports: ${reports.length}`,
    "",
    "## Expected behavior",
    "",
    ...unique(reports.map((report) => report.bug.expected)).map((text) => `- ${text}`),
    "",
    "## Reports",
    ...reports.flatMap((report, index) => [
      "",
      `### ${index + 1}. ${sentence(report.bug.title)}`,
      "",
      `- Customer: ${report.name}`,
      ...(report.bug.orderId ? [`- Order: ${report.bug.orderId}`] : []),
      `- Reported: ${report.bug.at}`,
      "",
      "What the customer wrote:",
      "",
      ...quote(customerWords(report)),
      "",
      `What happened: ${report.bug.whatHappened}`,
      "",
      `Expected: ${report.bug.expected}`,
    ]),
    "",
  ];
  return clip(lines.join("\n"), MAX_CONTEXT);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** transcripts.md: each reporting customer's conversation, as plain text. */
function transcripts(reports: readonly ReportedConversation[]): string {
  const lines = ["# Support conversations", "", "The conversations of the customers who reported this issue. `Tool` lines are the support agent's calls to the store's systems, and what they returned."];
  for (const report of reports) {
    lines.push("", `## ${report.name}`, "");
    for (const item of report.items) {
      if (item.kind === "message") lines.push(`${item.from === "customer" ? "Customer" : "Agent"}: ${clip(oneLine(item.text), 1_000)}`, "");
      else lines.push(`Tool: ${item.name} ${clip(JSON.stringify(item.args), 400)} → ${item.status}${item.result ? `: ${clip(JSON.stringify(item.result), 300)}` : ""}`, "");
    }
  }
  return clip(lines.join("\n"), MAX_CONTEXT);
}
