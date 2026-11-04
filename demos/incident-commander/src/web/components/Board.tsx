import { BellIcon, CheckCircleFillIcon, ClockIcon, ContainerIcon, CopilotIcon, RocketIcon, ShieldIcon, ZapIcon, type Icon } from "@primer/octicons-react";
import { Fragment, useState } from "react";
import type { IncidentStatus, IncidentSummary } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { ago, between, cx, duration } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { incidentHref, navigate } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { SeverityBadge, Spinner, STATUS_LABEL, STATUS_TEXT, Tooltip } from "./ui.js";

const ORDER: readonly IncidentStatus[] = ["investigating", "mitigating", "resolved"];

/** What happens when an alert fires, at a glance. */
const LOOP: readonly { readonly icon: Icon; readonly label: string; readonly detail: string; readonly tone: string }[] = [
  { icon: BellIcon, label: "Alert fires", detail: "From Alertmanager, Grafana, or any JSON webhook", tone: "bg-danger-muted text-fg-danger" },
  { icon: CopilotIcon, label: "Copilot triages", detail: "On the shared runtime, searching logs in its own sandbox", tone: "bg-done-muted text-fg-done" },
  { icon: ContainerIcon, label: "Workers fix", detail: "A repro and a fix, each in its own sandbox", tone: "bg-accent-muted text-fg-accent" },
  { icon: ShieldIcon, label: "You approve", detail: "The request waits on the platform, even with this tab closed", tone: "bg-attention-muted text-fg-attention" },
  { icon: RocketIcon, label: "It ships", detail: "Then Copilot writes the postmortem", tone: "bg-success-muted text-fg-success" },
];

function Loop() {
  return (
    <ol className="mx-auto mb-6 flex max-w-xl items-start justify-center" aria-label="How an incident runs">
      {LOOP.map((step, index) => {
        const Glyph = step.icon;
        return (
          <Fragment key={step.label}>
            {index > 0 ? <li aria-hidden className="mt-5 h-0.5 min-w-2 flex-1 bg-neutral-muted" /> : null}
            <li className="flex w-14 shrink-0 flex-col items-center gap-1.5 sm:w-20">
              <Tooltip content={step.detail}>
                <span className={cx("grid size-10 place-items-center rounded-full", step.tone)}>
                  <Glyph size={20} />
                </span>
              </Tooltip>
              <span className="text-center text-xs leading-4 text-fg-muted">{step.label}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** ●●○ and the status word. */
function StatusTrack({ status }: { readonly status: IncidentStatus }) {
  const reached = ORDER.indexOf(status);
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-medium", STATUS_TEXT[status])}>
      <span className="inline-flex items-center gap-0.5" aria-hidden>
        {ORDER.map((step, index) => (
          <span key={step} className={cx("size-2 rounded-full", index <= reached ? "bg-current" : "bg-neutral-muted")} />
        ))}
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}

function SimulateButton({ onError }: { readonly onError: (message: string | undefined) => void }) {
  const [busy, setBusy] = useState(false);
  const simulate = async () => {
    setBusy(true);
    onError(undefined);
    try {
      const { id } = await api.simulate();
      navigate(incidentHref(id));
    } catch (error) {
      onError(errorMessage(error));
      setBusy(false);
    }
  };
  return (
    <Tooltip content="Demo: sends a sample Alertmanager alert for the bundled checkout service">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void simulate()}>
        {busy ? <Spinner size={16} /> : <ZapIcon size={16} />}
        Simulate an incident
      </button>
    </Tooltip>
  );
}

function ActiveCard({ incident, now }: { readonly incident: IncidentSummary; readonly now: number }) {
  return (
    <a
      href={incidentHref(incident.id)}
      className={cx(
        "Box block p-4 no-underline transition-colors hover:bg-canvas-muted focus-visible:outline-2 sm:p-5",
        incident.needsYou && "needs-you",
      )}
    >
      <div className="flex items-center gap-3">
        <SeverityBadge severity={incident.severity} />
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-fg" title={incident.title}>
          {incident.title}
        </span>
        {incident.needsYou ? (
          <span className="Label Label--attention shrink-0 gap-1">
            <ShieldIcon size={12} />
            Needs you
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
        <span className="font-mono text-xs">{incident.id}</span>
        <span>
          {incident.service}
          {incident.demo ? <span className="text-fg-muted"> · demo</span> : null}
        </span>
        <StatusTrack status={incident.status} />
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-xs tabular-nums">
          <ClockIcon size={12} />
          {duration(between(incident.createdAt, now))}
        </span>
      </div>
    </a>
  );
}

function ResolvedRow({ incident, now }: { readonly incident: IncidentSummary; readonly now: number }) {
  return (
    <li className="Box-row Box-row--hover-gray flex items-center gap-3 px-4 py-3">
      <CheckCircleFillIcon size={16} className="shrink-0 text-fg-success" />
      <span className="shrink-0 font-mono text-xs text-fg-muted">{incident.id}</span>
      <a href={incidentHref(incident.id)} className="Link--primary min-w-0 flex-1 truncate font-semibold" title={incident.title}>
        {incident.title}
      </a>
      <span className="shrink-0 text-sm text-fg-muted max-md:hidden">{incident.service}</span>
      {incident.resolvedAt ? (
        <Tooltip content="Time to resolve">
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-fg-muted tabular-nums">
            <ClockIcon size={12} />
            {duration(between(incident.createdAt, incident.resolvedAt))}
          </span>
        </Tooltip>
      ) : null}
      <span className="w-16 shrink-0 text-right text-xs text-fg-muted max-sm:hidden">{ago(incident.resolvedAt ?? incident.updatedAt, now)}</span>
    </li>
  );
}

export function Board() {
  const incidents = useStore((state) => state.incidents);
  const platform = useStore((state) => state.platform);
  const phase = useStore((state) => state.phase);
  const loadError = useStore((state) => state.loadError);
  const [error, setError] = useState<string>();
  const now = useNow();
  const active = incidents.filter((incident) => incident.status !== "resolved");
  const resolved = incidents.filter((incident) => incident.status === "resolved");
  const quiet = active.length === 0;

  return (
    <main className="mx-auto flex w-full max-w-[1012px] flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Incidents</h1>
          <p className="text-fg-muted">Alerts open incidents. Copilot fixes them and asks before it deploys.</p>
        </div>
        {!quiet ? <SimulateButton onError={setError} /> : null}
      </div>

      {phase === "error" ? <div className="flash flash-error">{loadError ?? "Incident Commander isn't reachable."}</div> : null}
      {platform?.state === "unavailable" && platform.message ? <div className="flash flash-warn">{platform.message}</div> : null}
      {error ? <div className="flash flash-error">{error}</div> : null}

      {phase === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-16 text-fg-muted">
          <Spinner size={16} /> Loading incidents…
        </div>
      ) : quiet ? (
        <div className="Box blankslate blankslate--spacious max-sm:px-2">
          <Loop />
          <h2 className="blankslate-heading">All quiet</h2>
          <p>No open incidents.</p>
          <div className="blankslate-action">
            <SimulateButton onError={setError} />
          </div>
        </div>
      ) : (
        <section aria-label="Open incidents" className="flex flex-col gap-3">
          {active.map((incident) => (
            <ActiveCard key={incident.id} incident={incident} now={now} />
          ))}
        </section>
      )}

      {resolved.length ? (
        <section aria-label="Resolved incidents">
          <h2 className="mb-2 text-sm font-semibold text-fg-muted">Resolved</h2>
          <ul className="Box">
            {resolved.map((incident) => (
              <ResolvedRow key={incident.id} incident={incident} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
