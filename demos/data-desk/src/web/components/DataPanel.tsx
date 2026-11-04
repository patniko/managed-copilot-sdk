import { CalendarIcon, DownloadIcon, FileIcon, GraphIcon, NumberIcon, PlugIcon, TableIcon, TypographyIcon, XIcon, type Icon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import type { AnalysisView, ColumnType, DatasetSummary, OutputFile, ResultView } from "../../shared/types.js";
import { api, errorMessage, outputUrl } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { fileName, formatCell, formatCount, isNumeric } from "../lib/format.js";
import { selectResult, useSelectedResult } from "../lib/selection.js";
import { Spinner } from "./ui/Spinner.js";

const TYPE_ICON: Readonly<Record<ColumnType, Icon>> = { number: NumberIcon, date: CalendarIcon, text: TypographyIcon };
const PAGE = 200;

/** The data side of the workspace: published charts on top, then the grid. */
export function DataPanel({ view, className }: { readonly view: AnalysisView; readonly className?: string }) {
  const selected = useSelectedResult(view.id);
  const latest = view.results.at(-1)?.id;
  // A result that arrives while the analysis is open takes over the grid; opening an analysis shows its dataset.
  const seen = useRef(latest);
  useEffect(() => {
    if (latest && latest !== seen.current) selectResult(view.id, latest);
    seen.current = latest;
  }, [latest, view.id]);
  const result = selected ? view.results.find((candidate) => candidate.id === selected) : undefined;
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
            <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatCount(result.total, result.rows.length < result.total ? "match" : "row", result.rows.length < result.total ? "matches" : "rows")}</span>
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
      {result ? <ResultGrid key={result.id} result={result} /> : view.dataset ? <DatasetGrid key={view.dataset.id} dataset={view.dataset} /> : <p className="p-4 text-fg-muted">This analysis's dataset isn't available anymore.</p>}
    </section>
  );
}

interface GridColumn {
  readonly name: string;
  readonly type?: ColumnType;
  readonly numeric: boolean;
}

function Grid({ columns, rows, format, footer }: { readonly columns: readonly GridColumn[]; readonly rows: readonly (readonly string[])[]; readonly format: boolean; readonly footer?: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="Table Table--sticky Table--condensed">
        <thead>
          <tr>
            <th className="w-10 text-right tabular-nums" aria-label="Row" />
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
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td className="text-right text-xs text-fg-muted tabular-nums">{index + 1}</td>
              {columns.map((column, position) => {
                const cell = row[position] ?? "";
                return (
                  <td key={column.name} className={cx("max-w-[18rem] truncate whitespace-nowrap", column.numeric && "text-right tabular-nums")} title={cell.length > 30 ? cell : undefined}>
                    {format ? formatCell(cell) : cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

function DatasetGrid({ dataset }: { readonly dataset: DatasetSummary }) {
  const [rows, setRows] = useState<readonly (readonly string[])[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
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
  }, []);
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

function ResultGrid({ result }: { readonly result: ResultView }) {
  const columns: GridColumn[] = result.columns.map((name, position) => {
    const cells = result.rows.map((row) => row[position] ?? "").filter((cell) => cell.trim() !== "");
    return { name, numeric: cells.length > 0 && cells.every(isNumeric) };
  });
  return <Grid columns={columns} rows={result.rows} format footer={result.rows.length < result.total ? <p className="p-3 text-center text-xs text-fg-muted">The first {result.rows.length} of {formatCount(result.total, "match", "matches")}</p> : null} />;
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
