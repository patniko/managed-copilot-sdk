// Software issues: bug reports grouped by the part of the store's checkout code they're about, from the current
// simulation's customers and from live Downhill players (the Downhill Shop's checkout runs on the same code), and the
// work order Software Factory gets for one issue: a brief, the reports and conversations as context, and the storefront
// codebase to fix. Pure: the desk supplies the tickets and the codebase's files.
import {
  BUG_AREA_INFO,
  BUG_AREAS,
  PRODUCT_NAME,
  SHOP_NAME,
  type BugArea,
  type BugReport,
  type IssueReport,
  type MessageItem,
  type RoutedWorkOrder,
  type ShopCheckout,
  type SoftwareIssue,
  type TranscriptItem,
} from "../shared/types.js";
import type { FactoryFile, WorkOrderRequest } from "./factory.js";

/** The storefront codebase: the project Software Factory changes. */
export const STOREFRONT = "contoso-storefront";

const MAX_BRIEF = 8_000;
/** The most reports the brief quotes; BUG_REPORT.md has every one. */
const BRIEF_REPORTS = 8;
/** Each context file stays well under Software Factory's limits (256 KB a file, 512 KB together). */
const MAX_CONTEXT = 60_000;

/** A ticket's bug report: a store customer's of the simulation (`customerId`), or a Downhill player's (`ticketId`). */
export interface Reported {
  readonly customerId?: string;
  readonly ticketId?: string;
  readonly name: string;
  readonly bug: BugReport;
}

/** A ticket's bug report and its conversation, for a work order. */
export interface ReportedConversation extends Reported {
  readonly items: readonly TranscriptItem[];
  /** A player's: what they tried at the Downhill Shop's checkout, and the game's version. */
  readonly shop?: { readonly checkout: ShopCheckout; readonly gameVersion?: string };
}

export function isBugArea(value: string): value is BugArea {
  return (BUG_AREAS as readonly string[]).includes(value);
}

/**
 * The scope of an issue's work order without a simulation: the open player ticket that reported the problem first. With
 * a simulation running, the scope is the simulation's ID (players' reports join its issues).
 */
export function playerScope(ticketId: string): string {
  return `player-${ticketId}`;
}

/**
 * The key a work order's origin carries: `<scope>:<area>`, where the scope is a simulation's ID or `player-<ticket>`.
 * Help Desk sends an issue once per key, and finds its work order again by the key after a restart.
 */
export function issueKey(scope: string, area: BugArea): string {
  return `${scope}:${area}`;
}

/** The scope and area of a key `issueKey` made. Simulation IDs have no hyphen, so the two kinds of scope never collide. */
export function parseIssueKey(key: string): { readonly scope: string; readonly area: BugArea } | undefined {
  const match = /^([a-z0-9]+|player-[a-z0-9]+):([a-z-]+)$/.exec(key);
  const area = match?.[2];
  return match && area && isBugArea(area) ? { scope: match[1]!, area } : undefined;
}

const isPlayer = (report: Reported): boolean => report.ticketId !== undefined;
const oldestFirst = <T extends Reported>(reports: readonly T[]): T[] => [...reports].sort((a, b) => a.bug.at.localeCompare(b.bug.at));
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const unique = (texts: readonly string[]) => [...new Set(texts.map((text) => text.trim()))];
const usd = (amountCents: number) => (amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const and = (parts: readonly string[]) => (parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`);

function issueReport(report: Reported): IssueReport {
  const { bug } = report;
  const who = report.ticketId !== undefined ? { ticketId: report.ticketId, product: "downhill" as const } : { customerId: report.customerId ?? "" };
  return { ...who, name: report.name, whatHappened: bug.whatHappened, ...(bug.orderId ? { orderId: bug.orderId } : {}), at: bug.at };
}

/** One issue per area that has reports, in the order the areas were first reported. An area sent already stays listed. */
export function groupIssues(reports: readonly Reported[], routed: ReadonlyMap<BugArea, RoutedWorkOrder>): SoftwareIssue[] {
  const byArea = new Map<BugArea, Reported[]>();
  for (const report of oldestFirst(reports)) byArea.set(report.bug.area, [...(byArea.get(report.bug.area) ?? []), report]);
  const areas = [...byArea.keys(), ...BUG_AREAS.filter((area) => routed.has(area) && !byArea.has(area))];
  return areas.map((area) => {
    const sent = routed.get(area);
    return { area, title: BUG_AREA_INFO[area].issue, reports: (byArea.get(area) ?? []).map(issueReport), ...(sent ? { routed: sent } : {}) };
  });
}

export interface IssueWorkOrderInput {
  readonly area: BugArea;
  /** The simulation's ID, or `playerScope(…)` with none running: the key's scope. */
  readonly scope: string;
  /** Help Desk's address as the operator uses it, for the link back from Software Factory. */
  readonly appUrl: string;
  readonly reports: readonly ReportedConversation[];
  /** The storefront codebase's files. */
  readonly project: readonly FactoryFile[];
}

/** The work order that asks Software Factory to fix a software issue in the storefront codebase. */
export function issueWorkOrder({ area, scope, appUrl, reports, project }: IssueWorkOrderInput): WorkOrderRequest {
  const sorted = oldestFirst(reports);
  const info = BUG_AREA_INFO[area];
  const first = sorted[0];
  const players = sorted.some(isPlayer);
  return {
    title: `Fix: ${lowerFirst(info.issue)}`,
    brief: brief(area, sorted),
    maxReviewRounds: 2,
    origin: {
      app: "help-desk",
      name: "Help Desk",
      label: `${info.label} · ${plural(sorted.length, "ticket")}`,
      // The first reporting conversation, with the issue's status next to it.
      ...(first ? { url: first.ticketId !== undefined ? `${appUrl}/#/p/${encodeURIComponent(first.ticketId)}` : `${appUrl}/#/c/${encodeURIComponent(first.customerId ?? "")}` } : {}),
      key: issueKey(scope, area),
    },
    context: [
      {
        path: "BUG_REPORT.md",
        content: bugReport(area, sorted),
        description: `Contoso Outdoors support's reports of this issue: each ${players ? "customer's or player's" : "customer's"} words, the order, and what should have happened`,
      },
      { path: "transcripts.md", content: transcripts(sorted), description: `The reporting ${players ? "customers' and players'" : "customers'"} support conversations, as plain text` },
    ],
    project: { name: STOREFRONT, files: project },
  };
}

/** What the customer or player wrote up to the report (their last three messages): the words to quote. */
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

/** Who reported it, counted: "2 customers of the store's website and 1 player in the Downhill Shop". */
function sources(reports: readonly ReportedConversation[]): string {
  const players = reports.filter(isPlayer).length;
  const customers = reports.length - players;
  return and([...(customers > 0 ? [`${plural(customers, "customer")} of the store's website`] : []), ...(players > 0 ? [`${plural(players, "player")} in the ${SHOP_NAME}`] : [])]);
}

/** What the reports from the Downhill Shop have in common with the website's: the same checkout code. */
function shopSection(area: BugArea, reports: readonly ReportedConversation[]): string[] {
  const tried = reports.flatMap((report) => (report.shop ? [report.shop.checkout] : []));
  if (!reports.some(isPlayer)) return [];
  const shared = area === "promo-codes" ? `: it applies promotion codes with the same \`applyPromoCode\` (\`src/promotions.js\`) as the store's website` : "";
  const seen = new Set<string>();
  const attempts = tried.flatMap((checkout) => {
    const offer = checkout.offer ? `The shop's offer banner (“${checkout.offer}”)` : "";
    const line = !checkout.code
      ? `- A player bought at full price with no code applied${checkout.offer ? ` (the shop's offer: “${checkout.offer}”)` : ""}.`
      : `- ${offer ? `${offer} applies the code` : "A player entered the code"} ${JSON.stringify(checkout.code)}${checkout.error ? `, and checkout said “${checkout.error}”` : "."}`;
    if (seen.has(line)) return [];
    seen.add(line);
    return [line];
  });
  return [
    `## The ${SHOP_NAME}`,
    "",
    `${PRODUCT_NAME} is Contoso Outdoors' free mountain-biking browser game, and the ${SHOP_NAME} is its in-game shop, which sells rider outfits and bike paint. Its checkout runs on this same storefront code${shared}.`,
    ...(attempts.length > 0 ? ["", ...attempts] : []),
    "",
  ];
}

function brief(area: BugArea, reports: readonly ReportedConversation[]): string {
  const issue = lowerFirst(BUG_AREA_INFO[area].issue);
  const count = reports.length === 1 ? "a report" : `${reports.length} reports`;
  const players = reports.filter(isPlayer).length;
  const customers = reports.length - players;
  const head = [
    players === 0
      ? `Contoso Outdoors support received ${count} from customers who ran into the same problem on the store's website: ${issue}. Each customer's support agent checked their order and reported it to engineering.`
      : `Contoso Outdoors support received ${count} of the same problem, ${issue}, from ${sources(reports)}. Each support agent checked what happened and reported it to engineering.`,
    "",
    ...shopSection(area, reports),
    players === 0 ? "## What customers reported" : "## What they reported",
    "",
  ];
  const reporters = customers === 0 ? "players" : players === 0 ? "customers" : "customers and players";
  const tail = [
    "## Expected behavior",
    "",
    ...unique(reports.map((report) => report.bug.expected))
      .slice(0, BRIEF_REPORTS)
      .map((text) => `- ${clip(text, 300)}`),
    "",
    "## What to do",
    "",
    `The attached project, \`${STOREFRONT}\`, is the code behind the store's website${players > 0 ? ` and the ${SHOP_NAME}'s checkout` : ""} (Node 22 or later, no dependencies; \`npm test\` runs its tests).`,
    "",
    "1. Find the cause of these reports in the code, and fix it.",
    `2. Add regression tests that reproduce what the ${reporters} reported${players > 0 ? `, with each code exactly as the ${SHOP_NAME} sent it` : ""}: they fail without the fix and pass with it.`,
    "3. Keep the existing tests passing.",
    "",
    "The structured reports are in `.factory/context/BUG_REPORT.md`, and the support conversations in `.factory/context/transcripts.md`.",
  ];
  // The reports fill what's left, so the ask always fits.
  let budget = MAX_BRIEF - [...head, ...tail].join("\n").length - 100;
  const quoted: string[] = [];
  for (const [index, report] of reports.slice(0, BRIEF_REPORTS).entries()) {
    const where = isPlayer(report) ? ` (${SHOP_NAME})` : "";
    const block = [
      `${index + 1}. **${report.name}**${where}${report.bug.orderId ? `, order ${report.bug.orderId}` : ""}, wrote:`,
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

/** A customer's report in BUG_REPORT.md. */
function customerEntry(report: ReportedConversation): string[] {
  return [
    `- Customer: ${report.name}`,
    ...(report.bug.orderId ? [`- Order: ${report.bug.orderId}`] : []),
    `- Reported: ${report.bug.at}`,
    "",
    "What the customer wrote:",
  ];
}

/** A player's report in BUG_REPORT.md: what they tried at the Downhill Shop's checkout. */
function playerEntry(report: ReportedConversation): string[] {
  const shop = report.shop;
  const checkout = shop?.checkout;
  return [
    `- Player: ${report.name}, in the ${SHOP_NAME}${shop?.gameVersion ? ` (${PRODUCT_NAME} ${shop.gameVersion})` : ""}`,
    ...(checkout
      ? [
          checkout.code ? `- Code: ${JSON.stringify(checkout.code)}${checkout.offer ? `, from the shop's offer banner (“${checkout.offer}”)` : ""}` : `- Code: none reached checkout${checkout.offer ? ` (the shop's offer: “${checkout.offer}”)` : ""}`,
          ...(checkout.error ? [`- Checkout said: ${checkout.error}`] : []),
          `- Cart: ${checkout.items.length ? checkout.items.map((item) => `${item.name} (\`${item.sku}\`, ${usd(item.priceCents)})`).join(", ") : "empty"}; subtotal ${usd(checkout.subtotalCents)}`,
          checkout.order ? `- Order: ${checkout.order.id}, ${usd(checkout.order.totalCents)} paid at full price` : "- Order: none (the player didn't buy)",
        ]
      : []),
    `- Reported: ${report.bug.at}`,
    "",
    "What the player wrote:",
  ];
}

/** BUG_REPORT.md: the issue's reports, structured. */
function bugReport(area: BugArea, reports: readonly ReportedConversation[]): string {
  const info = BUG_AREA_INFO[area];
  const players = reports.filter(isPlayer).length;
  const lines = [
    `# ${info.issue}`,
    "",
    players === 0
      ? `Reported to Contoso Outdoors support by ${plural(reports.length, "customer")}, through Help Desk. Each customer's support agent wrote the report during the conversation, after checking the customer's order with the store's tools.`
      : `Reported to Contoso Outdoors support through Help Desk by ${sources(reports)}. Each support agent wrote the report during the conversation, after checking what happened with their tools.`,
    "",
    `- Area: ${info.label} (\`${area}\`)`,
    `- Reports: ${reports.length}`,
    "",
    ...shopSection(area, reports),
    "## Expected behavior",
    "",
    ...unique(reports.map((report) => report.bug.expected)).map((text) => `- ${text}`),
    "",
    "## Reports",
    ...reports.flatMap((report, index) => [
      "",
      `### ${index + 1}. ${sentence(report.bug.title)}`,
      "",
      ...(isPlayer(report) ? playerEntry(report) : customerEntry(report)),
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

/** transcripts.md: each reporting customer's or player's conversation, as plain text. */
function transcripts(reports: readonly ReportedConversation[]): string {
  const players = reports.some(isPlayer);
  const lines = [
    "# Support conversations",
    "",
    `The conversations of the ${players ? "customers and players" : "customers"} who reported this issue. \`Tool\` lines are the support agent's calls to the store's systems, and what they returned.`,
  ];
  for (const report of reports) {
    const player = isPlayer(report);
    lines.push("", `## ${report.name}${player ? ` (${SHOP_NAME})` : ""}`, "");
    for (const item of report.items) {
      if (item.kind === "message") lines.push(`${item.from === "customer" ? (player ? "Player" : "Customer") : "Agent"}: ${clip(oneLine(item.text), 1_000)}`, "");
      else lines.push(`Tool: ${item.name} ${clip(JSON.stringify(item.args), 400)} → ${item.status}${item.result ? `: ${clip(JSON.stringify(item.result), 300)}` : ""}`, "");
    }
  }
  return clip(lines.join("\n"), MAX_CONTEXT);
}
