import { BugIcon, CheckIcon, NoteIcon } from "@primer/octicons-react";
import type { IncidentView } from "../../shared/types.js";
import { between, duration } from "../lib/format.js";

/** What triage found, until the postmortem says it better. */
export function Findings({ incident }: { readonly incident: IncidentView }) {
  const { findings } = incident;
  if (incident.postmortem || (!findings.rootCause && findings.evidence.length === 0)) return null;
  return (
    <section aria-label="Root cause" className="Box p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <BugIcon size={16} className="text-fg-danger" />
        Root cause
      </h2>
      {findings.rootCause ? <p className="mt-2 text-base">{findings.rootCause}</p> : null}
      {findings.evidence.length ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {findings.evidence.map((line) => (
            <li key={line} className="flex gap-2 font-mono text-xs text-fg-muted">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-neutral-emphasis" />
              <span className="min-w-0 break-words">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string | undefined }) {
  return (
    <div className="rounded-md bg-canvas-muted px-3 py-2">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="font-mono text-lg font-semibold tabular-nums">{value ?? "—"}</div>
    </div>
  );
}

export function Postmortem({ incident }: { readonly incident: IncidentView }) {
  const { postmortem, milestones, createdAt } = incident;
  if (!postmortem) return null;
  const since = (at: string | undefined) => (at ? duration(between(createdAt, at)) : undefined);
  return (
    <section aria-label="Postmortem" className="Box">
      <h2 className="flex items-center gap-2 border-b border-line-muted px-4 py-3 text-sm font-semibold">
        <NoteIcon size={16} className="text-fg-done" />
        Postmortem
      </h2>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Triaged in" value={since(milestones.triagedAt)} />
          <Stat label="Fixed in" value={since(incident.approval?.requestedAt)} />
          <Stat label="Resolved in" value={since(milestones.resolvedAt)} />
        </div>
        <p className="text-base">{postmortem.summary}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="font-semibold text-fg-muted">Impact</dt>
          <dd>{postmortem.impact}</dd>
          <dt className="font-semibold text-fg-muted">Root cause</dt>
          <dd>{postmortem.rootCause}</dd>
          <dt className="font-semibold text-fg-muted">Fix</dt>
          <dd>{postmortem.fix}</dd>
          {postmortem.followUps.length ? (
            <>
              <dt className="font-semibold text-fg-muted">Follow-ups</dt>
              <dd>
                <ul className="flex flex-col gap-1">
                  {postmortem.followUps.map((item) => (
                    <li key={item} className="flex gap-2">
                      <CheckIcon size={16} className="mt-0.5 shrink-0 text-fg-muted" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}
