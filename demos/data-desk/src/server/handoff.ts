// What an analysis sends to Software Factory: the person's request, checked, and the context files and brief Data Desk
// composes from it. INSIGHT.md says what to build, the insight, the dataset, and how each attached file was made; tables
// go as CSV files under data/, published charts and text files under artifacts/. The factory's limits are checked here,
// before anything is sent, in words that say what to send less of.
import { FACTORY_LIMITS, HANDOFF_LIMITS, isTextOutput, kilobytes, toCsv, utf8Bytes } from "../shared/factory.js";
import type { ColumnInfo, OutputFile, ResultView, SendToFactoryRequest, TableRef } from "../shared/types.js";
import type { Dataset } from "./datasets.js";
import { DeskError } from "./errors.js";
import type { ContextFile } from "./factory.js";

/** How a table Copilot made came about: the Data Desk tool call that made it. */
export interface TableOrigin {
  readonly tool: string;
  /** The call's arguments in one line: "sum(revenue) by store · where month ≥ 2025-01". */
  readonly detail?: string;
}

/** Copilot's latest answer, and the question it answered. */
export interface Insight {
  readonly text: string;
  readonly question?: string;
}

/** What an analysis offers a hand-off. */
export interface HandoffSource {
  readonly dataset: Dataset;
  /** The tables Copilot made, oldest first. */
  readonly results: readonly ResultView[];
  /** How each table was made, by result ID. */
  readonly origins: ReadonlyMap<string, TableOrigin>;
  readonly answer?: Insight;
  /** A published output and its bytes. */
  readOutput(path: string): Promise<{ readonly file: OutputFile; readonly bytes: Uint8Array }>;
  /** The analysis in Data Desk, for people. */
  readonly link: string;
}

export interface Handoff {
  /** INSIGHT.md first, then the attached files. */
  readonly files: readonly ContextFile[];
  /** Markdown: what to build first, then the insight in short, and where to read more. */
  readonly brief: string;
  /** What was sent, in words, for the analysis's record. */
  readonly items: readonly string[];
}

/** The factory's limit on a brief. */
const BRIEF_MAX = 8_000;
/** The factory's limit on a context file's description. */
const DESCRIPTION_MAX = 200;
/** How much of the insight the brief quotes; INSIGHT.md has all of it. */
const BRIEF_INSIGHT = 1_500;
/** Data Desk's own limits on what a request may name. */
const MAX_SELECTIONS = 20;
const MAX_NAMED = 30;

const invalid = (message: string): DeskError => new DeskError("invalid_request", message);

type Include = { -readonly [K in keyof SendToFactoryRequest["include"]]: SendToFactoryRequest["include"][K] };

function tableRef(value: unknown): TableRef | undefined {
  const ref = value as { kind?: unknown; resultId?: unknown } | null | undefined;
  if (ref?.kind === "dataset") return { kind: "dataset" };
  if (ref?.kind === "result" && typeof ref.resultId === "string" && ref.resultId) return { kind: "result", resultId: ref.resultId };
  return undefined;
}

function names(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_NAMED || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 500)) {
    throw invalid(`The ${what} to send aren't valid. Close this and pick them again.`);
  }
  return [...new Set(value as string[])];
}

/** The request's shape, checked and tidied; throws `invalid_request` saying what to fix. */
export function parseHandoffRequest(body: unknown): SendToFactoryRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  // Control characters (other than line breaks and tabs) have no place in what people type; the factory takes text.
  const clean = (text: unknown): string => (typeof text === "string" ? text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : "");
  const title = clean(value["title"]).replace(/\s+/g, " ").trim();
  if (title.length < HANDOFF_LIMITS.titleMin || title.length > HANDOFF_LIMITS.titleMax) {
    throw invalid(`Give it a title of ${HANDOFF_LIMITS.titleMin} to ${HANDOFF_LIMITS.titleMax} characters.`);
  }
  const note = clean(value["note"]).trim();
  if (note.length < HANDOFF_LIMITS.noteMin) throw invalid("Say what the factory should build, in a sentence or two.");
  if (note.length > HANDOFF_LIMITS.noteMax) throw invalid(`Keep what to build under ${HANDOFF_LIMITS.noteMax.toLocaleString("en-US")} characters.`);
  const raw = value["include"] ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("Pick what to send.");
  const given = raw as Record<string, unknown>;
  const include: Include = {};
  if (given["view"] !== undefined) {
    const ref = tableRef(given["view"]);
    const rows = (given["view"] as { rows?: unknown } | null)?.rows;
    if (!ref || (rows !== undefined && !(typeof rows === "number" && Number.isInteger(rows) && rows >= 1))) throw invalid("The current view isn't valid. Close this and try again.");
    include.view = { ...ref, ...(typeof rows === "number" ? { rows } : {}) };
  }
  if (given["selections"] !== undefined) {
    const selections = given["selections"];
    if (!Array.isArray(selections) || selections.length > MAX_SELECTIONS) throw invalid("Those selected rows aren't valid. Select them again.");
    include.selections = selections.map((selection: unknown) => {
      const ref = tableRef((selection as { table?: unknown } | null)?.table);
      const rows = (selection as { rows?: unknown } | null)?.rows;
      if (!ref || !Array.isArray(rows) || rows.length === 0 || rows.length > HANDOFF_LIMITS.selectedRows || !rows.every((row) => Number.isInteger(row) && (row as number) >= 0)) {
        throw invalid("Those selected rows aren't valid. Select them again.");
      }
      return { table: ref, rows: [...new Set(rows as number[])].sort((a, b) => a - b) };
    });
  }
  if (given["results"] !== undefined) include.results = names(given["results"], "tables");
  if (given["outputs"] !== undefined) include.outputs = names(given["outputs"], "files");
  for (const key of ["dataset", "answer"] as const) {
    if (given[key] !== undefined && typeof given[key] !== "boolean") throw invalid("Pick what to send again.");
    if (given[key] === true) include[key] = true;
  }
  return { title, note, include };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A name for a file from a title: "Revenue by store" becomes "revenue-by-store"; long ones end at a whole word. */
export function slug(title: string, fallback = "table"): string {
  const value = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (value.length <= 60) return value || fallback;
  const head = value.slice(0, 61);
  const dash = head.lastIndexOf("-");
  return (dash >= 20 ? head.slice(0, dash) : value.slice(0, 60)).replace(/-+$/, "");
}

/** A published file's name, safe as a path in the factory's sandbox. */
function safeName(path: string): string {
  const name = (path.split("/").at(-1) ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-80);
  return name || "file";
}

/** Paths given out once: a second "data/revenue.csv" becomes "data/revenue-2.csv". */
class Paths {
  readonly #taken = new Set<string>(["insight.md"]);

  take(path: string): string {
    let candidate = path;
    for (let n = 2; this.#taken.has(candidate.toLowerCase()); n++) candidate = path.replace(/(\.[^./]+)?$/, (extension) => `-${n}${extension}`);
    this.#taken.add(candidate.toLowerCase());
    return candidate;
  }
}

/** An attached file, with how it was made (for INSIGHT.md) and what it is in words (for the analysis's record). */
interface Planned extends ContextFile {
  readonly how: string;
  readonly item: string;
}

const plain = (markdown: string): string => markdown.replace(/`/g, "");
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const oneLine = (text: string, max = 300): string => cut(text.replace(/\s+/g, " ").trim(), max);
/** Text for a Markdown table cell. */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
const quote = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

/** At most `max` characters of an answer, ending at a paragraph or sentence when one is near. */
export function shorten(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max - 1);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph > max / 2) return `${head.slice(0, paragraph).trimEnd()}\n\n…`;
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
  if (sentence > max / 2) return `${head.slice(0, sentence + 1)} …`;
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > max / 2 ? space : head.length).trimEnd()}…`;
}

/** A column's values in a few words: "52 to 693", "desktop, mobile, tablet". */
function values(column: ColumnInfo): string {
  const parts: string[] = [];
  if ((column.type === "number" || column.type === "date") && column.min !== undefined) parts.push(`${column.min} to ${column.max}`);
  if (column.type === "text" && column.top?.length) {
    const top = column.top.map((entry) => entry.value);
    parts.push((column.distinct ?? 0) <= top.length ? top.join(", ") : `${count(column.distinct ?? 0, "value")}, most often ${top.slice(0, 3).join(", ")}`);
  }
  if (column.missing > 0) parts.push(`${count(column.missing, "empty value")}`);
  return parts.join("; ");
}

/**
 * Composes what goes to the factory: INSIGHT.md, each table as CSV, the published files asked for, and the brief.
 * Throws when something asked for isn't in the analysis anymore, or when it's more than the factory takes.
 */
export async function composeHandoff(source: HandoffSource, request: SendToFactoryRequest, now = new Date()): Promise<Handoff> {
  const { include } = request;
  const { dataset } = source;
  const summary = dataset.summary;
  const table = dataset.table();
  const base = summary.fileName.replace(/\.csv$/i, "");
  const paths = new Paths();
  // The dataset keeps its own name: INSIGHT.md and the brief call it by it.
  const datasetPath = include.dataset ? paths.take(`data/${summary.fileName}`) : undefined;
  const planned: Planned[] = [];

  const result = (id: string): ResultView => {
    const found = source.results.find((candidate) => candidate.id === id);
    if (!found) throw invalid("One of those tables isn't in this analysis anymore. Close this and pick what to send again.");
    return found;
  };
  const shown = (view: ResultView): string =>
    view.rows.length < view.total ? `the first ${view.rows.length.toLocaleString("en-US")} of ${count(view.total, view.unit)}` : count(view.total, view.unit);
  const resultFile = (view: ResultView, onScreen: boolean): Planned => {
    const origin = source.origins.get(view.id);
    const made = origin?.tool === "aggregate" ? "Copilot's aggregate of the dataset" : "Rows Copilot picked from the dataset";
    const how = `"${view.title}": ${made}${origin ? ` with Data Desk's \`${origin.tool}\` tool` : ""}${origin?.detail ? ` (${origin.detail})` : ""}; ${shown(view)}.${onScreen ? " On screen in Data Desk when this was sent." : ""}`;
    const description = `${made}${origin?.detail ? `: ${origin.detail}` : ""}; ${shown(view)}${onScreen ? "; on screen when sent" : ""}`;
    return { path: paths.take(`data/${slug(view.title)}.csv`), content: toCsv(view.columns, view.rows), description, how, item: `${view.title} (${count(view.rows.length, view.unit)})` };
  };

  // What the grid shows.
  const viewRows = include.view?.kind === "dataset" ? Math.min(include.view.rows ?? HANDOFF_LIMITS.viewRows, HANDOFF_LIMITS.viewRows, table.rows.length) : 0;
  const viewResult = include.view?.kind === "result" ? result(include.view.resultId) : undefined;
  if (include.view?.kind === "dataset" && !datasetPath) {
    const all = viewRows === table.rows.length;
    const how = all
      ? `The whole dataset, ${count(viewRows, "row")}, as Data Desk's grid showed it.`
      : `The dataset's first ${viewRows.toLocaleString("en-US")} of ${count(table.rows.length, "row")}, as Data Desk's grid showed them.`;
    planned.push({
      path: paths.take(all ? `data/${summary.fileName}` : `data/${base}-first-${viewRows}-rows.csv`),
      content: toCsv(table.header, table.rows.slice(0, viewRows)),
      description: how,
      how,
      item: all ? `${summary.fileName} (${count(viewRows, "row")})` : `The first ${count(viewRows, "row")} of ${summary.fileName}`,
    });
  }
  if (viewResult) planned.push(resultFile(viewResult, true));

  // The rows the person selected.
  for (const selection of include.selections ?? []) {
    const picked = selection.table.kind === "result" ? result(selection.table.resultId) : undefined;
    const columns = picked ? picked.columns : table.header;
    const rows = picked ? picked.rows : table.rows;
    if (selection.rows.some((row) => row >= rows.length)) throw invalid("Some selected rows aren't in that table anymore. Select them again.");
    const from = picked ? `"${picked.title}"` : `the dataset (${summary.fileName})`;
    const how = `${count(selection.rows.length, "row")} the person selected in ${from}.`;
    planned.push({
      path: paths.take(`data/${picked ? slug(picked.title) : base}-selection.csv`),
      content: toCsv(columns, selection.rows.map((row) => rows[row]!)),
      description: how,
      how,
      item: `${count(selection.rows.length, "selected row")} of ${picked ? picked.title : summary.fileName}`,
    });
  }

  // Other tables Copilot made.
  for (const id of include.results ?? []) {
    if (id !== viewResult?.id) planned.push(resultFile(result(id), false));
  }

  const expected = 1 + planned.length + (include.outputs?.length ?? 0) + (datasetPath ? 1 : 0);
  if (expected > FACTORY_LIMITS.files) throw invalid(`That's ${expected} files; the factory takes up to ${FACTORY_LIMITS.files}. Send fewer tables or files.`);

  // Published charts and text files.
  for (const path of include.outputs ?? []) {
    if (!isTextOutput(path)) throw invalid(`${path} isn't a chart or text file Data Desk can send.`);
    const { file, bytes } = await source.readOutput(path);
    if (bytes.byteLength > FACTORY_LIMITS.fileBytes) {
      throw new DeskError("payload_too_large", `${path} is ${kilobytes(bytes.byteLength)}; the factory takes files up to ${kilobytes(FACTORY_LIMITS.fileBytes)}. Leave it out.`, 413);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalid(`${path} isn't a text file, so it can't be sent.`);
    }
    // The factory takes text only: a NUL character means binary.
    if (content.includes("\u0000")) throw invalid(`${path} isn't a text file, so it can't be sent.`);
    const how = `${file.kind === "chart" ? "A chart Copilot drew with Python in its sandbox" : "A file Copilot wrote in its sandbox"} (\`outputs/${file.path}\`, version ${file.version}).`;
    planned.push({ path: paths.take(`artifacts/${safeName(file.path)}`), content, description: plain(how), how, item: file.path.split("/").at(-1) ?? file.path });
  }

  // The whole dataset, as Data Desk has it.
  if (datasetPath) {
    const bytes = dataset.bytes();
    if (bytes.length > FACTORY_LIMITS.fileBytes) {
      throw new DeskError("payload_too_large", `The whole dataset is ${kilobytes(bytes.length)}; the factory takes files up to ${kilobytes(FACTORY_LIMITS.fileBytes)}. Send the rows you need instead.`, 413);
    }
    const how = `The whole dataset, ${count(table.rows.length, "row")}${viewRows ? ` (Data Desk's grid showed its first ${count(viewRows, "row")})` : ""}.`;
    planned.push({ path: datasetPath, content: bytes.toString("utf8").replace(/^\uFEFF/, ""), description: how, how, item: `${summary.fileName} (${count(table.rows.length, "row")})` });
  }

  const answer = include.answer ? source.answer : undefined;
  if (include.answer && !answer) throw invalid("Copilot hasn't answered yet, so there's no insight to send. Leave it out, or ask something first.");

  const files: ContextFile[] = [
    insightFile(source, request, planned, answer, table.columns, now),
    ...planned.map(({ path, content, description }) => ({ path, content, ...(description ? { description: cut(plain(description), DESCRIPTION_MAX) } : {}) })),
  ];
  checkLimits(files);
  return {
    files,
    brief: composeBrief(source, request, planned, answer),
    items: [...planned.map((file) => file.item), ...(answer ? ["Copilot's answer"] : [])],
  };
}

/** The factory's limits: how many files, how large each, and how large together. */
export function checkLimits(files: readonly ContextFile[]): void {
  if (files.length > FACTORY_LIMITS.files) throw invalid(`That's ${files.length} files; the factory takes up to ${FACTORY_LIMITS.files}. Send fewer tables or files.`);
  let total = 0;
  for (const file of files) {
    const bytes = utf8Bytes(file.content);
    if (bytes > FACTORY_LIMITS.fileBytes) {
      throw new DeskError("payload_too_large", `${file.path} is ${kilobytes(bytes)}; the factory takes files up to ${kilobytes(FACTORY_LIMITS.fileBytes)}. Send fewer rows.`, 413);
    }
    total += bytes;
  }
  if (total > FACTORY_LIMITS.totalBytes) {
    throw new DeskError("payload_too_large", `That's ${kilobytes(total)}; the factory takes up to ${kilobytes(FACTORY_LIMITS.totalBytes)} of context. Send fewer rows or files.`, 413);
  }
}

/** INSIGHT.md: what to build, the insight, the dataset, and how each attached file was made. */
function insightFile(source: HandoffSource, request: SendToFactoryRequest, planned: readonly Planned[], answer: Insight | undefined, columns: readonly ColumnInfo[], now: Date): ContextFile {
  const { summary } = source.dataset;
  const lines = [
    `# ${request.title}`,
    "",
    `Sent from Data Desk on ${now.toISOString().slice(0, 10)}, from an analysis of **${summary.name}**: ${source.link}`,
    "",
    "## What to build",
    "",
    request.note,
    "",
    "## The insight",
    "",
    ...(answer
      ? [answer.question ? `Copilot's latest answer in the analysis, to "${oneLine(answer.question)}":` : "Copilot's latest answer in the analysis:", "", quote(answer.text)]
      : ["Not included: what to build, above, says what matters."]),
    "",
    "## The dataset",
    "",
    `**${summary.name}**${summary.description ? `: ${summary.description}` : ""}. ${count(summary.rows, "row")} in \`${summary.fileName}\`.`,
    "",
    "| Column | Type | Values |",
    "| --- | --- | --- |",
    ...columns.map((column) => `| \`${cell(column.name)}\` | ${column.type} | ${cell(values(column))} |`),
    "",
    "## Attached files",
    "",
    ...(planned.length ? ["Paths are relative to this file.", "", ...planned.map((file) => `- \`${file.path}\`: ${file.how}`)] : ["Nothing else is attached."]),
  ];
  return { path: "INSIGHT.md", content: `${lines.join("\n")}\n`, description: "Start here: what to build, the insight, the dataset, and how each attached file was made" };
}

/** The work order's brief: what to build first, then the insight in short, and where the rest is. */
function composeBrief(source: HandoffSource, request: SendToFactoryRequest, planned: readonly Planned[], answer: Insight | undefined): string {
  const { summary } = source.dataset;
  const head = [request.note, "", "---", "", `**From Data Desk:** an analysis of ${summary.name}${summary.description ? ` (${summary.description})` : ""}, ${count(summary.rows, "row")}.`];
  const tail = [
    "",
    `Read \`.factory/context/INSIGHT.md\` first: what to build, ${answer ? "the whole insight, " : ""}the dataset's columns, and how each attached file was made.`,
    ...(planned.length ? [`Attached: ${planned.map((file) => `\`.factory/context/${file.path}\``).join(", ")}.`] : []),
  ];
  if (!answer) return [...head, ...tail].join("\n");
  const intro = answer.question ? `Copilot's insight, asked "${oneLine(answer.question, 200)}":` : "Copilot's insight:";
  const compose = (budget: number): string => [...head, "", intro, "", quote(shorten(answer.text, budget)), ...tail].join("\n");
  // Quoting adds a few characters per line: shorten the quote until the whole brief fits.
  let budget = BRIEF_INSIGHT;
  let brief = compose(budget);
  while (brief.length > BRIEF_MAX && budget > 100) {
    budget = Math.floor(budget * 0.7);
    brief = compose(budget);
  }
  return brief.length > BRIEF_MAX ? [...head, ...tail].join("\n") : brief;
}
