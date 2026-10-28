import {
  BeakerIcon,
  CheckIcon,
  ChevronRightIcon,
  ContainerIcon,
  FileIcon,
  FileMediaIcon,
  GlobeIcon,
  ImageIcon,
  ShieldCheckIcon,
  StopIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import { useEffect, useId, useState } from "react";
import type { ApprovalItem, SandboxKind, SandboxOutputView, WorkerItem } from "../../../shared/protocol";
import { timeOf } from "../format";
import { formatElapsed, type CardState, type ReplyImage } from "../sandboxCards";
import { cx, Spinner } from "./ui";

export const SANDBOX_ICONS: Record<SandboxKind, Icon> = { python: BeakerIcon, web: GlobeIcon, general: ContainerIcon };

/** "Python sandbox" → "a Python sandbox". */
export function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fileName(path: string): string {
  return path.split("/").pop() || path;
}

/** The current time, ticking every second while `active` (for elapsed times of running work). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Detail({ parts }: { parts: readonly (string | undefined)[] }) {
  const shown = parts.filter(Boolean);
  return shown.length ? <div className="break-words text-xs text-fg-muted">{shown.join(" · ")}</div> : null;
}

function OutputChips({ outputs }: { outputs: readonly SandboxOutputView[] }) {
  if (outputs.length === 0) return null;
  const shown = outputs.slice(0, 6);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {shown.map((output) => {
        const OutputIcon = output.image ? FileMediaIcon : FileIcon;
        return (
          <a
            key={output.id}
            href={output.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-line-muted bg-canvas-muted px-1.5 py-0.5 font-mono text-xs text-fg hover:border-line"
            title={output.image ? `Open ${output.path}` : `Download ${output.path}`}
            data-testid="sandbox-output"
          >
            <OutputIcon size={12} className="shrink-0 text-fg-muted" />
            <span className="truncate">{fileName(output.path)}</span>
          </a>
        );
      })}
      {outputs.length > shown.length && <span className="text-xs text-fg-muted">and {outputs.length - shown.length} more</span>}
    </div>
  );
}

function Status({ item, state }: { item: WorkerItem; state: CardState }) {
  const published = state.outputs.length > 0 ? `published ${state.outputs.length === 1 ? fileName(state.outputs[0]!.path) : `${state.outputs.length} files`}` : undefined;
  switch (state.phase) {
    case "calling":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Spinner size={12} className="text-fg-attention" />
          {item.action === "start" ? "Starting…" : "Sending…"}
        </span>
      );
    case "starting":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Spinner size={12} className="text-fg-attention" />
          Starting its sandbox…
        </span>
      );
    case "working":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Spinner size={12} className="text-fg-attention" />
          {item.action === "start" ? "Working on the task…" : "Working on the follow-up…"}
        </span>
      );
    case "done":
      return (
        <span className="inline-flex items-center gap-1.5">
          <CheckIcon size={12} className="text-fg-success" />
          {published ? `Done · ${published}` : "Done"}
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-danger">
          <XIcon size={12} className="shrink-0" />
          <span className="break-words">{state.latest && state.worker?.error ? `Failed: ${state.worker.error}` : "Failed"}</span>
        </span>
      );
    case "stopped":
      return (
        <span className="inline-flex items-center gap-1.5">
          <StopIcon size={12} />
          Stopped · its sandbox is deleted
        </span>
      );
    default:
      return null;
  }
}

/**
 * A sandbox the assistant started ("Created a Python sandbox · meeting-stats", new) or sent a follow-up
 * ("Sent the follow-up to meeting-stats", reused): where it runs, how long it took, and what it published.
 */
export function SandboxCard({ item, state, approval, timeZone, highlight }: { item: WorkerItem; state: CardState; approval?: ApprovalItem; timeZone: string; highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  const textId = useId();
  const kind = state.environment?.kind ?? "general";
  const KindIcon = SANDBOX_ICONS[kind];
  const label = state.environment?.label ?? "sandbox";
  const start = item.action === "start";
  const running = state.phase === "starting" || state.phase === "working";
  const now = useNow(running);
  const ended = state.finishedAt ? Date.parse(state.finishedAt) : running ? now : undefined;
  const elapsed = ended !== undefined && state.phase !== "calling" ? formatElapsed(ended - Date.parse(state.startedAt)) : undefined;

  if (state.phase === "call-failed") {
    return (
      <div className="timeline-run" id={`sandbox-card-${item.id}`} data-testid="sandbox-card" data-action={item.action} data-worker={item.worker} data-phase="call-failed">
        <div className="TimelineItem TimelineItem--condensed animate-fade-in">
          <div className="TimelineItem-badge text-fg-danger">
            <KindIcon />
          </div>
          <div className="TimelineItem-body min-w-0">
            <div className="break-words text-fg-danger">{start ? `Couldn't start ${withArticle(label)} · ${item.worker}` : `Couldn't send the follow-up to ${item.worker}`}</div>
            {item.error && <div className="mt-0.5 break-words text-xs text-fg-danger">{item.error}</div>}
          </div>
        </div>
      </div>
    );
  }

  const title = start ? `${state.phase === "calling" ? "Creating" : "Created"} ${withArticle(label)} · ${item.worker}` : `${state.phase === "calling" ? "Sending" : "Sent"} the follow-up to ${item.worker}`;
  const environment = state.environment;
  return (
    <div
      className="ml-11 animate-slide-up"
      id={`sandbox-card-${item.id}`}
      data-testid="sandbox-card"
      data-action={item.action}
      data-worker={item.worker}
      data-phase={state.phase ?? "unknown"}
    >
      <div className={cx("Box flex items-start gap-3 p-3 transition-shadow duration-200", highlight && "ring-2 ring-line-accent")}>
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-muted text-fg-accent" aria-hidden>
          <KindIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words font-semibold">{title}</span>
            {start ? (
              <span className="Label Label--success" title="A new sandbox for this work">
                new
              </span>
            ) : (
              <span className="Label Label--accent" title="The same sandbox, which still has its data and files">
                reused
              </span>
            )}
            {elapsed && (
              <span className="ml-auto shrink-0 font-mono text-xs text-fg-muted tabular-nums" title={running ? "Time so far" : "Time it took"}>
                {elapsed}
              </span>
            )}
          </div>
          <Detail parts={[item.environment ?? state.worker?.environment, environment?.size, environment?.network]} />
          <div className="mt-1 text-xs text-fg-muted">
            <Status item={item} state={state} />
          </div>
          <OutputChips outputs={state.outputs} />
          {item.text && (
            <div className="mt-1.5">
              <button type="button" className="inline-flex items-center gap-1 rounded-md text-xs text-fg-muted hover:text-fg" aria-expanded={open} aria-controls={textId} onClick={() => setOpen((value) => !value)}>
                <ChevronRightIcon size={12} className={cx("transition-transform duration-150", open && "rotate-90")} />
                {start ? "Task" : "Follow-up"}
              </button>
              <div id={textId} hidden={!open} className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line-muted bg-canvas-muted p-2 text-xs">
                {item.text}
              </div>
            </div>
          )}
          {approval?.decidedAt && (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-fg-muted">
              <ShieldCheckIcon size={12} className="text-fg-success" />
              You approved it · <time dateTime={approval.decidedAt}>{timeOf(approval.decidedAt, timeZone)}</time>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SandboxImage({ output, worker }: { output: SandboxOutputView; worker: string }) {
  const [broken, setBroken] = useState(false);
  const name = fileName(output.path);
  return (
    <figure className="Box overflow-hidden" data-testid="sandbox-image">
      {broken ? (
        <div className="flex items-center gap-2 p-3 text-fg-muted">
          <ImageIcon />
          This image is no longer available.
        </div>
      ) : (
        <a href={output.url} target="_blank" rel="noreferrer" title="Open in a new tab" className="block bg-white p-3">
          <img src={output.url} alt={`${name}, from the ${worker} sandbox`} loading="lazy" onError={() => setBroken(true)} className="mx-auto block h-auto max-h-96 w-auto max-w-full" />
        </a>
      )}
      <figcaption className="Box-footer flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-fg-muted">
        <ImageIcon size={12} className="shrink-0" />
        <span className="truncate">
          {name} · from {worker}
        </span>
      </figcaption>
    </figure>
  );
}

/** The images sandboxes published, under the reply that answers with them (`replyImages` picks the reply). */
export function SandboxImages({ images }: { images: readonly ReplyImage[] }) {
  if (images.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-3">
      {images.map(({ output, worker }) => (
        <SandboxImage key={output.id} output={output} worker={worker} />
      ))}
    </div>
  );
}
