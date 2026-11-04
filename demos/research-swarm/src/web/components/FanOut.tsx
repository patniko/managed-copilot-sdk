import { BookIcon, ContainerIcon, CopilotIcon, CpuIcon, ShieldXIcon } from "@primer/octicons-react";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import type { Researcher, ResearcherState, Run } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { pagesRead, plural } from "../lib/format.js";
import { useStore } from "../lib/store.js";
import { ResearcherStateBadge } from "./Status.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

interface Wire {
  readonly key: string;
  readonly d: string;
  readonly className: string;
}

const OUT: Readonly<Record<ResearcherState, string>> = {
  queued: "wire-queued",
  starting: "wire-active",
  reading: "wire-active",
  done: "wire-done",
  failed: "wire-failed",
  stopped: "wire-queued",
};

/** The wire from a researcher into the report: its findings are in once it's done, and flow while the lead writes. */
function inWire(researcher: Researcher, run: Run): string {
  if (researcher.state !== "done") return "wire-queued";
  return run.status === "writing" ? "wire-active" : "wire-done";
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const middle = (y1 + y2) / 2;
  return `M${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
};

/**
 * The run at a glance: the lead (on the shared runtime) fans the question out to researchers (each in a sandbox),
 * whose findings flow back into one report. Wires show who is working; with the cards in one row they fan out, and
 * when the cards wrap (narrow screens) one spine joins the lead and the report.
 */
export function FanOut({ run, onOpen }: { readonly run: Run; readonly onOpen: (id: string) => void }) {
  const max = useStore((state) => state.app?.swarm?.researchers.max ?? 4);
  const container = useRef<HTMLDivElement>(null);
  const lead = useRef<HTMLDivElement>(null);
  const report = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const [geometry, setGeometry] = useState<{ width: number; height: number; wires: Wire[] }>({ width: 0, height: 0, wires: [] });
  const researchers = run.researchers;
  const planning = researchers.length === 0;
  const columns = planning ? Math.min(max, 4) : researchers.length;

  const measure = useCallback(() => {
    const box = container.current?.getBoundingClientRect();
    const top = lead.current?.getBoundingClientRect();
    const bottom = report.current?.getBoundingClientRect();
    if (!box || !top || !bottom) return;
    const rects = cards.current.slice(0, columns).map((card) => card?.getBoundingClientRect());
    const x = (rect: DOMRect) => rect.left + rect.width / 2 - box.left;
    const wires: Wire[] = [];
    const oneRow = rects.every((rect) => rect && Math.abs(rect.top - rects[0]!.top) < 2);
    if (oneRow) {
      rects.forEach((rect, index) => {
        if (!rect) return;
        const researcher = researchers[index];
        wires.push({ key: `out-${index}`, d: curve(x(top), top.bottom - box.top, x(rect), rect.top - box.top), className: researcher ? OUT[researcher.state] : "wire-queued" });
        wires.push({ key: `in-${index}`, d: curve(x(rect), rect.bottom - box.top, x(bottom), bottom.top - box.top), className: researcher ? inWire(researcher, run) : "wire-queued" });
      });
    } else {
      const busy = researchers.some((researcher) => researcher.state === "starting" || researcher.state === "reading") || run.status === "writing";
      wires.push({ key: "spine", d: `M${x(top)} ${top.bottom - box.top} L${x(bottom)} ${bottom.top - box.top}`, className: busy ? "wire-active" : run.status === "done" ? "wire-done" : "wire-queued" });
    }
    setGeometry({ width: box.width, height: box.height, wires });
  }, [columns, researchers, run]);

  useLayoutEffect(() => {
    measure();
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div ref={container} className="relative flex flex-col gap-10 sm:gap-14">
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={geometry.width} height={geometry.height} aria-hidden>
        {geometry.wires.map((wire) => (
          <path key={wire.key} d={wire.d} className={cx("wire", wire.className)} />
        ))}
      </svg>
      <Lead ref={lead} run={run} />
      <ol
        className="relative grid gap-4 sm:grid-cols-2 lg:[grid-template-columns:repeat(var(--columns),minmax(0,1fr))]"
        style={{ "--columns": columns } as CSSProperties}
        aria-label="Researchers"
      >
        {planning
          ? Array.from({ length: columns }, (_, index) => (
              <li key={index} ref={(element) => void (cards.current[index] = element)} className="flex min-h-44 flex-col gap-3 rounded-lg border border-dashed border-line bg-canvas p-3">
                <div className="flex items-center gap-2 text-fg-muted">
                  <ContainerIcon size={16} />
                  <span className="SkeletonText w-24" />
                </div>
                <span className="SkeletonText w-full" />
                <span className="SkeletonText w-2/3" />
              </li>
            ))
          : researchers.map((researcher, index) => (
              <li key={researcher.id} ref={(element) => void (cards.current[index] = element)} className="flex">
                <ResearcherCard researcher={researcher} index={index} onOpen={onOpen} />
              </li>
            ))}
      </ol>
      <ReportNode ref={report} run={run} />
    </div>
  );
}

function Lead({ run, ref }: { readonly run: Run; readonly ref: Ref<HTMLDivElement> }) {
  const active = run.status === "planning" || run.status === "researching" || run.status === "writing";
  return (
    <div ref={ref} className="relative mx-auto w-full max-w-2xl rounded-lg border border-line-accent bg-canvas p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="grid size-7 place-items-center rounded-full bg-accent-muted text-fg-accent">
          <CopilotIcon size={16} />
        </span>
        <span className="font-semibold">Lead</span>
        <Tooltip content="The lead runs on the shared runtime: no sandbox of its own, and no web access.">
          <span className="inline-flex items-center gap-1 text-fg-muted" tabIndex={0}>
            <CpuIcon size={14} />
            Shared runtime
          </span>
        </Tooltip>
        {active && run.activity ? (
          <span className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-fg-accent" role="status">
            <Spinner size={14} />
            <span className="truncate">{run.activity}</span>
          </span>
        ) : null}
      </div>
      <p className="mt-3 line-clamp-3 text-lg leading-snug font-semibold" title={run.question}>
        {run.question}
      </p>
    </div>
  );
}

const CARD_BORDER: Readonly<Record<ResearcherState, string>> = {
  queued: "border-line",
  starting: "border-line",
  reading: "border-line-accent",
  done: "border-line-success-muted",
  failed: "border-line-danger-muted",
  stopped: "border-line",
};

function ResearcherCard({ researcher, index, onOpen }: { readonly researcher: Researcher; readonly index: number; readonly onOpen: (id: string) => void }) {
  const latest = researcher.pages.at(-1);
  const waiting = researcher.state === "queued" ? "Waiting to start" : researcher.state === "starting" ? "Starting its sandbox" : undefined;
  return (
    <button
      type="button"
      onClick={() => onOpen(researcher.id)}
      className={cx(
        "flex min-h-44 w-full flex-col gap-2 rounded-lg border bg-canvas p-3 text-left shadow-xs transition-colors hover:border-line-emphasis focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        CARD_BORDER[researcher.state],
      )}
    >
      <span className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-canvas-muted text-fg-muted">
          <ContainerIcon size={14} />
        </span>
        <span className="text-sm font-semibold">Researcher {index + 1}</span>
        <span className="ml-auto">
          <ResearcherStateBadge state={researcher.state} />
        </span>
      </span>
      <span className="line-clamp-3 text-sm" title={researcher.question}>
        {researcher.question}
      </span>
      <span className="mt-auto flex flex-col gap-1.5">
        {waiting ? (
          <span className="text-xs text-fg-muted">{waiting}</span>
        ) : researcher.pages.length === 0 && researcher.state !== "reading" ? (
          <span className="line-clamp-2 text-xs text-fg-muted" title={researcher.error}>
            {researcher.error ?? "It read no pages."}
          </span>
        ) : (
          <>
            <PageDots count={researcher.pages.length} reading={researcher.state === "reading"} />
            <span className="truncate text-xs text-fg-muted" title={latest ? `${latest.title} (${latest.host})` : undefined}>
              {latest ? `${latest.title} · ${latest.host}` : "Searching the allowed sites"}
            </span>
          </>
        )}
        {researcher.blocked.length > 0 ? (
          <span className="flex items-center gap-1 truncate text-xs text-fg-danger" title={researcher.blocked.map((blocked) => blocked.host).join(", ")}>
            <ShieldXIcon size={12} className="shrink-0" />
            Blocked: {researcher.blocked.map((blocked) => blocked.host).join(", ")}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** ●●●○: one dot per page read, and a pulsing one while it reads the next. */
function PageDots({ count, reading }: { readonly count: number; readonly reading: boolean }) {
  const shown = Math.min(count, 8);
  return (
    <span className="flex items-center gap-1.5" aria-label={plural(count, "page")}>
      <span className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: shown }, (_, index) => (
          <span key={index} className="size-2 animate-fade-in rounded-full bg-fg-accent" />
        ))}
        {reading ? <span className="size-2 animate-pulse rounded-full border border-line-accent" /> : null}
      </span>
      <span className="text-xs font-medium text-fg-muted">{count > shown ? `+${count - shown} · ` : ""}{plural(count, "page")}</span>
    </span>
  );
}

function ReportNode({ run, ref }: { readonly run: Run; readonly ref: Ref<HTMLDivElement> }) {
  const pages = pagesRead(run);
  const status =
    run.status === "writing"
      ? `Writing from ${plural(pages, "page")}`
      : run.status === "done"
        ? `Ready · ${plural(run.report?.sources.length ?? 0, "source")}`
        : run.status === "failed" || run.status === "stopped"
          ? "Not written"
          : pages > 0
            ? `${plural(pages, "page")} read so far`
            : "Waits for the researchers";
  return (
    <div ref={ref} className={cx("relative mx-auto flex w-full max-w-sm items-center gap-3 rounded-lg border bg-canvas p-3 shadow-sm", run.status === "done" ? "border-line-success" : "border-line")}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success-muted text-fg-success">
        <BookIcon size={16} />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">Report</span>
        <span className="flex items-center gap-1.5 text-sm text-fg-muted" role="status">
          {run.status === "writing" ? <Spinner size={12} className="text-fg-accent" /> : null}
          <span className="truncate">{status}</span>
        </span>
      </span>
    </div>
  );
}
