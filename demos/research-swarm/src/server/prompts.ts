// What the lead researcher is told. The platform's coordinator instructions already describe its worker tools and the
// researcher environment; this adds how Research Swarm wants the work done.
import type { Researcher, ReportSource } from "../shared/types.js";

export interface LeadSettings {
  readonly researcherEnvironment: string;
  readonly researcherModel: string;
  readonly maxResearchers: number;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];

/** "two", "two or three", "two to four": how many sub-questions a plan may have. */
export function planSize(max: number): string {
  const word = (n: number) => WORDS[n] ?? String(n);
  return max <= 2 ? word(2) : max === 3 ? "two or three" : `two to ${word(max)}`;
}

export function systemMessage(settings: LeadSettings): string {
  return [
    "You are the lead researcher of Research Swarm. The person asks one question; you answer it with a short report built only from what a team of web researchers read, every claim citing its source. The person watches each researcher live.",
    "",
    "Work in this order, in one turn:",
    `1. Call plan_research with ${planSize(settings.maxResearchers)} sub-questions that together answer the question. Make each one specific and independent, so one researcher can answer it alone.`,
    `2. Start one researcher per sub-question with start_worker, all of them before you wait: name = the name plan_research gave it (r1, r2, …), environment "${settings.researcherEnvironment}", model "${settings.researcherModel}", and a self-contained task with the original question, its sub-question, and "Report three to six findings, each ending with the URL of the page it came from." Researchers already know how to search and read; don't explain their tools.`,
    "3. Call wait_for_workers once for all of them. If a researcher fails, carry on with the others.",
    "4. Call list_sources. It numbers every page your researchers actually read.",
    "5. Call submit_report with a title (at most 10 words), a summary (the direct answer in at most two sentences), and a body: Markdown, 120 to 300 words, in two or three sections with `## ` headings. End every factual sentence with citations such as [2] or [1][4], using only numbers from list_sources. Add no links, footnotes, or source list: the app adds the sources. If submit_report reports a problem, fix it and call it again.",
    "",
    "Rules: never read the web yourself; only your researchers can. Don't stop researchers: the app cleans up after the report. Nobody answers questions while you work.",
  ].join("\n");
}

export function questionPrompt(question: string): string {
  return `Question: ${question}`;
}

export const NUDGE = "You ended your turn without a report. Call list_sources, then submit_report with the report.";

export function planText(researchers: readonly Researcher[], again: boolean): string {
  const lines = researchers.map((researcher) => `- ${researcher.id}: ${researcher.question}`);
  return again
    ? ["You already planned these researchers:", ...lines, "Start any that aren't started yet, then call wait_for_workers."].join("\n")
    : ["Planned. Start these researchers now with start_worker, all before waiting, each with exactly this name:", ...lines].join("\n");
}

export function sourcesText(sources: readonly ReportSource[]): string {
  if (sources.length === 0) {
    return "Your researchers read no pages, so there's nothing to cite. Call submit_report with a short report that says what couldn't be found, without citations.";
  }
  return [
    "Pages your researchers read, numbered for citation:",
    ...sources.map((source) => `[${source.n}] ${source.title} (${source.host}, read by ${source.readBy.join(", ")})\n    ${source.url}`),
    "",
    "Cite these numbers in submit_report.",
  ].join("\n");
}
