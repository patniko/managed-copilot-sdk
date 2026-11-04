import {
  ArrowDownIcon,
  ArrowLeftIcon,
  CheckCircleFillIcon,
  CircleIcon,
  ClockIcon,
  CopilotIcon,
  KebabHorizontalIcon,
  PaperAirplaneIcon,
  ShieldIcon,
  TrashIcon,
} from "@primer/octicons-react";
import { useEffect, useState } from "react";
import type { IncidentStatus, IncidentView } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { between, clock, cx, duration } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { boardHref, navigate } from "../lib/router.js";
import { loadIncident, useStore } from "../lib/store.js";
import { Approval } from "./Approval.js";
import { Findings, Postmortem } from "./Report.js";
import { ResponseMap } from "./ResponseMap.js";
import { Timeline } from "./Timeline.js";
import { Popover, SeverityBadge, Spinner, STATUS_LABEL, STATUS_TEXT, Tooltip } from "./ui.js";

const STEPS: readonly IncidentStatus[] = ["investigating", "mitigating", "resolved"];

/** Investigating → Mitigating → Resolved, with the time each began. */
function Stepper({ incident }: { readonly incident: IncidentView }) {
  const reached = STEPS.indexOf(incident.status);
  const began: Record<IncidentStatus, string | undefined> = {
    investigating: incident.createdAt,
    mitigating: incident.milestones.mitigatingAt,
    resolved: incident.milestones.resolvedAt,
  };
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1" aria-label="Status">
      {STEPS.map((step, index) => {
        const done = index < reached || incident.status === "resolved";
        const current = index === reached && incident.status !== "resolved";
        const at = began[step];
        return (
          <li key={step} className="flex items-center gap-2" {...(current ? { "aria-current": "step" as const } : {})}>
            {index > 0 ? <span aria-hidden className={cx("h-0.5 w-3 rounded-full sm:w-8", index <= reached ? "bg-neutral-emphasis" : "bg-neutral-muted")} /> : null}
            <span className={cx("inline-flex items-center gap-1.5 text-sm", current ? cx("font-semibold", STATUS_TEXT[step]) : done ? "text-fg" : "text-fg-muted")}>
              {done ? (
                <CheckCircleFillIcon size={16} className="text-fg-success" />
              ) : current ? (
                <span className="relative grid size-4 place-items-center">
                  <span className="absolute size-4 animate-ping rounded-full bg-current opacity-30" />
                  <span className="size-2.5 rounded-full bg-current" />
                </span>
              ) : (
                <CircleIcon size={16} />
              )}
              {STATUS_LABEL[step]}
              {at && (done || current) ? <span className="font-mono text-xs font-normal text-fg-muted max-sm:hidden">{clock(at).slice(0, 5)}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function MoreMenu({ incident }: { readonly incident: IncidentView }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.remove(incident.id);
      navigate(boardHref());
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  return (
    <Popover
      label="More actions"
      width="w-72"
      trigger={(open, toggle) => (
        <Tooltip content="More actions">
          <button type="button" className="btn btn-sm btn-invisible px-2" aria-label="More actions" aria-expanded={open} onClick={toggle}>
            <KebabHorizontalIcon size={16} />
          </button>
        </Tooltip>
      )}
    >
      {confirming ? (
        <div className="flex flex-col gap-3 p-3 text-sm">
          <p>Delete {incident.id}? Its Copilot session and every sandbox it started go with it.</p>
          {error ? <div className="flash flash-error flash-sm">{error}</div> : null}
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove()}>
              {busy ? <Spinner size={14} /> : null}
              Delete
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <ul className="ActionList p-2">
          <li>
            <button type="button" className="ActionList-item ActionList-item--danger flex w-full items-center gap-2" onClick={() => setConfirming(true)}>
              <TrashIcon size={16} />
              <span className="ActionList-item-label">Delete incident</span>
            </button>
          </li>
        </ul>
      )}
    </Popover>
  );
}

function Heading({ incident }: { readonly incident: IncidentView }) {
  const now = useNow();
  const resolved = incident.status === "resolved" && incident.resolvedAt;
  return (
    <div className="flex flex-col gap-3">
      <a href={boardHref()} className="Link--muted inline-flex w-fit items-center gap-1 text-sm">
        <ArrowLeftIcon size={16} />
        Incidents
      </a>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <SeverityBadge severity={incident.severity} />
            <span className="font-mono">{incident.id}</span>
            <span aria-hidden>·</span>
            <span>
              {incident.service}
              {incident.demo ? " · demo service" : ""}
            </span>
          </div>
          <h1 className="mt-2 text-xl font-semibold text-balance sm:text-2xl">{incident.title}</h1>
        </div>
        <MoreMenu incident={incident} />
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Stepper incident={incident} />
        <span className="inline-flex items-center gap-1.5 font-mono text-sm text-fg-muted tabular-nums sm:ml-auto">
          <ClockIcon size={16} />
          {resolved ? `Resolved in ${duration(between(incident.createdAt, resolved))}` : `Open ${duration(between(incident.createdAt, now))}`}
        </span>
      </div>
    </div>
  );
}

/** Copilot ended its turn before the incident was resolved: what it said, and a way to keep it going. */
function Stopped({ incident }: { readonly incident: IncidentView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section aria-label="Copilot stopped" className="Box flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
      <CopilotIcon size={20} className="mt-0.5 shrink-0 text-fg-done" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Copilot stopped</div>
        {incident.coordinator.lastMessage ? <p className="mt-1 line-clamp-3 text-sm text-fg-muted">{incident.coordinator.lastMessage}</p> : null}
        {error ? <div className="flash flash-error flash-sm mt-2">{error}</div> : null}
      </div>
      <button
        type="button"
        className="btn btn-sm shrink-0"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void api.note(incident.id, { text: "Continue the runbook from where you stopped." }).then(
            () => setBusy(false),
            (failure: unknown) => {
              setError(errorMessage(failure));
              setBusy(false);
            },
          );
        }}
      >
        {busy ? <Spinner size={14} /> : null}
        Continue
      </button>
    </section>
  );
}

function NoteComposer({ incident }: { readonly incident: IncidentView }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const waiting = incident.approval?.state === "waiting";
  const unavailable = incident.coordinator.state === "failed" || !incident.coordinator.sessionId;
  const send = async () => {
    const note = text.trim();
    if (!note) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.note(incident.id, { text: note });
      setText("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="flex gap-2">
        <input
          className="form-control min-w-0 flex-1"
          placeholder={waiting ? "Answer the deploy request first" : "Tell Copilot something"}
          aria-label="A note for Copilot"
          value={text}
          maxLength={2_000}
          disabled={waiting || unavailable || busy}
          onChange={(event) => setText(event.target.value)}
        />
        <Tooltip content="Send to Copilot">
          <button type="submit" className="btn px-3" aria-label="Send to Copilot" disabled={waiting || unavailable || busy || !text.trim()}>
            {busy ? <Spinner size={16} /> : <PaperAirplaneIcon size={16} />}
          </button>
        </Tooltip>
      </div>
      {error ? <div className="flash flash-error flash-sm">{error}</div> : null}
    </form>
  );
}

export function IncidentPage({ id }: { readonly id: string }) {
  const incident = useStore((state) => state.views[id]);
  const error = useStore((state) => state.viewErrors[id]);
  useEffect(() => {
    void loadIncident(id);
  }, [id]);

  if (!incident) {
    return (
      <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-6 sm:px-6">
        <a href={boardHref()} className="Link--muted inline-flex w-fit items-center gap-1 text-sm">
          <ArrowLeftIcon size={16} />
          Incidents
        </a>
        {error ? (
          <div className="flash flash-error">{error}</div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-16 text-fg-muted">
            <Spinner size={16} /> Loading {id}…
          </div>
        )}
      </main>
    );
  }

  const stopped = incident.coordinator.state === "idle" && incident.status !== "resolved" && incident.approval?.state !== "waiting";
  const waiting = incident.approval?.state === "waiting";

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-6">
      <Heading incident={incident} />
      {incident.problem ? <div className="flash flash-warn">{incident.problem}</div> : null}
      {waiting ? (
        <button
          type="button"
          className="flash flash-warn flex items-center gap-2 text-left font-semibold lg:hidden"
          onClick={() => document.getElementById("approval")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          <ShieldIcon size={16} className="text-fg-attention" />
          <span className="flex-1">The fix is ready to deploy</span>
          <ArrowDownIcon size={16} />
        </button>
      ) : null}
      <ResponseMap incident={incident} />
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <Approval incident={incident} />
          {stopped ? <Stopped incident={incident} /> : null}
          <Postmortem incident={incident} />
          <Findings incident={incident} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Timeline entries={incident.timeline} />
          {incident.status !== "resolved" ? <NoteComposer incident={incident} /> : null}
        </div>
      </div>
    </main>
  );
}
