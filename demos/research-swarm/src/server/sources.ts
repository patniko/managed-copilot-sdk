// Sources: the pages researchers recorded with `research read`, numbered for citation, and the report built on them.
// A report may cite only those pages, so its claims trace back to what a researcher actually read.
import type { PageRead, Report, ReportSource, Run } from "../shared/types.js";

/** Where a researcher's `research` command records the pages it read, relative to its `/workspace`. */
export const SOURCE_LOG = "research/sources.jsonl";

/** Pages taken from one researcher's log. */
const PAGES_PER_RESEARCHER = 40;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** An http(s) URL without its fragment, or undefined. */
export function canonicalUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const SEPARATOR = /(\s+(?:-|\||·|—|–)\s+)/;
const SITE_NAME = /wikipedia|mdn|microsoft learn|github|node\.js|python|arxiv|documentation/i;

/** A page title without the site's name ("WebAssembly - Wikipedia" → "WebAssembly"). */
export function cleanTitle(title: string, url: string): string {
  const parts = title.replace(/\s+/g, " ").trim().split(SEPARATOR);
  while (parts.length >= 3 && SITE_NAME.test(parts.at(-1)!) && parts.at(-1)!.length <= 40) parts.splice(-2);
  let text = parts
    .join("")
    .replace(/^GitHub - /, "")
    .replace(/^\[\d{4}\.\d{4,5}(?:v\d+)?\]\s*/, "")
    .trim();
  if (!text) {
    try {
      const { hostname, pathname } = new URL(url);
      text = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "") || hostname;
    } catch {
      text = url;
    }
  }
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** The pages in a researcher's source log (JSON lines its sandbox wrote; untrusted, so checked and bounded). */
export function parsePages(log: string): PageRead[] {
  const pages: PageRead[] = [];
  const seen = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === "string" ? canonicalUrl(record.url) : undefined;
    if (!url || url.length > 2_000 || seen.has(url)) continue;
    seen.add(url);
    const at = typeof record.at === "string" && !Number.isNaN(Date.parse(record.at)) ? record.at : undefined;
    pages.push({ url, title: cleanTitle(typeof record.title === "string" ? record.title : "", url), host: hostOf(url), ...(at ? { at } : {}) });
    if (pages.length >= PAGES_PER_RESEARCHER) break;
  }
  return pages;
}

/** Numbers every page any researcher read, once, in the order first seen. Numbers never change within a run. */
export class SourceRegistry {
  readonly #sources: ReportSource[] = [];
  readonly #byUrl = new Map<string, number>();

  add(researcher: string, pages: readonly PageRead[]): void {
    for (const page of pages) {
      const index = this.#byUrl.get(page.url);
      if (index === undefined) {
        this.#byUrl.set(page.url, this.#sources.length);
        this.#sources.push({ n: this.#sources.length + 1, url: page.url, title: page.title, host: page.host, readBy: [researcher] });
        continue;
      }
      const source = this.#sources[index]!;
      if (!source.readBy.includes(researcher)) this.#sources[index] = { ...source, readBy: [...source.readBy, researcher].sort(byPlanOrder) };
    }
  }

  get sources(): readonly ReportSource[] {
    return this.#sources;
  }
}

/** r1, r2, … r10 in plan order; other names after them. */
function byPlanOrder(a: string, b: string): number {
  const rank = (id: string) => (/^r\d+$/.test(id) ? Number(id.slice(1)) : Number.MAX_SAFE_INTEGER);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** `[3]`, `[2, 5]`, or `[4](https://…)`: a citation group and the numbers in it. */
const CITATION = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?:\([^)\s]*\))?/g;

/** The numbers cited in a text, in order of appearance (repeats included). */
export function citedNumbers(text: string): number[] {
  return [...text.matchAll(CITATION)].flatMap((match) => match[1]!.split(",").map((part) => Number(part.trim())));
}

export interface DraftReport {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

/** What's wrong with a draft, in words the lead can act on; empty when it can be saved. */
export function checkDraft(draft: DraftReport, sources: readonly ReportSource[]): string[] {
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push("Give the report a title.");
  else if (draft.title.length > 200) problems.push("Shorten the title to at most 10 words.");
  if (!draft.summary.trim()) problems.push("Write a summary: the direct answer in a sentence or two.");
  else if (draft.summary.length > 1_500) problems.push("Shorten the summary to two sentences.");
  if (!draft.body.trim()) problems.push("Write the report's body.");
  else if (draft.body.length > 40_000) problems.push("Shorten the body to at most 400 words.");
  const known = new Set(sources.map((source) => source.n));
  const cited = citedNumbers(`${draft.summary}\n${draft.body}`);
  const unknown = [...new Set(cited.filter((n) => !known.has(n)))];
  if (unknown.length > 0) {
    problems.push(
      `${unknown.map((n) => `[${n}]`).join(", ")} ${unknown.length === 1 ? "isn't a source" : "aren't sources"} from list_sources. Cite only the numbers list_sources returned, or remove the claim.`,
    );
  }
  if (sources.length > 0 && draft.body.trim() && cited.length === 0) problems.push("Cite your sources: end every factual sentence with numbers from list_sources, like [2].");
  return problems;
}

/** The report as people read it: cited sources only, renumbered 1, 2, 3… by first appearance. */
export function buildReport(draft: DraftReport, sources: readonly ReportSource[]): Report {
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  const order: number[] = [];
  for (const n of citedNumbers(`${draft.summary}\n${draft.body}`)) if (byNumber.has(n) && !order.includes(n)) order.push(n);
  const renumber = new Map(order.map((n, index) => [n, index + 1]));
  const rewrite = (text: string) =>
    text
      .replace(CITATION, (_match, group: string) =>
        group
          .split(",")
          .map((part) => renumber.get(Number(part.trim())))
          .filter((n): n is number => n !== undefined)
          .map((n) => `[${n}]`)
          .join(""),
      )
      .trim();
  return {
    title: draft.title.replace(/\s+/g, " ").trim(),
    summary: rewrite(draft.summary),
    body: rewrite(draft.body),
    sources: order.map((n) => ({ ...byNumber.get(n)!, n: renumber.get(n)! })),
  };
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

/** A finished run's report as a Markdown document, with its question and numbered sources. */
export function reportMarkdown(run: Run): string {
  const report = run.report;
  if (!report) return "";
  const researchers = run.researchers.filter((researcher) => researcher.workerId).length;
  const date = (run.finishedAt ?? run.updatedAt).slice(0, 10);
  return [
    `# ${report.title}`,
    "",
    `> ${run.question.replace(/\s+/g, " ").trim()}`,
    "",
    report.summary,
    "",
    report.body,
    "",
    "## Sources",
    "",
    ...report.sources.map((source) => `${source.n}. [${escapeLinkText(source.title)}](${source.url}) (${source.host})`),
    "",
    "---",
    "",
    `Researched with Research Swarm on Managed Copilot on ${date}: a lead on the shared runtime and ${researchers} ${researchers === 1 ? "researcher" : "researchers"}, each in a sandbox of its own.`,
    "",
  ].join("\n");
}
