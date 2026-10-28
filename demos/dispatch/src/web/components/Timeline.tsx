import { CopilotIcon, TerminalIcon } from "@primer/octicons-react";
import type { CSSProperties, ReactNode } from "react";
import type { Blueprint, ConversationView, WorkerState } from "../../shared/types.js";
import { KIND_ICON, KIND_LANE, WORKER_STATE } from "../lib/blueprints.js";
import { kindOf } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { formatClock, formatDuration, parseTime } from "../lib/format.js";
import { conversationHref, navigate } from "../lib/router.js";
import { useNow } from "../lib/useNow.js";
import { handsTitle } from "./Environments.js";
import { EmptyState } from "./ui/Feedback.js";

const STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400].map((seconds) => seconds * 1000);

const BAR: Readonly<Record<Exclude<WorkerState, "stopped">, string>> = {
  starting: "tl-starting",
  working: "tl-working",
  idle: "tl-idle",
  failed: "tl-failed",
};

interface Segment {
  readonly state: Exclude<WorkerState, "stopped">;
  readonly from: number;
  readonly to: number;
}

export function Timeline({ view, blueprints, selected }: { readonly view: ConversationView; readonly blueprints: readonly Blueprint[]; readonly selected?: string }) {
  const active = view.busy || view.workers.some((worker) => worker.state === "starting" || worker.state === "working");
  const now = useNow(active);
  const users = view.messages.filter((message) => message.role === "user");
  if (users.length === 0 && view.workers.length === 0) {
    return (
      <EmptyState icon={CopilotIcon} title="Nothing has happened yet" size="sm">
        Sandboxes appear here as the agent creates them.
      </EmptyState>
    );
  }

  const times: number[] = [];
  const add = (iso: string | undefined) => {
    const time = parseTime(iso);
    if (time !== undefined) times.push(time);
  };
  for (const message of view.messages) {
    add(message.at);
    for (const decision of message.decisions ?? []) {
      add(decision.at);
      add(decision.endedAt);
    }
  }
  for (const worker of view.workers) {
    add(worker.createdAt);
    for (const entry of worker.timeline) add(entry.at);
  }
  const start = Math.min(...times);
  const end = active ? now : Math.max(...times, start + 60_000) + 5_000;
  const span = Math.max(1, end - start);
  const x = (time: number) => `${(((time - start) / span) * 100).toFixed(3)}%`;
  const width = (from: number, to: number) => `${Math.max(0.4, ((to - from) / span) * 100).toFixed(3)}%`;
  const step = STEPS.find((candidate) => span / candidate <= 7) ?? STEPS.at(-1)!;
  const ticks: number[] = [];
  for (let tick = 0; tick <= span; tick += step) ticks.push(tick);

  const waits = users.flatMap((message) => (message.decisions ?? []).filter((decision) => decision.kind === "wait"));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <Swatch className="tl-starting">Preparing its sandbox</Swatch>
        <Swatch className="tl-working">Working</Swatch>
        <Swatch className="tl-idle">Idle, sandbox kept</Swatch>
        <Swatch className="tl-failed">Failed</Swatch>
        <span>A bar ends when its worker stopped and its sandbox was deleted.</span>
      </div>
      <div className="rounded-lg border border-line bg-canvas p-3">
        <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          {/* Axis with the person's messages. */}
          <div />
          <div className="relative h-9 border-b border-line-muted">
            {ticks.map((tick) => (
              <span key={tick} className="absolute bottom-0 -translate-x-1/2 font-mono text-fg-muted tabular-nums" style={{ left: x(start + tick) }}>
                {formatDuration(tick)}
              </span>
            ))}
            {users.map((message) => {
              const time = parseTime(message.at) ?? start;
              return (
                <span
                  key={message.id}
                  className={cx("absolute top-0 inline-flex -translate-x-1/2 items-center gap-0.5", message.via === "other" ? "Label Label--secondary" : "Label Label--accent")}
                  style={{ left: x(time) }}
                  title={`#${message.index} at ${formatClock(message.at)}${message.via === "other" ? " from Copilot CLI" : ""}: ${message.content}`}
                >
                  {message.via === "other" ? <TerminalIcon size={10} /> : null}#{message.index}
                </span>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 font-semibold">
            <CopilotIcon size={14} className="text-fg-muted" />
            Coordinator
          </div>
          <Track users={users.map((message) => parseTime(message.at) ?? start)} x={x}>
            {waits.map((decision) => {
              const from = parseTime(decision.at) ?? start;
              const to = parseTime(decision.endedAt) ?? end;
              return (
                <span
                  key={decision.id}
                  className="absolute inset-y-1 rounded-sm border border-dashed border-line bg-canvas-muted"
                  style={{ left: x(from), width: width(from, to) }}
                  title={`Waiting for ${decision.workers?.join(", ") || "its workers"}: ${formatDuration(to - from)}, no model time`}
                />
              );
            })}
          </Track>

          {view.workers.map((worker) => {
            const kind = kindOf(worker.environment, blueprints);
            const Glyph = KIND_ICON[kind];
            const segments: Segment[] = [];
            const entries = worker.timeline.length ? worker.timeline : [{ state: worker.state, at: worker.createdAt }];
            entries.forEach((entry, index) => {
              if (entry.state === "stopped") return;
              const from = parseTime(entry.at) ?? start;
              const to = parseTime(entries[index + 1]?.at) ?? end;
              segments.push({ state: entry.state, from, to });
            });
            return (
              <div key={worker.id} className="contents">
                <button
                  type="button"
                  aria-pressed={worker.id === selected}
                  onClick={() => navigate(conversationHref(view.id, { tab: "timeline", ...(worker.id === selected ? {} : { worker: worker.id }) }), { replace: true })}
                  className={cx("flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:bg-canvas-muted", worker.id === selected && "bg-accent-muted")}
                  style={{ "--lane": KIND_LANE[kind] } as CSSProperties}
                  title={`${worker.role === "hands" ? handsTitle(view, worker) : worker.name} in ${worker.environment}: ${worker.role === "hands" ? "no agent in it" : WORKER_STATE[worker.state].label}`}
                >
                  <Glyph size={14} className="lane-icon shrink-0" />
                  <span className="min-w-0 truncate font-semibold">{worker.role === "hands" ? handsTitle(view, worker) : worker.name}</span>
                </button>
                <Track users={users.map((message) => parseTime(message.at) ?? start)} x={x} style={{ "--lane": KIND_LANE[kind] } as CSSProperties}>
                  {segments.map((segment) => (
                    <span
                      key={`${segment.state}-${segment.from}`}
                      className={cx("absolute inset-y-1 rounded-sm", BAR[segment.state])}
                      style={{ left: x(segment.from), width: width(segment.from, segment.to) }}
                      title={`${WORKER_STATE[segment.state].label}: ${formatDuration(segment.to - segment.from)} (from ${formatClock(new Date(segment.from).toISOString())})`}
                    />
                  ))}
                </Track>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Track({ users, x, style, children }: { readonly users: readonly number[]; readonly x: (time: number) => string; readonly style?: CSSProperties; readonly children: ReactNode }) {
  return (
    <div className="relative h-7 rounded-md bg-canvas-inset" style={style}>
      {users.map((time) => (
        <span key={time} className="absolute inset-y-0 w-px bg-[var(--borderColor-accent-muted)]" style={{ left: x(time) }} aria-hidden />
      ))}
      {children}
    </div>
  );
}

function Swatch({ className, children }: { readonly className: string; readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ "--lane": "var(--fgColor-accent)" } as CSSProperties}>
      <span className={cx("inline-block h-3 w-5 rounded-sm", className)} aria-hidden />
      {children}
    </span>
  );
}
