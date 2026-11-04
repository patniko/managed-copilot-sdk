import { CheckIcon, ContainerIcon, CopilotIcon, CpuIcon, ShieldIcon, type Icon } from "@primer/octicons-react";
import type { AnalysisView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatRequests, formatSeconds, shortId } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

export type TrackState = "shared" | "asking" | "moving" | "sandbox";

export function trackState(view: AnalysisView): TrackState {
  if (view.placement === "sandbox") return "sandbox";
  if (view.placement === "moving") return "moving";
  return view.moveRequest ? "asking" : "shared";
}

function Station({ icon: Glyph, label, tone, state }: { readonly icon: Icon; readonly label: string; readonly tone: "accent" | "done"; readonly state: "active" | "idle" | "waiting" }) {
  return (
    <div className="flex w-20 shrink-0 flex-col items-center gap-1 sm:w-24">
      <span
        className={cx(
          "station grid size-10 place-items-center rounded-lg border-2 transition-colors duration-500",
          state === "active" && (tone === "accent" ? "border-line-accent bg-accent-emphasis text-fg-on-emphasis" : "station-arrive border-line-done bg-done-emphasis text-fg-on-emphasis"),
          state === "idle" && "border-line bg-canvas text-fg-muted",
          state === "waiting" && "station-waiting border-dashed border-line-done bg-done-muted text-fg-done",
        )}
      >
        <Glyph size={20} />
      </span>
      <span className={cx("text-xs whitespace-nowrap", state === "active" ? "font-semibold text-fg" : "text-fg-muted")}>{label}</span>
    </div>
  );
}

/**
 * Where the analysis's session runs, as one picture: the shared runtime on the left, its sandbox on the right, and the
 * session (its ID never changes) between them. The session slides across when `session.promoted` arrives.
 */
export function PlacementTrack({ view, className }: { readonly view: AnalysisView; readonly className?: string }) {
  const state = trackState(view);
  const now = useNow(state === "moving");
  const position = state === "sandbox" ? 1 : state === "moving" ? 0.5 : 0;
  return (
    <div className={cx("min-w-0", className)} data-track={state}>
      <div className="flex items-start">
        <Station icon={CpuIcon} label="Shared runtime" tone="accent" state={state === "sandbox" || state === "moving" ? "idle" : "active"} />
        <div className="relative mt-5 h-0 min-w-16 flex-1 -translate-y-px">
          <div className={cx("absolute inset-x-0 -top-0.5 h-1 rounded-full", state === "moving" ? "track-marching" : "bg-neutral-muted")} />
          <div className="track-fill absolute -top-0.5 left-0 h-1 rounded-full" style={{ width: `${position * 100}%` }} />
          <div className="track-puck absolute top-0" style={{ ["--at" as string]: String(position) }}>
            <Tooltip content={`Session ${view.id}: the same ID before and after the move`}>
              <span
                className={cx(
                  "inline-flex -translate-y-1/2 items-center gap-1.5 rounded-full border-2 bg-canvas px-2.5 py-1 font-mono text-xs font-semibold shadow-sm",
                  state === "asking" ? "puck-asking border-line-attention" : state === "sandbox" ? "border-line-done" : state === "moving" ? "puck-moving border-line-done" : "border-line-accent",
                )}
                tabIndex={0}
                aria-label={`Session ${shortId(view.id)}`}
              >
                <CopilotIcon size={14} className={state === "sandbox" || state === "moving" ? "text-fg-done" : "text-fg-accent"} />
                {shortId(view.id)}
              </span>
            </Tooltip>
          </div>
          <Caption view={view} state={state} now={now} />
        </div>
        <Station icon={ContainerIcon} label="Sandbox" tone="done" state={state === "sandbox" ? "active" : state === "moving" ? "waiting" : "idle"} />
      </div>
    </div>
  );
}

function Caption({ view, state, now }: { readonly view: AnalysisView; readonly state: TrackState; readonly now: number }) {
  const common = "absolute inset-x-0 top-5 flex items-center justify-center gap-1 text-xs whitespace-nowrap";
  if (state === "asking") {
    return (
      <span className={cx(common, "font-semibold text-fg-attention")}>
        <ShieldIcon size={12} /> Wants a sandbox
      </span>
    );
  }
  if (state === "moving") {
    const since = view.movingSince ? Date.parse(view.movingSince) : now;
    return (
      <span className={cx(common, "font-semibold text-fg-done")} role="status">
        <Spinner size={12} /> Moving · {formatSeconds(now - since)}
      </span>
    );
  }
  if (state === "sandbox") {
    return (
      <span className={cx(common, "text-fg-muted")}>
        <CheckIcon size={12} className="text-fg-success" />
        {view.moveMs !== undefined ? `Moved in ${formatSeconds(view.moveMs)}` : "Moved"}
        <span className="max-sm:hidden">· same session</span>
      </span>
    );
  }
  return null;
}

/** Premium requests on each side of the move: one session, one running count. */
export function UsageMeter({ view }: { readonly view: AnalysisView }) {
  const usage = view.usage;
  const total = usage?.premiumRequests ?? 0;
  const before = usage?.beforeMove;
  const moved = view.placement === "sandbox";
  const split = moved && before !== undefined;
  const after = split ? Math.max(0, total - before) : 0;
  const tip = split
    ? `${formatRequests(before)} on the shared runtime, ${formatRequests(after)} in the sandbox. The count carried across the move: it's the same session.`
    : moved
      ? `${formatRequests(total)} premium requests in this session, across the move.`
      : `${formatRequests(total)} premium requests so far, all on the shared runtime.`;
  return (
    <Tooltip content={tip} className="shrink-0">
      <span className="flex flex-col items-end gap-0.5" tabIndex={0}>
        <span className="text-xs text-fg-muted whitespace-nowrap">Premium requests</span>
        <span className="flex items-center gap-3 text-base font-semibold tabular-nums">
          {split || !moved ? (
            <span className="flex items-center gap-1 text-fg-accent">
              <CpuIcon size={16} />
              {formatRequests(split ? before : total)}
            </span>
          ) : null}
          {split ? (
            <span className="flex animate-fade-in items-center gap-1 text-fg-done">
              <ContainerIcon size={16} />
              {formatRequests(after)}
            </span>
          ) : null}
          {moved && !split ? <span>{formatRequests(total)}</span> : null}
        </span>
      </span>
    </Tooltip>
  );
}
