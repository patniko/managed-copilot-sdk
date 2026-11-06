import { CheckCircleFillIcon, CircleIcon, CircleSlashIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { ResearcherState, RunStatus } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { RESEARCHER_STATE, RUN_STATUS } from "../lib/format.js";
import { Spinner } from "./ui/Spinner.js";

type Look = "busy" | "waiting" | "done" | "failed" | "stopped";

const RUN_LOOK: Readonly<Record<RunStatus, Look>> = { planning: "busy", researching: "busy", writing: "busy", done: "done", failed: "failed", stopped: "stopped" };
const RESEARCHER_LOOK: Readonly<Record<ResearcherState, Look>> = { queued: "waiting", starting: "busy", reading: "busy", done: "done", failed: "failed", stopped: "stopped" };

const LOOK_TEXT: Readonly<Record<Look, string>> = {
  busy: "text-fg-accent",
  waiting: "text-fg-muted",
  done: "text-fg-success",
  failed: "text-fg-danger",
  stopped: "text-fg-muted",
};

function Glyph({ look, size }: { readonly look: Look; readonly size: number }) {
  switch (look) {
    case "busy":
      return <Spinner size={size} className="text-fg-accent" />;
    case "waiting":
      return <CircleIcon size={size} className="shrink-0 text-fg-muted" />;
    case "done":
      return <CheckCircleFillIcon size={size} className="shrink-0 text-fg-success" />;
    case "failed":
      return <XCircleFillIcon size={size} className="shrink-0 text-fg-danger" />;
    case "stopped":
      return <CircleSlashIcon size={size} className="shrink-0 text-fg-muted" />;
  }
}

/** A run's status as an icon, and with `label`, one word. */
export function RunStatusBadge({ status, label = true, size = 16 }: { readonly status: RunStatus; readonly label?: boolean; readonly size?: number }) {
  const look = RUN_LOOK[status];
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 font-medium", LOOK_TEXT[look])} {...(label ? {} : { role: "img", "aria-label": RUN_STATUS[status] })}>
      <Glyph look={look} size={size} />
      {label ? RUN_STATUS[status] : null}
    </span>
  );
}

/** A researcher's state as an icon and one word. */
export function ResearcherStateBadge({ state, label = true }: { readonly state: ResearcherState; readonly label?: boolean }) {
  const look = RESEARCHER_LOOK[state];
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", LOOK_TEXT[look])} {...(label ? {} : { role: "img", "aria-label": RESEARCHER_STATE[state] })}>
      <Glyph look={look} size={14} />
      {label ? RESEARCHER_STATE[state] : null}
    </span>
  );
}
