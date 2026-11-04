import { CheckIcon, ClockIcon, CloudOfflineIcon, CommentIcon, EyeClosedIcon, GlobeIcon, LocationIcon, PeopleIcon, ShieldCheckIcon, ShieldIcon, ShieldXIcon, XIcon } from "@primer/octicons-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalItem, ApprovalPreview, ToolItem } from "../../../shared/protocol";
import { dayLabel, timeOf, timeRange } from "../format";
import { networkLabel, SANDBOX_ICONS } from "./Sandbox";
import { cx, Spinner, Tooltip } from "./ui";

const LABELS: Record<string, { approve: string; deny: string }> = {
  send_email: { approve: "Send email", deny: "Don't send" },
  create_event: { approve: "Add to calendar", deny: "Don't add" },
  update_event: { approve: "Save changes", deny: "Keep as is" },
  delete_event: { approve: "Cancel event", deny: "Keep event" },
  start_worker: { approve: "Start sandbox", deny: "Don't start" },
};

function when(start: string | undefined, end: string | undefined, timeZone: string): string | undefined {
  if (!start) return undefined;
  if (Number.isNaN(Date.parse(start))) return start;
  if (!end || Number.isNaN(Date.parse(end))) return `${dayLabel(start, timeZone)} · ${timeOf(start, timeZone)}`;
  return `${dayLabel(start, timeZone)} · ${timeRange(start, end, timeZone)}`;
}

/** The times an update will actually set, worked out like update_event does: a new start keeps the duration. */
function proposedTimes(preview: Extract<ApprovalPreview, { type: "event" }>): { start?: string; end?: string } {
  const { current } = preview;
  if (preview.action !== "update" || (!preview.start && !preview.end)) return { start: preview.start, end: preview.end };
  const start = preview.start ?? current?.start;
  let end = preview.end;
  if (!end && preview.start && current) {
    const duration = Date.parse(current.end) - Date.parse(current.start);
    const startMs = Date.parse(preview.start);
    if (!Number.isNaN(duration) && !Number.isNaN(startMs)) end = new Date(startMs + duration).toISOString();
  }
  return { start, end };
}

/** The muted well that holds exactly what the person is approving. */
function Well({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-md border border-line-muted bg-canvas-muted p-3", className)}>{children}</div>;
}

function EmailPreview({ preview }: { preview: Extract<ApprovalPreview, { type: "email" }> }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-fg-muted">To</dt>
        <dd className="break-words font-semibold">{preview.to.join(", ")}</dd>
        {preview.cc.length > 0 && (
          <>
            <dt className="text-fg-muted">Cc</dt>
            <dd className="break-words">{preview.cc.join(", ")}</dd>
          </>
        )}
        <dt className="text-fg-muted">Subject</dt>
        <dd className="break-words font-semibold">{preview.subject}</dd>
      </dl>
      <Well className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words">{preview.body}</Well>
    </div>
  );
}

function EventPreview({ preview, pending }: { preview: Extract<ApprovalPreview, { type: "event" }>; pending: boolean }) {
  const { timeZone, current } = preview;
  const times = proposedTimes(preview);
  const proposed = when(times.start, times.end, timeZone);
  const existing = current ? when(current.start, current.end, timeZone) : undefined;
  const title = preview.title ?? current?.title;
  const removing = preview.action === "delete";
  const removingGuests = preview.action === "update" && preview.attendees !== undefined && preview.attendees.length === 0;
  return (
    <Well className="space-y-2">
      {title && <div className={cx("text-base font-semibold", removing && "text-fg-muted line-through")}>{title}</div>}
      {pending && !current && preview.action !== "create" && (
        <p className="text-xs text-fg-muted">The event's current details couldn't be loaded. Check your calendar if you're not sure which event this is.</p>
      )}
      {preview.action === "update" && current && preview.title && preview.title !== current.title && <div className="text-xs text-fg-muted">Renamed from “{current.title}”</div>}
      {(proposed || existing) && (
        <div className="flex items-start gap-2">
          <ClockIcon className="mt-0.5 text-fg-muted" />
          <div>
            {preview.action === "update" && existing && proposed ? (
              <>
                <div className="text-fg-muted line-through">{existing}</div>
                <div className="font-semibold">{proposed}</div>
              </>
            ) : (
              <div className={removing ? "text-fg-muted line-through" : "font-semibold"}>{proposed ?? existing}</div>
            )}
            <div className="text-xs text-fg-muted">{timeZone.replace(/_/g, " ")}</div>
          </div>
        </div>
      )}
      {preview.attendees && preview.attendees.length > 0 && (
        <div className="flex items-start gap-2">
          <PeopleIcon className="mt-0.5 text-fg-muted" />
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {preview.action === "update" && <span className="mr-1 text-xs text-fg-muted">New guest list:</span>}
            {preview.attendees.map((attendee) => (
              <span key={attendee} className="Label max-w-full truncate">
                {attendee}
              </span>
            ))}
          </div>
        </div>
      )}
      {removingGuests && (
        <div className="flex items-center gap-2 font-semibold">
          <PeopleIcon className="text-fg-muted" />
          Remove all guests
        </div>
      )}
      {preview.location && (
        <div className="flex items-center gap-2">
          <LocationIcon className="text-fg-muted" />
          <span className="min-w-0 break-words">{preview.location}</span>
        </div>
      )}
      {preview.description && <p className="whitespace-pre-wrap break-words text-fg-muted">{preview.description}</p>}
      {removing && <p className="text-xs text-fg-muted">Guests will be notified that it's cancelled.</p>}
    </Well>
  );
}

const RESOLVED = {
  approved: { label: "Approved", className: "Label--success", icon: CheckIcon },
  denied: { label: "Declined", className: "Label--secondary", icon: XIcon },
  expired: { label: "No longer waiting", className: "Label--secondary", icon: ClockIcon },
} as const;

/** The exact task a sandbox would get: three lines at rest, all of it one click away. */
function TaskWell({ task }: { task: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, task]);
  return (
    <Well>
      <div ref={text} id={id} className={cx("whitespace-pre-wrap break-words", expanded ? "max-h-72 overflow-y-auto" : "line-clamp-3")}>
        <span className="text-fg-muted">Task: </span>
        {task || "(no task given)"}
      </div>
      {(overflows || expanded) && (
        <button type="button" className="Link mt-1 text-xs font-semibold" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show full task"}
        </button>
      )}
    </Well>
  );
}

/** Starting a sandbox: which one, the exact task it gets, and what it can reach. */
function SandboxPreview({ preview }: { preview: Extract<ApprovalPreview, { type: "sandbox" }> }) {
  const KindIcon = SANDBOX_ICONS[preview.kind];
  const NetworkIcon = preview.network === "network off" ? CloudOfflineIcon : GlobeIcon;
  const runsAs = [preview.agent ? `Agent ${preview.agent}` : undefined, preview.model ? `Model ${preview.model}` : undefined].filter(Boolean).join(" · ");
  return (
    <div className="space-y-2" data-testid="sandbox-approval">
      <div className="flex min-w-0 items-center gap-2">
        <KindIcon className="shrink-0 text-fg-muted" />
        <Tooltip content={runsAs || undefined} describe={false}>
          <div className="min-w-0 truncate">
            <span className="font-semibold">{preview.worker}</span>
            {[preview.environment, preview.size].filter(Boolean).map((part) => (
              <span key={part} className="text-fg-muted">
                {" · "}
                {part}
              </span>
            ))}
          </div>
        </Tooltip>
      </div>
      <TaskWell task={preview.task} />
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {preview.network && (
          <li className="inline-flex items-center gap-1.5">
            <NetworkIcon size={12} className="shrink-0" />
            {networkLabel(preview.network)}
          </li>
        )}
        <li className="inline-flex items-center gap-1.5">
          <EyeClosedIcon size={12} className="shrink-0" />
          Can't see your mail or calendar
        </li>
      </ul>
    </div>
  );
}

/**
 * "Allow this action?": a consequential tool call (sending mail, changing the calendar) waits here for the person,
 * like a pull request's merge box. Resolved cards keep the decision and the call's outcome.
 */
export function ApprovalCard({
  item,
  outcome,
  timeZone,
  onDecide,
}: {
  item: ApprovalItem;
  /** The approved tool call's progress, shown in the footer once the person decides. */
  outcome?: ToolItem;
  timeZone: string;
  onDecide(decision: "approve" | "deny", feedback?: string): Promise<unknown>;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | undefined>();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const labels = LABELS[item.tool] ?? { approve: "Approve", deny: "Deny" };
  const pending = item.status === "pending";
  const HeaderIcon = item.status === "approved" ? ShieldCheckIcon : item.status === "denied" ? ShieldXIcon : ShieldIcon;

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      await onDecide(decision, decision === "deny" && note.trim() ? note.trim() : undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const resolved = item.status === "pending" ? undefined : RESOLVED[item.status];
  return (
    <div className="ml-11 animate-slide-up" data-testid="approval" data-status={item.status} data-actionable={item.actionable ? "true" : "false"} data-tool={item.tool}>
      <div className={cx("Box", pending && "Box--attention")}>
        <div className="Box-header flex-wrap px-3 py-2">
          <HeaderIcon className={pending ? "text-fg-attention" : item.status === "approved" ? "text-fg-success" : "text-fg-muted"} />
          <h3 className="Box-title min-w-0 flex-1 break-words">{item.title}</h3>
          {pending && <span className="Label Label--attention">Needs your approval</span>}
        </div>
        <div className="Box-body p-3">
          {item.preview.type === "email" && <EmailPreview preview={item.preview} />}
          {item.preview.type === "event" && <EventPreview preview={item.preview} pending={pending} />}
          {item.preview.type === "sandbox" && <SandboxPreview preview={item.preview} />}
          {item.preview.type === "generic" && (
            <Well className="overflow-x-auto">
              <pre className="font-mono text-xs">{item.preview.summary}</pre>
            </Well>
          )}
        </div>
        <div className="Box-footer px-3 py-2">
          {pending ? (
            <div className="space-y-2">
              {noteOpen && (
                <input
                  autoFocus
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Tell your assistant what to change (optional)"
                  aria-label="Note for your assistant"
                  className="form-control input-block"
                  maxLength={500}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void decide("deny");
                  }}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Tooltip content={item.tool === "start_worker" ? "Lets it run code and save files in its sandbox until your assistant stops it" : undefined}>
                  <button type="button" className="btn btn-primary" disabled={!item.actionable || busy !== undefined} onClick={() => void decide("approve")}>
                    {busy === "approve" ? <Spinner /> : <CheckIcon />}
                    {labels.approve}
                  </button>
                </Tooltip>
                <button type="button" className="btn" disabled={!item.actionable || busy !== undefined} onClick={() => void decide("deny")}>
                  {busy === "deny" ? <Spinner /> : <XIcon />}
                  {labels.deny}
                </button>
                {!noteOpen && (
                  <button type="button" className="btn btn-sm btn-invisible" disabled={!item.actionable} onClick={() => setNoteOpen(true)}>
                    <CommentIcon />
                    Add a note
                  </button>
                )}
                {!item.actionable && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                    <Spinner size={12} />
                    Reconnecting to your assistant…
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {resolved && (
                <span className={cx("Label", resolved.className)}>
                  <resolved.icon />
                  {resolved.label}
                </span>
              )}
              {item.decidedAt && (
                <time className="text-xs text-fg-muted" dateTime={item.decidedAt}>
                  {timeOf(item.decidedAt, timeZone)}
                </time>
              )}
              {item.status === "approved" && outcome && (
                <span className={cx("flex min-w-0 items-center gap-1.5 text-xs", outcome.status === "failed" ? "text-fg-danger" : "text-fg-muted")}>
                  <span className="hidden sm:inline" aria-hidden>
                    ·
                  </span>
                  {outcome.status === "running" && <Spinner size={12} className="text-fg-attention" />}
                  {outcome.status === "succeeded" && <CheckIcon size={12} className="text-fg-success" />}
                  {outcome.status === "failed" && <XIcon size={12} />}
                  <span className="truncate">{outcome.status === "failed" ? (outcome.error ?? outcome.title) : outcome.title}</span>
                </span>
              )}
              {item.feedback && <span className="min-w-0 truncate text-xs text-fg-muted">“{item.feedback}”</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
