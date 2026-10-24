import { CalendarPlus, CalendarX, CalendarClock, Check, LoaderCircle, MapPin, MessageSquare, Send, ShieldCheck, Users, X } from "lucide-react";
import { useState } from "react";
import type { ApprovalItem, ApprovalPreview, ToolItem } from "../../../shared/protocol";
import { dayLabel, timeOf, timeRange } from "../format";

const LABELS: Record<string, { approve: string; deny: string; icon: typeof Send }> = {
  send_email: { approve: "Send email", deny: "Don't send", icon: Send },
  create_event: { approve: "Add to calendar", deny: "Don't add", icon: CalendarPlus },
  update_event: { approve: "Save changes", deny: "Keep as is", icon: CalendarClock },
  delete_event: { approve: "Cancel event", deny: "Keep event", icon: CalendarX },
};

function when(start: string | undefined, end: string | undefined, timeZone: string): string | undefined {
  if (!start) return undefined;
  if (Number.isNaN(Date.parse(start))) return start;
  if (!end || Number.isNaN(Date.parse(end))) return `${dayLabel(start, timeZone)} · ${timeOf(start, timeZone)}`;
  return `${dayLabel(start, timeZone)} · ${timeRange(start, end, timeZone)}`;
}

function EmailPreview({ preview }: { preview: Extract<ApprovalPreview, { type: "email" }> }) {
  return (
    <div className="text-sm">
      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <dt className="text-zinc-500">To</dt>
        <dd className="break-words font-medium text-zinc-900 dark:text-zinc-100">{preview.to.join(", ")}</dd>
        {preview.cc.length > 0 && (
          <>
            <dt className="text-zinc-500">Cc</dt>
            <dd className="break-words text-zinc-800 dark:text-zinc-200">{preview.cc.join(", ")}</dd>
          </>
        )}
        <dt className="text-zinc-500">Subject</dt>
        <dd className="break-words font-medium text-zinc-900 dark:text-zinc-100">{preview.subject}</dd>
      </dl>
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 leading-relaxed text-zinc-800 scrollbar-thin dark:text-zinc-200">{preview.body}</div>
    </div>
  );
}

function EventPreview({ preview }: { preview: Extract<ApprovalPreview, { type: "event" }> }) {
  const { timeZone, current } = preview;
  const proposed = when(preview.start, preview.end, timeZone);
  const existing = current ? when(current.start, current.end, timeZone) : undefined;
  const title = preview.title ?? current?.title;
  const removing = preview.action === "delete";
  return (
    <div className="space-y-2.5 px-4 py-3 text-sm">
      {title && <div className={`text-base font-semibold text-zinc-900 dark:text-zinc-50 ${removing ? "line-through decoration-red-400" : ""}`}>{title}</div>}
      {preview.action === "update" && current && preview.title && preview.title !== current.title && (
        <div className="text-xs text-zinc-500">Renamed from “{current.title}”</div>
      )}
      {(proposed || existing) && (
        <div className="flex items-start gap-2 text-zinc-700 dark:text-zinc-300">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-zinc-400" aria-hidden />
          <div>
            {preview.action === "update" && existing && proposed ? (
              <>
                <div className="text-zinc-400 line-through">{existing}</div>
                <div className="font-medium text-zinc-900 dark:text-zinc-100">{proposed}</div>
              </>
            ) : (
              <div className={removing ? "line-through decoration-red-400" : "font-medium text-zinc-900 dark:text-zinc-100"}>{proposed ?? existing}</div>
            )}
            <div className="text-xs text-zinc-400">{timeZone.replace(/_/g, " ")}</div>
          </div>
        </div>
      )}
      {preview.attendees && preview.attendees.length > 0 && (
        <div className="flex items-start gap-2 text-zinc-700 dark:text-zinc-300">
          <Users className="mt-0.5 size-4 shrink-0 text-zinc-400" aria-hidden />
          <div className="flex flex-wrap gap-1">
            {preview.attendees.map((attendee) => (
              <span key={attendee} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                {attendee}
              </span>
            ))}
          </div>
        </div>
      )}
      {preview.location && (
        <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <MapPin className="size-4 shrink-0 text-zinc-400" aria-hidden />
          {preview.location}
        </div>
      )}
      {preview.description && <p className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{preview.description}</p>}
      {removing && <p className="text-xs text-zinc-500">Guests will be notified that it's cancelled.</p>}
    </div>
  );
}

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
  const labels = LABELS[item.tool] ?? { approve: "Approve", deny: "Deny", icon: ShieldCheck };
  const Icon = labels.icon;
  const pending = item.status === "pending";

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      await onDecide(decision, decision === "deny" && note.trim() ? note.trim() : undefined);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="ml-11 animate-rise">
      <div
        className={`overflow-hidden rounded-2xl bg-white ring-1 dark:bg-zinc-900 ${
          pending ? "shadow-md shadow-violet-500/5 ring-violet-300 dark:ring-violet-500/40" : "ring-zinc-200 dark:ring-zinc-800"
        }`}
      >
        <div className={`flex items-center gap-2.5 px-4 py-2.5 ${pending ? "bg-violet-50 dark:bg-violet-500/10" : "bg-zinc-50 dark:bg-zinc-800/40"}`}>
          <span className={`grid size-7 place-items-center rounded-lg ${pending ? "bg-violet-600 text-white" : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"}`}>
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">{item.title}</div>
          {pending && <span className="chip bg-violet-600/10 text-violet-700 dark:text-violet-300">Needs your OK</span>}
        </div>
        {item.preview.type === "email" && <EmailPreview preview={item.preview} />}
        {item.preview.type === "event" && <EventPreview preview={item.preview} />}
        {item.preview.type === "generic" && <pre className="overflow-x-auto px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">{item.preview.summary}</pre>}
        <div className="border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          {pending ? (
            <div className="space-y-2">
              {noteOpen && (
                <input
                  autoFocus
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Tell your assistant what to change (optional)"
                  className="w-full rounded-lg bg-zinc-50 px-3 py-1.5 text-sm ring-1 ring-zinc-200 outline-none placeholder:text-zinc-400 focus:ring-violet-400 dark:bg-zinc-800 dark:ring-zinc-700"
                  maxLength={500}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void decide("deny");
                  }}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-primary" disabled={!item.actionable || busy !== undefined} onClick={() => void decide("approve")}>
                  {busy === "approve" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
                  {labels.approve}
                </button>
                <button type="button" className="btn-secondary" disabled={!item.actionable || busy !== undefined} onClick={() => void decide("deny")}>
                  {busy === "deny" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <X className="size-4" aria-hidden />}
                  {labels.deny}
                </button>
                {!noteOpen && (
                  <button type="button" className="btn-ghost text-xs" disabled={!item.actionable} onClick={() => setNoteOpen(true)}>
                    <MessageSquare className="size-3.5" aria-hidden />
                    Add a note
                  </button>
                )}
                {!item.actionable && <span className="text-xs text-zinc-500">Reconnecting to your assistant…</span>}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {item.status === "approved" && (
                <span className="chip bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20">
                  <Check className="size-3" aria-hidden /> Approved
                </span>
              )}
              {item.status === "denied" && (
                <span className="chip bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
                  <X className="size-3" aria-hidden /> Declined
                </span>
              )}
              {item.status === "expired" && <span className="chip bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">No longer waiting</span>}
              {item.decidedAt && <span className="text-xs text-zinc-400">{timeOf(item.decidedAt, timeZone)}</span>}
              {item.status === "approved" && outcome && (
                <span className={`flex min-w-0 items-center gap-1.5 text-xs ${outcome.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-300"}`}>
                  <span aria-hidden>·</span>
                  {outcome.status === "running" && <LoaderCircle className="size-3.5 animate-spin text-violet-500" aria-hidden />}
                  {outcome.status === "succeeded" && <Check className="size-3.5 text-emerald-500" aria-hidden />}
                  {outcome.status === "failed" && <X className="size-3.5" aria-hidden />}
                  <span className="truncate">{outcome.status === "failed" ? (outcome.error ?? outcome.title) : outcome.title}</span>
                </span>
              )}
              {item.feedback && <span className="truncate text-xs text-zinc-500">“{item.feedback}”</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
