// Data Desk's own tools: they run in this server, so they answer the same way on the shared runtime and after the
// session moves into its sandbox. Each analysis gets its own set, bound to its dataset, whose table they read per call.
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import type { Dataset } from "./datasets.js";
import { DeskError } from "./errors.js";
import { TableError, type AggregateSpec, type QuerySpec, type Table, type TableResult } from "./table.js";

/** Where a sandbox finds the dataset once the session moved. */
export const sandboxPath = (dataset: Dataset): string => `/workspace/data/${dataset.summary.fileName}`;

const filter = z.object({
  column: z.string().describe("A column name"),
  op: z.enum(["=", "!=", ">", ">=", "<", "<=", "contains"]),
  value: z.union([z.string(), z.number()]).describe('The value to compare with. Dates as YYYY-MM-DD or YYYY-MM. "" matches empty cells.'),
});

const title = z.string().describe('A short title for the result, shown above Data Desk\'s grid, for example "Revenue by store"');

const queryParameters = z.object({
  title,
  columns: z.array(z.string()).optional().describe("Columns to return. Default: all of them."),
  filters: z.array(filter).optional().describe("Rows must match every filter."),
  sortBy: z.string().optional().describe("A column to sort by."),
  descending: z.boolean().optional(),
  limit: z.number().int().optional().describe("How many rows to return, 1 to 200. Default 20."),
});

const aggregateParameters = z.object({
  title,
  groupBy: z.array(z.string()).optional().describe("Up to three columns to group by. Omit for one total over all matching rows."),
  metrics: z
    .array(z.object({ fn: z.enum(["count", "sum", "avg", "min", "max"]), column: z.string().optional().describe("A number column; not needed for count.") }))
    .min(1),
  filters: z.array(filter).optional().describe("Only rows that match every filter are counted."),
  sortBy: z.string().optional().describe("A group-by column, or a metric's label such as sum(revenue) or count."),
  descending: z.boolean().optional(),
  limit: z.number().int().optional().describe("How many groups to return, 1 to 500. Default 50."),
});

export interface ToolHost {
  readonly dataset: Dataset;
}

/**
 * A tool's table as the model reads it: the rows it asked for, and how many matched. The same object, persisted as
 * the call's result in the session's history, is what Data Desk's grid shows (see `projection.ts`).
 */
function answer(result: TableResult, heading: string): Record<string, unknown> {
  return {
    title: heading.trim().slice(0, 120) || "Result",
    matched: result.total,
    shown: result.rows.length,
    columns: result.columns,
    rows: result.rows,
    note: "Data Desk shows this table in its grid. Summarize it; don't repeat it in full.",
  };
}

/**
 * Runs a tool on the dataset's table. A mistake the agent can fix, or a dataset that's no longer available, comes back
 * as `error` for the agent to act on.
 */
function withTable(dataset: Dataset, run: (table: Table) => Record<string, unknown>): Record<string, unknown> {
  try {
    return run(dataset.table());
  } catch (error) {
    if (error instanceof TableError || error instanceof DeskError) return { error: error.message };
    throw error;
  }
}

export function dataTools(host: ToolHost): Tool<any>[] {
  const { dataset } = host;

  return [
    defineTool("describe_dataset", {
      description: "Describes the dataset open in Data Desk: its row count, each column's type and summary (range, mean, most common values), and the first rows.",
      parameters: z.object({}),
      skipPermission: true,
      handler: () =>
        withTable(dataset, (table) => ({
          name: dataset.summary.name,
          rows: table.rows.length,
          columns: table.columns,
          firstRows: table.rows.slice(0, 5),
          inSandbox: `Once you move into a sandbox, the file is at ${sandboxPath(dataset)}.`,
        })),
    }),
    defineTool("query_rows", {
      description: "Finds rows in the dataset: filter by column values, pick columns, sort, and limit. Data Desk shows the rows in its grid.",
      parameters: queryParameters,
      skipPermission: true,
      handler: (args) => withTable(dataset, (table) => answer(table.query(args as QuerySpec), args.title)),
    }),
    defineTool("aggregate", {
      description: "Groups the dataset's rows and computes count, sum, avg, min, or max per group, optionally on filtered rows. Data Desk shows the table in its grid.",
      parameters: aggregateParameters,
      skipPermission: true,
      handler: (args) => withTable(dataset, (table) => answer(table.aggregate(args as AggregateSpec), args.title)),
    }),
  ];
}

const CHART_COLORS = ["#0969da", "#1a7f37", "#bf3989", "#9a6700", "#8250df", "#cf222e"];

/** Data Desk's instructions, added to the platform's: the same before and after the move. */
export function systemMessage(dataset: Dataset): string {
  const { summary } = dataset;
  const columns = summary.columns.map((column) => `${column.name} (${column.type})`).join(", ");
  return [
    `You are Data Desk, an analyst working on one dataset: "${summary.name}", ${summary.rows} rows with columns ${columns}.`,
    ...(dataset.notes ? [`- About the data: ${dataset.notes}`] : []),
    "- Answer with Data Desk's tools when they can: describe_dataset, query_rows (filter and sort rows), and aggregate (group and total). They run in the app, wherever you are, and Data Desk shows their tables in its grid.",
    `- Charts, statistics the tools don't offer (correlation, regression, forecasts, percentiles), and anything else that needs code need Python: call request_sandbox first. In the sandbox the dataset is at ${sandboxPath(dataset)}.`,
    "- In the sandbox, use Python 3's standard library only: there's no network and no pip.",
    `- Draw charts as SVG written with plain Python: 800 by 480, a white background, a title, labeled axes with readable ticks, a legend when there's more than one series, font-family system-ui, sans-serif, and these colors in order: ${CHART_COLORS.join(", ")}. Save each chart as /workspace/outputs/<short-kebab-name>.svg. Data Desk shows it when your turn ends.`,
    "- Reply briefly: the answer first in a sentence or two, then a few bullets at most. Don't describe your process, repeat tables, or mention file paths.",
  ].join("\n");
}
