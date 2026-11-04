import {
  BellFillIcon,
  CheckCircleFillIcon,
  ChevronRightIcon,
  ContainerIcon,
  CopilotIcon,
  CpuIcon,
  NoteIcon,
  PersonIcon,
  RocketIcon,
  ShieldIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import { useEffect, useRef } from "react";
import type { TimelineEntry, TimelineKind } from "../../shared/types.js";
import { clock, cx } from "../lib/format.js";

const KIND: Record<TimelineKind, { readonly icon: Icon; readonly tone: string }> = {
  alert: { icon: BellFillIcon, tone: "text-fg-danger" },
  note: { icon: CopilotIcon, tone: "text-fg-done" },
  sandbox: { icon: ContainerIcon, tone: "text-fg-accent" },
  worker: { icon: ContainerIcon, tone: "text-fg-accent" },
  approval: { icon: ShieldIcon, tone: "text-fg-attention" },
  deploy: { icon: RocketIcon, tone: "text-fg-success" },
  postmortem: { icon: NoteIcon, tone: "text-fg-done" },
  person: { icon: PersonIcon, tone: "text-fg" },
  resolved: { icon: CheckCircleFillIcon, tone: "text-fg-success" },
  platform: { icon: CpuIcon, tone: "text-fg-muted" },
  error: { icon: XCircleFillIcon, tone: "text-fg-danger" },
};

function Entry({ entry }: { readonly entry: TimelineEntry }) {
  const kind = KIND[entry.kind];
  const Glyph = kind.icon;
  const row = (
    <>
      <span className="w-14 shrink-0 pt-px font-mono text-xs text-fg-muted tabular-nums">{clock(entry.at)}</span>
      <Glyph size={16} className={cx("mt-0.5 shrink-0", kind.tone)} />
      <span className="min-w-0 flex-1 truncate" title={entry.text}>
        {entry.text}
      </span>
    </>
  );
  if (!entry.detail) return <li className="flex items-start gap-2 px-3 py-1.5 text-sm">{row}</li>;
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-canvas-muted [&::-webkit-details-marker]:hidden">
          {row}
          <ChevronRightIcon size={16} className="mt-0.5 shrink-0 text-fg-muted transition-transform group-open:rotate-90" />
        </summary>
        <p className="mx-3 mb-2 ml-[5.5rem] max-h-64 overflow-y-auto rounded-md bg-canvas-inset p-2 text-xs whitespace-pre-wrap">{entry.detail}</p>
      </details>
    </li>
  );
}

/** What happened, oldest first. Follows the newest entry while it's in view. */
export function Timeline({ entries }: { readonly entries: readonly TimelineEntry[] }) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = list.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [entries.length]);
  return (
    <section aria-label="Timeline" className="Box flex min-h-0 flex-col">
      <h2 className="border-b border-line-muted px-4 py-3 text-sm font-semibold">Timeline</h2>
      <ol
        ref={list}
        className="flex max-h-[28rem] flex-col overflow-y-auto py-2"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </ol>
    </section>
  );
}
