import { ContainerIcon, CpuIcon, PulseIcon, TableIcon, UploadIcon } from "@primer/octicons-react";
import { useRef, useState, type DragEvent } from "react";
import type { AnalysisSummary, DatasetSummary, Placement, RemoteSampleSummary } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatCount, relativeTime } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { analysisHref } from "../lib/router.js";
import { createAnalysis, uploadAndAnalyze, useStore } from "../lib/store.js";
import { Spinner } from "./ui/Spinner.js";

/** Each sample's identity color; uploads are gray. */
const TINTS = ["bg-display-blue-muted text-display-blue", "bg-display-green-muted text-display-green", "bg-display-purple-muted text-display-purple", "bg-display-orange-muted text-display-orange"];

export function Home() {
  const datasets = useStore((state) => state.datasets);
  const remoteSamples = useStore((state) => state.remoteSamples);
  const analyses = useStore((state) => state.analyses);
  const platform = useStore((state) => state.platform);
  const [starting, setStarting] = useState<string | undefined>();
  const connected = platform?.state === "connected";

  const start = async (id: string, run: () => Promise<boolean>) => {
    setStarting(id);
    await run();
    setStarting(undefined);
  };

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Chat with a spreadsheet</h1>
          <p className="mt-1 text-fg-muted">It answers on the shared runtime and moves into a sandbox for code.</p>
        </div>
        <PatternDiagram />
      </div>
      {platform && platform.state !== "connected" && platform.message ? (
        <div className="flash flash-warn mt-4" role="status">
          {platform.message}
        </div>
      ) : null}
      <section aria-label="Datasets" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {remoteSamples.map((sample) => (
          <RemoteSampleCard
            key={sample.id}
            sample={sample}
            starting={starting === sample.id}
            disabled={!connected || starting !== undefined}
            onOpen={() => void start(sample.id, () => createAnalysis(sample.id))}
          />
        ))}
        {datasets.map((dataset, index) => (
          <DatasetCard
            key={dataset.id}
            dataset={dataset}
            tint={dataset.sample ? TINTS[index % TINTS.length]! : "bg-neutral-muted text-fg-muted"}
            starting={starting === dataset.id}
            disabled={!connected || starting !== undefined}
            onOpen={() => void start(dataset.id, () => createAnalysis(dataset.id))}
          />
        ))}
        <UploadCard disabled={!connected || starting !== undefined} starting={starting === "upload"} onFile={(file) => void start("upload", () => uploadAndAnalyze(file))} />
      </section>
      {analyses.length ? <Recent analyses={analyses} /> : null}
    </div>
  );
}

/** The pattern in one glance, drawn like the workspace's placement track: shared runtime first, then a sandbox. */
function PatternDiagram() {
  const stop = (Glyph: typeof CpuIcon, label: string, fill: string) => (
    <span className="flex w-24 flex-col items-center gap-1">
      <span className={cx("grid size-9 place-items-center rounded-lg text-fg-on-emphasis", fill)}>
        <Glyph size={18} />
      </span>
      <span className="text-xs font-semibold whitespace-nowrap">{label}</span>
    </span>
  );
  return (
    <div className="flex items-start max-sm:hidden" role="img" aria-label="A session starts on the shared runtime and moves once into a sandbox">
      {stop(CpuIcon, "Shared runtime", "bg-accent-emphasis")}
      <span className="track-fill mt-4 h-1 w-20 rounded-full" />
      {stop(ContainerIcon, "Sandbox", "bg-done-emphasis")}
    </div>
  );
}

function DatasetCard({
  dataset,
  tint,
  starting,
  disabled,
  onOpen,
}: {
  readonly dataset: DatasetSummary;
  readonly tint: string;
  readonly starting: boolean;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="Box group flex flex-col p-4 text-left transition-colors hover:border-line-accent focus-visible:border-line-accent disabled:cursor-not-allowed disabled:hover:border-line"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cx("grid size-8 shrink-0 place-items-center rounded-md", tint)}>{starting ? <Spinner size={16} /> : <TableIcon size={16} />}</span>
        <span className="truncate font-semibold" title={dataset.name}>
          {dataset.name}
        </span>
      </span>
      <span className="mt-2 line-clamp-1 text-sm text-fg-muted" title={dataset.description ?? dataset.fileName}>
        {dataset.description ?? dataset.fileName}
      </span>
      <span className="mt-auto pt-3 text-xs text-fg-muted tabular-nums">
        {starting ? "Starting…" : `${formatCount(dataset.rows, "row")} · ${formatCount(dataset.columns.length, "column")}`}
      </span>
    </button>
  );
}

/** A sample another app serves: each pick fetches its latest data, so its size isn't known until then. */
function RemoteSampleCard({
  sample,
  starting,
  disabled,
  onOpen,
}: {
  readonly sample: RemoteSampleSummary;
  readonly starting: boolean;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="Box group flex flex-col p-4 text-left transition-colors hover:border-line-accent focus-visible:border-line-accent disabled:cursor-not-allowed disabled:hover:border-line"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-display-red-muted text-display-red">{starting ? <Spinner size={16} /> : <PulseIcon size={16} />}</span>
        <span className="truncate font-semibold" title={sample.name}>
          {sample.name}
        </span>
      </span>
      <span className="mt-2 line-clamp-2 text-sm text-fg-muted" title={sample.description}>
        {sample.description}
      </span>
      <span className="mt-auto flex items-center gap-2 pt-3 text-xs text-fg-muted">
        <span className="Label Label--danger shrink-0">
          <span aria-hidden className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
          Live
        </span>
        <span className="truncate">{starting ? "Fetching the latest…" : "Fresh each time you open it"}</span>
      </span>
    </button>
  );
}

function UploadCard({ disabled, starting, onFile }: { readonly disabled: boolean; readonly starting: boolean; readonly onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const maxBytes = useStore((state) => state.maxUploadBytes);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && !disabled) onFile(file);
  };
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cx(
        "flex flex-col rounded-md border border-dashed p-4 transition-colors",
        over ? "border-line-accent bg-accent-muted" : "border-line-emphasis",
        disabled ? "opacity-60" : "hover:border-line-accent",
      )}
    >
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="flex flex-col text-left disabled:cursor-not-allowed">
        <span className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-canvas-muted text-fg-muted">{starting ? <Spinner size={16} /> : <UploadIcon size={16} />}</span>
          <span className="font-semibold">Upload a CSV</span>
        </span>
        <span className="mt-2 text-sm text-fg-muted">{starting ? "Reading it…" : "Drop a file here, or browse"}</span>
        <span className="mt-3 text-xs text-fg-muted">Up to {Math.round(maxBytes / (1024 * 1024))} MB</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}

export function PlacementGlyph({ placement, size = 16 }: { readonly placement: Placement; readonly size?: number }) {
  if (placement === "moving") return <Spinner size={size} className="text-fg-done" label="Moving into a sandbox" />;
  return placement === "sandbox" ? (
    <ContainerIcon size={size} className="shrink-0 text-fg-done" aria-label="In its sandbox" />
  ) : (
    <CpuIcon size={size} className="shrink-0 text-fg-accent" aria-label="On the shared runtime" />
  );
}

function Recent({ analyses }: { readonly analyses: readonly AnalysisSummary[] }) {
  const now = useNow(true, 30_000);
  return (
    <section aria-labelledby="recent" className="mt-10">
      <h2 id="recent" className="text-base font-semibold">
        Recent
      </h2>
      <ul className="Box mt-2 overflow-hidden">
        {analyses.slice(0, 8).map((analysis) => (
          <li key={analysis.id} className="border-t border-line-muted first:border-t-0">
            <a href={analysisHref(analysis.id)} className="flex min-w-0 items-center gap-3 px-4 py-3 text-fg hover:bg-canvas-muted hover:no-underline focus-visible:bg-canvas-muted">
              <PlacementGlyph placement={analysis.placement} />
              <span className="min-w-0 truncate font-semibold" title={analysis.title}>
                {analysis.title}
              </span>
              {analysis.needsYou ? <span className="Label Label--attention shrink-0">Needs you</span> : analysis.busy ? <span className="Label Label--accent shrink-0">Working</span> : null}
              <span className="ml-auto shrink-0 text-xs text-fg-muted tabular-nums">
                {analysis.charts ? `${formatCount(analysis.charts, "chart")} · ` : ""}
                {relativeTime(analysis.updatedAt, now)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
