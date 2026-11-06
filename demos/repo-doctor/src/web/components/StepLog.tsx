import { AlertIcon, CopilotIcon, EyeIcon, PencilIcon, ShieldXIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useRef } from "react";
import { STEP_ACTORS, STEP_LABELS, type LogLine, type StepView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { between, duration } from "../lib/format.js";
import { StepStatusIcon } from "./Status.js";
import { Words } from "./Words.js";

function Line({ line }: { readonly line: LogLine }) {
  switch (line.kind) {
    case "command":
      return (
        <div className="mt-2 font-semibold whitespace-pre-wrap break-words text-fg first:mt-0">
          <span className="text-fg-muted select-none">$ </span>
          {line.text}
        </div>
      );
    case "output":
      return <div className="whitespace-pre-wrap break-words text-fg-muted">{line.text}</div>;
    case "message":
      return (
        <div className="mt-2 flex gap-2 font-sans text-sm text-fg first:mt-0">
          <CopilotIcon size={16} className="mt-0.5 shrink-0 text-fg-muted" />
          <span className="min-w-0 whitespace-pre-wrap break-words">
            <Words text={line.text} />
          </span>
        </div>
      );
    case "edit":
    case "read": {
      const Icon = line.kind === "edit" ? PencilIcon : EyeIcon;
      return (
        <div className={cx("flex items-center gap-2", line.kind === "edit" ? "text-fg" : "text-fg-muted")}>
          <Icon size={12} className="shrink-0" />
          <span className="min-w-0 truncate" title={line.text}>
            {line.text}
          </span>
        </div>
      );
    }
    case "blocked":
      return (
        <div className="flex items-center gap-2 text-fg-danger">
          <ShieldXIcon size={12} className="shrink-0" />
          <span className="min-w-0 break-words">Blocked {line.text}</span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-2 text-fg-danger">
          <AlertIcon size={12} className="shrink-0" />
          <span className="min-w-0 break-words">{line.text}</span>
        </div>
      );
    case "note":
      if (line.exitCode !== undefined) return <div className={line.exitCode === 0 ? "text-fg-success" : "text-fg-danger"}>{line.text}</div>;
      return <div className="text-fg-muted italic">› {line.text}</div>;
  }
}

/** One step's log, as the sandbox saw it: commands and their output, Copilot's edits and words, and network blocks. */
export function StepLog({ step, lines, now, onClose }: { readonly step: StepView; readonly lines: readonly LogLine[] | undefined; readonly now: number; readonly onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const count = lines?.length ?? 0;

  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [count, step.id]);

  const elapsed = between(step.startedAt, step.finishedAt, now);
  const empty =
    lines === undefined ? "Loading the log…" : step.status === "pending" ? "Waiting for the steps before it." : step.status === "skipped" ? "Skipped: nothing to do." : "Nothing yet.";
  return (
    <section aria-label={`${STEP_LABELS[step.id]} log`} className="overflow-hidden rounded-md border border-line animate-fade-in">
      <div className="flex items-center gap-2 border-b border-line bg-canvas-muted px-3 py-2 text-sm">
        <StepStatusIcon status={step.status} />
        <span className="font-semibold">{STEP_LABELS[step.id]}</span>
        <span className="truncate text-xs text-fg-muted">
          {STEP_ACTORS[step.id] === "copilot" ? "Copilot" : "Repo Doctor"}
          {elapsed !== undefined ? ` · ${duration(elapsed)}` : ""}
        </span>
        <button type="button" className="btn-octicon ml-auto" aria-label="Close the log" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="rd-log max-h-80 overflow-y-auto px-3 py-2"
      >
        {count ? lines!.map((line) => <Line key={line.seq} line={line} />) : <div className="text-fg-muted">{empty}</div>}
      </div>
    </section>
  );
}
