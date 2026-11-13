import { CalendarIcon, DownloadIcon, FileIcon, GraphIcon, NumberIcon, PlugIcon, TableIcon, TypographyIcon, XIcon, type Icon } from "@primer/octicons-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AnalysisView, ColumnType, DatasetSummary, OutputFile, ResultView } from "../../shared/types.js";
import { api, errorMessage, outputUrl } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { fileName, formatCell, formatCount, isNumeric } from "../lib/format.js";
import { addRow, clearRows, selectResult, setLoadedRows, tableKey, toggleAllRows, toggleRow, useSelectedResult, useSelectedRows } from "../lib/selection.js";
import { FactoryButton } from "./Factory.js";
import { Spinner } from "./ui/Spinner.js";

const TYPE_ICON: Readonly<Record<ColumnType, Icon>> = { number: NumberIcon, date: CalendarIcon, text: TypographyIcon };
const PAGE = 200;

/** The data side of the workspace: published charts on top, then the grid. `onSend` opens Send to Software Factory. */
export function DataPanel({ view, className, onSend }: { readonly view: AnalysisView; readonly className?: string; readonly onSend: () => void }) {
  const selected = useSelectedResult(view.id);
  const latest = view.results.at(-1)?.id;
  // A result that arrives while the analysis is open takes over the grid; opening an analysis shows its dataset.
  const seen = useRef(latest);
  useEffect(() => {
    if (latest && latest !== seen.current) selectResult(view.id, latest);
    seen.current = latest;
  }, [latest, view.id]);
  const result = selected ? view.results.find((candidate) => candidate.id === selected) : undefined;
  const table = tableKey(result ? { kind: "result", resultId: result.id } : { kind: "dataset" });
  return (
    <section aria-label="Data" className={cx("flex min-h-0 min-w-0 flex-col", className)}>
      {view.outputs.length ? <Outputs view={view} /> : null}
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        {result ? (
          <>
            <PlugIcon size={16} className="shrink-0 text-fg-accent" />
            <span className="min-w-0 truncate font-semibold" title={result.title}>
              {result.title}
            </span>
            <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatCount(result.total, result.unit)}</span>
            <button type="button" className="btn btn-sm btn-invisible ml-auto shrink-0" onClick={() => selectResult(view.id, undefined)}>
              <XIcon size={16} />
              <span className="max-sm:hidden">All rows</span>
            </button>
          </>
        ) : (
          <>
            <TableIcon size={16} className="shrink-0 text-fg-muted" />
            <span className="min-w-0 truncate font-mono text-xs" title={view.dataset?.fileName}>
              {view.dataset?.fileName ?? "Dataset"}
            </span>
            {view.dataset ? <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatCount(view.dataset.rows, "row")}</span> : null}
            {latest ? (
              <button type="button" className="btn btn-sm btn-invisible ml-auto shrink-0" onClick={() => selectResult(view.id, latest)}>
                <PlugIcon size={16} />
                <span className="max-sm:hidden">Copilot's last table</span>
              </button>
            ) : null}
          </>
        )}
      </div>
      <SelectionBar analysisId={view.id} table={table} onSend={onSend} />
      {result ? (
        <ResultGrid key={result.id} analysisId={view.id} result={result} />
      ) : view.dataset ? (
        <DatasetGrid key={view.dataset.id} analysisId={view.id} dataset={view.dataset} />
      ) : (
        <p className="p-4 text-fg-muted">This analysis's dataset isn't available anymore.</p>
      )}
    </section>
  );
}

/** "3 rows selected · Clear", and a shortcut to send them. */
function SelectionBar({ analysisId, table, onSend }: { readonly analysisId: string; readonly table: string; readonly onSend: () => void }) {
  const rows = useSelectedRows(analysisId, table);
  if (rows.size === 0) return null;
  return (
    <div className="flex min-h-10 shrink-0 animate-fade-in items-center gap-2 border-b border-line bg-accent-muted px-4 py-1 text-sm">
      <span className="font-semibold tabular-nums" role="status">
        {formatCount(rows.size, "row")} selected
      </span>
      <span aria-hidden className="text-fg-muted">
        ·
      </span>
      <button type="button" className="Link" onClick={() => clearRows(analysisId, table)}>
        Clear
      </button>
      <FactoryButton onOpen={onSend} className="ml-auto" labelClassName="max-sm:sr-only" />
    </div>
  );
}

/** A grid's selected rows and what selecting does. */
interface GridSelection {
  readonly rows: ReadonlySet<number>;
  /** A row's checkbox was clicked; with Shift, every row from the last one clicked. */
  readonly toggle: (index: number, range: boolean) => void;
  /** Shift+Arrow reached a row. */
  readonly add: (index: number) => void;
  /** The header's checkbox: every row shown, or none. */
  readonly toggleAll: () => void;
}

function useGridSelection(analysisId: string, table: string, count: number): GridSelection {
  return {
    rows: useSelectedRows(analysisId, table),
    toggle: (index, range) => toggleRow(analysisId, table, index, range),
    add: (index) => addRow(analysisId, table, index),
    toggleAll: () => toggleAllRows(analysisId, table, count),
  };
}

interface GridColumn {
  readonly name: string;
  readonly type?: ColumnType;
  readonly numeric: boolean;
  /** The column's largest absolute value: its cells show bars against it. */
  readonly scale?: number;
}

function Grid({
  columns,
  rows,
  format,
  footer,
  label,
  selection,
}: {
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly format: boolean;
  readonly footer?: ReactNode;
  /** What the table is, for assistive technology. */
  readonly label: string;
  readonly selection: GridSelection;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const header = useRef<HTMLInputElement>(null);
  const picked = rows.reduce((total, _, index) => total + (selection.rows.has(index) ? 1 : 0), 0);
  const all = rows.length > 0 && picked === rows.length;
  useEffect(() => {
    if (header.current) header.current.indeterminate = picked > 0 && !all;
  }, [picked, all]);
  // Up and Down move between rows' checkboxes; with Shift they select along the way.
  const onKey = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    event.preventDefault();
    if (event.shiftKey) {
      selection.add(index);
      selection.add(next);
    }
    body.current?.querySelector<HTMLInputElement>(`input[data-row="${next}"]`)?.focus();
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="Table Table--sticky Table--condensed" aria-label={label}>
        <thead>
          <tr>
            <th className="w-px">
              <input
                ref={header}
                type="checkbox"
                className="align-middle"
                checked={all}
                disabled={rows.length === 0}
                onChange={selection.toggleAll}
                aria-label={all ? "Clear the selection" : "Select every row shown"}
              />
            </th>
            {columns.map((column) => {
              const Glyph = column.type ? TYPE_ICON[column.type] : undefined;
              return (
                <th key={column.name} title={column.type ? `${column.name} (${column.type})` : column.name} className={column.numeric ? "text-right" : undefined}>
                  <span className={cx("inline-flex items-center gap-1", column.numeric && "flex-row-reverse")}>
                    {Glyph ? <Glyph size={12} className="shrink-0 text-fg-muted" /> : null}
                    {column.name}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={body}>
          {rows.map((row, index) => {
            const checked = selection.rows.has(index);
            return (
              <tr key={index}>
                <td className={cx("w-px text-xs text-fg-muted tabular-nums", checked && "bg-accent-muted")}>
                  <label className="flex items-center gap-1.5 whitespace-nowrap select-none">
                    <input
                      type="checkbox"
                      data-row={index}
                      checked={checked}
                      onChange={() => undefined}
                      onClick={(event) => selection.toggle(index, event.shiftKey)}
                      onKeyDown={(event) => onKey(event, index)}
                      aria-label={`Select row ${index + 1}`}
                    />
                    {index + 1}
                  </label>
                </td>
                {columns.map((column, position) => {
                  const cell = row[position] ?? "";
                  const ratio = column.scale && isNumeric(cell) ? Math.min(1, Math.abs(Number(cell)) / column.scale) : 0;
                  return (
                    <td
                      key={column.name}
                      className={cx("max-w-[18rem] truncate whitespace-nowrap", column.numeric && "text-right tabular-nums", ratio > 0 && "relative", checked && "bg-accent-muted")}
                      title={cell.length > 30 ? cell : undefined}
                    >
                      {ratio > 0 ? (
                        <span
                          aria-hidden
                          className={cx("absolute inset-y-1.5 right-1 rounded-sm", checked ? "bg-accent-emphasis opacity-25" : "bg-accent-muted")}
                          style={{ width: `calc((100% - 0.5rem) * ${ratio})` }}
                        />
                      ) : null}
                      <span className={ratio > 0 ? "relative" : undefined}>{format ? formatCell(cell) : cell}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

function DatasetGrid({ analysisId, dataset }: { readonly analysisId: string; readonly dataset: DatasetSummary }) {
  const [rows, setRows] = useState<readonly (readonly string[])[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const selection = useGridSelection(analysisId, tableKey({ kind: "dataset" }), rows.length);
  const load = async (offset: number) => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.rows(dataset.id, offset, PAGE);
      setRows((current) => (offset === 0 ? page.rows : [...current, ...page.rows]));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  // Once per dataset: the component is keyed by it.
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on mount only; the parent remounts per dataset
  }, []);
  // "The current view" sends the rows the grid has loaded.
  useEffect(() => {
    setLoadedRows(analysisId, rows.length);
  }, [analysisId, rows.length]);
  const columns: GridColumn[] = dataset.columns.map((column) => ({ name: column.name, type: column.type, numeric: column.type === "number" }));
  if (error && rows.length === 0) {
    return (
      <p className="flex items-center gap-2 p-4 text-fg-muted">
        {error}
        <button type="button" className="btn btn-sm" onClick={() => void load(0)}>
          Try again
        </button>
      </p>
    );
  }
  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center gap-2 p-4 text-fg-muted">
        <Spinner size={16} /> Loading rows…
      </div>
    );
  }
  const more = rows.length < dataset.rows;
  return (
    <Grid
      columns={columns}
      rows={rows}
      format={false}
      label={`${dataset.name}: rows`}
      selection={selection}
      footer={
        more ? (
          <div className="flex justify-center p-3">
            <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void load(rows.length)}>
              {loading ? <Spinner size={16} /> : null}
              Show more ({formatCount(dataset.rows - rows.length, "row")} left)
            </button>
          </div>
        ) : null
      }
    />
  );
}

function ResultGrid({ analysisId, result }: { readonly analysisId: string; readonly result: ResultView }) {
  const selection = useGridSelection(analysisId, tableKey({ kind: "result", resultId: result.id }), result.rows.length);
  const columns: GridColumn[] = result.columns.map((name, position) => {
    const cells = result.rows.map((row) => row[position] ?? "").filter((cell) => cell.trim() !== "");
    const numeric = cells.length > 0 && cells.every(isNumeric);
    // Groups compare at a glance: their numbers get bars.
    const scale = numeric && result.unit === "group" && cells.length > 1 ? Math.max(...cells.map((cell) => Math.abs(Number(cell)))) : 0;
    return { name, numeric, ...(scale > 0 ? { scale } : {}) };
  });
  return (
    <Grid
      columns={columns}
      rows={result.rows}
      format
      label={result.title}
      selection={selection}
      footer={result.rows.length < result.total ? <p className="p-3 text-center text-xs text-fg-muted">The first {result.rows.length} of {formatCount(result.total, result.unit)}</p> : null}
    />
  );
}

function Outputs({ view }: { readonly view: AnalysisView }) {
  const [open, setOpen] = useState<OutputFile | undefined>();
  const charts = view.outputs.filter((output) => output.kind === "chart");
  const files = view.outputs.filter((output) => output.kind === "file");
  return (
    <div className="shrink-0 border-b border-line bg-canvas-muted px-4 py-3">
      <ul aria-label="Charts" className="flex items-stretch gap-3 overflow-x-auto pb-1">
        {charts.map((chart) => (
          <li key={chart.path} className="shrink-0">
            <button
              type="button"
              onClick={() => setOpen(chart)}
              className="group flex w-56 animate-scale-in flex-col overflow-hidden rounded-md border border-line bg-canvas text-left shadow-xs transition-colors hover:border-line-accent focus-visible:border-line-accent"
            >
              <span className="block h-32 bg-white p-1">
                <img src={outputUrl(view.id, chart.path, chart.version)} alt={`Chart: ${fileName(chart.path)}`} className="size-full object-contain" loading="lazy" />
              </span>
              <span className="flex min-w-0 items-center gap-1.5 border-t border-line px-2 py-1.5 text-xs">
                <GraphIcon size={12} className="shrink-0 text-fg-done" />
                <span className="truncate" title={chart.path}>
                  {fileName(chart.path)}
                </span>
              </span>
            </button>
          </li>
        ))}
        {files.length ? (
          <li className="flex shrink-0 flex-col justify-center gap-1">
            {files.map((file) => (
              <a key={file.path} href={outputUrl(view.id, file.path, file.version, true)} download className="btn btn-sm btn-invisible justify-start" title={`Download ${file.path}`}>
                <FileIcon size={16} />
                <span className="max-w-40 truncate">{fileName(file.path)}</span>
              </a>
            ))}
          </li>
        ) : null}
      </ul>
      {open ? <ChartDialog analysisId={view.id} chart={open} onClose={() => setOpen(undefined)} /> : null}
    </div>
  );
}

function ChartDialog({ analysisId, chart, onClose }: { readonly analysisId: string; readonly chart: OutputFile; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="Dialog Dialog--large backdrop:bg-backdrop"
      aria-label={fileName(chart.path)}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="Dialog-header">
        <div className="Dialog-headerContent">
          <h2 className="Dialog-title flex items-center gap-2">
            <GraphIcon size={16} className="text-fg-done" />
            {fileName(chart.path)}
          </h2>
        </div>
        <button type="button" className="btn-octicon" aria-label="Close" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="Dialog-body bg-white p-2">
        <img src={outputUrl(analysisId, chart.path, chart.version)} alt={`Chart: ${fileName(chart.path)}`} className="mx-auto max-h-[70vh] w-full object-contain" />
      </div>
      <div className="Dialog-footer">
        <a className="btn" href={outputUrl(analysisId, chart.path, chart.version, true)} download>
          <DownloadIcon size={16} />
          Download
        </a>
      </div>
    </dialog>
  );
}
