import { AlertIcon, LinkExternalIcon, WorkflowIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ACTIVE_STATUSES,
  FACTORY_LIMITS,
  FACTORY_NOT_CONNECTED,
  HANDOFF_LIMITS,
  isTextOutput,
  kilobytes,
  STATUS_LABEL,
  toCsv,
  utf8Bytes,
  workOrderLabel,
} from "../../shared/factory.js";
import type { AnalysisView, ChatItem, FactoryRoutingView, OutputFile, ResultView, SendToFactoryRequest, WorkOrderStatus } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { fileName, firstSentence, formatBytes, formatCount, titleFrom } from "../lib/format.js";
import { tableKey, tableOf, useLoadedRows, useRowSelections, useSelectedResult } from "../lib/selection.js";
import { sendToFactory, useStore } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** The grid loads the dataset 200 rows at a time; before it has, the current view means its first page. */
const FIRST_PAGE = 200;

const PLACEHOLDER =
  "Build a free-shipping progress bar experiment for mobile carts under $50: variant assignment, the bar's copy and threshold logic, and the metrics to watch";

/** Send to Software Factory: opens the dialog, or says why it can't when Software Factory isn't connected. */
export function FactoryButton({ onOpen, className, labelClassName = "max-xl:sr-only" }: { readonly onOpen: () => void; readonly className?: string; readonly labelClassName?: string }) {
  const factory = useStore((state) => state.factory);
  return (
    <Tooltip content={factory.configured ? "Send to Software Factory" : FACTORY_NOT_CONNECTED} className={cx("shrink-0", className)}>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={factory.configured ? undefined : true}
        onClick={() => {
          if (factory.configured) onOpen();
          else toast.info("Software Factory isn't connected", "Start it with aspire run, or set SOFTWARE_FACTORY_URL for Data Desk.");
        }}
      >
        <WorkflowIcon size={16} />
        <span className={labelClassName}>Send to Software Factory</span>
      </button>
    </Tooltip>
  );
}

const TONE: Readonly<Record<WorkOrderStatus, string>> = {
  queued: "text-fg-muted",
  planning: "text-fg-accent",
  building: "text-fg-accent",
  releasing: "text-fg-accent",
  completed: "text-fg-success",
  failed: "text-fg-danger",
  cancelled: "text-fg-muted",
};

/** In the conversation: what was sent to Software Factory, the work order's status, and a way there. */
export function FactoryLine({ routing }: { readonly routing: FactoryRoutingView }) {
  const active = ACTIVE_STATUSES.has(routing.status) && !routing.gone;
  return (
    <div className="Box animate-fade-in px-3 py-2.5 text-sm" role="note">
      <div className="flex items-start gap-2">
        <WorkflowIcon size={16} className="mt-0.5 shrink-0 text-fg-done" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1">
            <span>Sent to Software Factory:</span>
            <span className="font-semibold tabular-nums">{workOrderLabel(routing.number)}</span>
            <span aria-hidden className="text-fg-muted">
              ·
            </span>
            <span className={cx("inline-flex items-center gap-1 font-semibold", TONE[routing.status])}>
              {active ? <Spinner size={12} /> : null}
              {STATUS_LABEL[routing.status]}
            </span>
          </p>
          <p className="truncate text-fg-muted" title={routing.title}>
            {routing.title}
          </p>
          {routing.items.length ? <p className="mt-1 text-xs text-fg-muted">{routing.items.join(" · ")}</p> : null}
          {routing.error ? <p className="mt-1 text-xs text-fg-danger">{routing.error}</p> : null}
          {routing.gone ? <p className="mt-1 text-xs text-fg-muted">Software Factory doesn't have this work order anymore.</p> : null}
          {routing.gone ? null : (
            <a className="btn btn-sm mt-2" href={routing.url} target="_blank" rel="noreferrer">
              <LinkExternalIcon size={16} />
              Open in Software Factory
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

type Answer = Extract<ChatItem, { kind: "assistant" }>;

/** Copilot's latest complete answer: the insight. */
function latestAnswer(view: AnalysisView): Answer | undefined {
  return view.items.findLast((item): item is Answer => item.kind === "assistant" && !item.streaming && item.text.trim() !== "");
}

/** A file the dialog would send, for counting and sizes. */
interface Planned {
  readonly label: string;
  readonly bytes: number;
}

/** About how large a share of the dataset's file is: its rows are about the same size. */
const datasetShare = (view: AnalysisView, rows: number): number => (view.dataset && view.dataset.rows > 0 ? Math.round((view.dataset.bytes * rows) / view.dataset.rows) : 0);

const tableBytes = (result: ResultView, rows: readonly (readonly string[])[] = result.rows): number => utf8Bytes(toCsv(result.columns, rows));

/** Pick what to send to Software Factory from this analysis, and say what it should build. */
export function FactoryDialog({ view, onClose }: { readonly view: AnalysisView; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const shownId = useSelectedResult(view.id);
  const loaded = useLoadedRows(view.id);
  const selections = useRowSelections(view.id);
  const shown = shownId ? view.results.find((result) => result.id === shownId) : undefined;
  const dataset = view.dataset;
  const answer = latestAnswer(view);
  const charts = view.outputs.filter((output) => output.kind === "chart" && isTextOutput(output.path));
  const sendable = view.outputs.filter((output) => isTextOutput(output.path));
  const others = view.results.filter((result) => result.id !== shown?.id);
  const datasetFits = dataset !== undefined && dataset.bytes <= FACTORY_LIMITS.fileBytes;

  const [includeView, setIncludeView] = useState(true);
  const [skippedSelections, setSkippedSelections] = useState<ReadonlySet<string>>(() => new Set());
  const [results, setResults] = useState<ReadonlySet<string>>(() => new Set());
  const [outputs, setOutputs] = useState<ReadonlySet<string>>(() => new Set());
  const [includeDataset, setIncludeDataset] = useState(false);
  const [includeAnswer, setIncludeAnswer] = useState(answer !== undefined);
  const [title, setTitle] = useState(() => (answer ? titleFrom(answer.text) : undefined) ?? view.title);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const noteInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // With a mouse or trackpad, start where the person types; on touch screens, don't open the keyboard over the options.
    if (window.matchMedia("(pointer: fine)").matches) noteInput.current?.focus();
    return () => element?.close();
  }, []);

  const toggle = (set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  // Rows selected in each table still on screen, the table shown first.
  const shownKey = tableKey(shown ? { kind: "result", resultId: shown.id } : { kind: "dataset" });
  const selected = [...selections.entries()]
    .flatMap(([key, rows]) => {
      const table = tableOf(key);
      const result = table.kind === "result" ? view.results.find((candidate) => candidate.id === table.resultId) : undefined;
      if (table.kind === "result" ? !result : !dataset) return [];
      return [{ key, table, rows: [...rows].sort((a, b) => a - b), result }];
    })
    .sort((a, b) => Number(b.key === shownKey) - Number(a.key === shownKey));

  // What would be sent: the same files the server composes, with their sizes (the dataset's rows are estimated).
  const viewRows = dataset ? Math.min(loaded || FIRST_PAGE, HANDOFF_LIMITS.viewRows, dataset.rows) : 0;
  const files: Planned[] = [];
  if (includeView) {
    if (shown) files.push({ label: shown.title, bytes: tableBytes(shown) });
    else if (dataset && !includeDataset) files.push({ label: `The first ${formatCount(viewRows, "row")}`, bytes: datasetShare(view, viewRows) });
  }
  for (const entry of selected) {
    if (skippedSelections.has(entry.key)) continue;
    const bytes = entry.result ? tableBytes(entry.result, entry.rows.flatMap((row) => (entry.result!.rows[row] ? [entry.result!.rows[row]!] : []))) : datasetShare(view, entry.rows.length);
    files.push({ label: `Selected rows of ${entry.result?.title ?? dataset?.fileName ?? "the dataset"}`, bytes });
  }
  for (const result of others) if (results.has(result.id)) files.push({ label: result.title, bytes: tableBytes(result) });
  const outputPaths = sendable
    .filter((output) => output.size <= FACTORY_LIMITS.fileBytes && (outputs.has(output.path) || (includeView && charts.includes(output))))
    .map((output) => output.path);
  for (const path of outputPaths) {
    const output = sendable.find((candidate) => candidate.path === path)!;
    files.push({ label: fileName(output.path), bytes: output.size });
  }
  if (includeDataset && dataset) files.push({ label: dataset.fileName, bytes: dataset.bytes });
  const insightBytes = 1_500 + utf8Bytes(note) + (includeAnswer && answer ? utf8Bytes(answer.text) : 0) + 160 * files.length + 60 * (dataset?.columns.length ?? 0);
  const fileCount = files.length + 1;
  const total = insightBytes + files.reduce((sum, file) => sum + file.bytes, 0);
  const largest = files.find((file) => file.bytes > FACTORY_LIMITS.fileBytes);

  const titleText = title.replace(/\s+/g, " ").trim();
  const noteText = note.trim();
  const reason = !dataset
    ? "This analysis's dataset isn't available anymore, so there's nothing to send."
    : titleText.length < HANDOFF_LIMITS.titleMin || titleText.length > HANDOFF_LIMITS.titleMax
      ? `Give it a title of ${HANDOFF_LIMITS.titleMin} to ${HANDOFF_LIMITS.titleMax} characters.`
      : noteText.length < HANDOFF_LIMITS.noteMin
        ? "Say what the factory should build."
        : noteText.length > HANDOFF_LIMITS.noteMax
          ? `Keep what to build under ${HANDOFF_LIMITS.noteMax.toLocaleString("en-US")} characters.`
          : fileCount > FACTORY_LIMITS.files
            ? `That's ${fileCount} files; the factory takes up to ${FACTORY_LIMITS.files}. Send fewer tables or files.`
            : largest
              ? `${largest.label} is about ${kilobytes(largest.bytes)}; the factory takes files up to ${kilobytes(FACTORY_LIMITS.fileBytes)}.`
              : total > FACTORY_LIMITS.totalBytes
                ? `That's about ${kilobytes(total)}; the factory takes up to ${kilobytes(FACTORY_LIMITS.totalBytes)} of context. Send fewer rows or files.`
                : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason || sending) return;
    const request: SendToFactoryRequest = {
      title: titleText,
      note: noteText,
      include: {
        ...(includeView ? { view: shown ? { kind: "result" as const, resultId: shown.id } : { kind: "dataset" as const, rows: viewRows } } : {}),
        ...(() => {
          const chosen = selected.filter((entry) => !skippedSelections.has(entry.key));
          return chosen.length ? { selections: chosen.map((entry) => ({ table: entry.table, rows: entry.rows })) } : {};
        })(),
        ...(results.size ? { results: others.filter((result) => results.has(result.id)).map((result) => result.id) } : {}),
        ...(outputPaths.length ? { outputs: outputPaths } : {}),
        ...(includeDataset ? { dataset: true } : {}),
        ...(includeAnswer && answer ? { answer: true } : {}),
      },
    };
    setSending(true);
    setError(undefined);
    const failure = await sendToFactory(view.id, request);
    setSending(false);
    if (failure) setError(failure);
    else onClose();
  };

  const viewDetail = shown
    ? `${shown.title} · ${formatCount(shown.rows.length, shown.unit)}`
    : dataset
      ? includeDataset
        ? `${dataset.fileName}: sent whole, below`
        : `${dataset.fileName} · ${viewRows === dataset.rows ? `all ${formatCount(viewRows, "row")}` : `the first ${formatCount(viewRows, "row")}`}`
      : "Nothing to show";

  return (
    <dialog
      ref={dialog}
      className="Dialog backdrop:bg-backdrop"
      aria-labelledby="factory-title"
      onCancel={(event) => {
        if (sending) event.preventDefault();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current && !sending) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
        <div className="Dialog-header">
          <div className="Dialog-headerContent">
            <h2 id="factory-title" className="Dialog-title flex items-center gap-2">
              <WorkflowIcon size={16} className="text-fg-done" />
              Send to Software Factory
            </h2>
            <p className="Dialog-subtitle">The factory plans, builds, and tests what you ask for, with what you pick here as its reference.</p>
          </div>
          <button type="button" className="btn-octicon" aria-label="Close" disabled={sending} onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="Dialog-body flex flex-col gap-4">
          <fieldset className="flex min-w-0 flex-col">
            <legend className="FormControl-label mb-1">What to send</legend>
            <Option checked={includeView} onChange={setIncludeView} disabled={!dataset && !shown} label="Current view" detail={`${viewDetail}${charts.length ? ` · ${formatCount(charts.length, "chart")}` : ""}`} />
            {selected.map((entry) => (
              <Option
                key={entry.key}
                checked={!skippedSelections.has(entry.key)}
                onChange={(on) => setSkippedSelections((current) => toggle(current, entry.key, !on))}
                label={`Selected rows (${entry.rows.length.toLocaleString("en-US")})`}
                detail={`From ${entry.result?.title ?? dataset?.fileName ?? "the dataset"}`}
              />
            ))}
            {answer ? <Option checked={includeAnswer} onChange={setIncludeAnswer} label="Copilot's latest answer" detail={firstSentence(answer.text, 200) ?? "The insight, as text"} /> : null}
            {others.length ? <GroupHeading>Other tables Copilot made</GroupHeading> : null}
            {others.map((result) => (
              <Option
                key={result.id}
                checked={results.has(result.id)}
                onChange={(on) => setResults((current) => toggle(current, result.id, on))}
                label={result.title}
                detail={formatCount(result.rows.length, result.unit)}
                size={tableBytes(result)}
              />
            ))}
            {sendable.length || dataset ? <GroupHeading>Files</GroupHeading> : null}
            {sendable.map((output) => (
              <OutputOption key={output.path} output={output} inView={includeView && charts.includes(output)} checked={outputs.has(output.path)} onChange={(on) => setOutputs((current) => toggle(current, output.path, on))} />
            ))}
            {dataset ? (
              <Option
                checked={includeDataset && datasetFits}
                onChange={setIncludeDataset}
                disabled={!datasetFits}
                label={`The whole dataset (${formatCount(dataset.rows, "row")})`}
                detail={datasetFits ? dataset.fileName : `${dataset.fileName} is ${formatBytes(dataset.bytes)}; the factory takes files up to ${kilobytes(FACTORY_LIMITS.fileBytes)}`}
                size={dataset.bytes}
              />
            ) : null}
          </fieldset>
          <div className="FormControl">
            <label htmlFor="factory-work-title" className="FormControl-label">
              Title<span className="FormControl-required" aria-hidden>*</span>
            </label>
            <input
              id="factory-work-title"
              className="form-control input-block"
              value={title}
              maxLength={HANDOFF_LIMITS.titleMax}
              required
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={titleText.length < HANDOFF_LIMITS.titleMin ? true : undefined}
            />
          </div>
          <div className="FormControl">
            <label htmlFor="factory-work-note" className="FormControl-label">
              What should the factory build?<span className="FormControl-required" aria-hidden>*</span>
            </label>
            <textarea
              id="factory-work-note"
              ref={noteInput}
              className="form-control input-block min-h-28 resize-y"
              rows={4}
              value={note}
              maxLength={HANDOFF_LIMITS.noteMax}
              required
              placeholder={PLACEHOLDER}
              onChange={(event) => setNote(event.target.value)}
              aria-describedby="factory-work-note-caption"
            />
            <p id="factory-work-note-caption" className="FormControl-caption">
              A few sentences: what to build and why. The factory reads this first, then the files.
            </p>
          </div>
          {error ? (
            <div className="flash flash-error flex items-start gap-2" role="alert">
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
        <div className="Dialog-footer items-center">
          <p className={cx("mr-auto min-w-0 text-xs", reason ? "text-fg-muted" : "text-fg-muted tabular-nums")} role="status">
            {reason ?? `${formatCount(fileCount, "file")} · about ${kilobytes(total)} of ${kilobytes(FACTORY_LIMITS.totalBytes)}`}
          </p>
          <button type="button" className="btn" disabled={sending} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={reason !== undefined || sending}>
            {sending ? <Spinner size={16} /> : <WorkflowIcon size={16} />}
            {sending ? "Sending…" : "Send to Software Factory"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function GroupHeading({ children }: { readonly children: ReactNode }) {
  return <p className="mt-3 mb-0.5 text-xs font-semibold text-fg-muted">{children}</p>;
}

function Option({
  checked,
  onChange,
  label,
  detail,
  size,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly detail?: string;
  readonly size?: number;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 py-1">
      <input id={id} type="checkbox" className="mt-1 shrink-0" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id} className={cx("min-w-0 flex-1", disabled && "cursor-not-allowed text-fg-muted")}>
        <span className="block truncate font-semibold" title={label}>
          {label}
        </span>
        {detail ? (
          <span className="block truncate text-xs text-fg-muted" title={detail}>
            {detail}
          </span>
        ) : null}
      </label>
      {size !== undefined ? <span className="shrink-0 pt-0.5 text-xs text-fg-muted tabular-nums">{formatBytes(size)}</span> : null}
    </div>
  );
}

/** A published chart or text file; charts on screen go with the current view. */
function OutputOption({ output, inView, checked, onChange }: { readonly output: OutputFile; readonly inView: boolean; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  const tooLarge = output.size > FACTORY_LIMITS.fileBytes;
  return (
    <Option
      checked={(inView || checked) && !tooLarge}
      onChange={onChange}
      disabled={inView || tooLarge}
      label={fileName(output.path)}
      detail={tooLarge ? `Larger than the ${kilobytes(FACTORY_LIMITS.fileBytes)} the factory takes` : inView ? "A chart on screen: it goes with the current view" : output.kind === "chart" ? "A chart Copilot drew" : "A file Copilot wrote"}
      size={output.size}
    />
  );
}
