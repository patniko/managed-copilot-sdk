import { PauseIcon, PlayIcon, PulseIcon } from "@primer/octicons-react";
import { useState } from "react";
import type { TelemetryRecord, TelemetrySeverity } from "../../shared/types.js";
import { cx } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { useStore } from "../lib/store.js";

/** Rows shown, newest first. */
const SHOWN = 150;
/** "Live" while records arrived this recently, ms. */
const LIVE_MS = 5_000;

const SEVERITY: Readonly<Record<TelemetrySeverity, { readonly label: string; readonly tone: string; readonly row?: string }>> = {
  trace: { label: "TRACE", tone: "text-fg-muted" },
  debug: { label: "DEBUG", tone: "text-fg-muted" },
  info: { label: "INFO", tone: "text-fg-accent" },
  warn: { label: "WARN", tone: "text-fg-attention", row: "bg-attention-muted" },
  error: { label: "ERROR", tone: "text-fg-danger", row: "bg-danger-muted" },
  fatal: { label: "FATAL", tone: "font-semibold text-fg-danger", row: "bg-danger-muted" },
};

/** `14:02:11.234`, in this browser's time zone. */
function clockMs(iso: string): string {
  const date = new Date(iso);
  return `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/** The record's number: ids are `t<n>`, in arrival order. */
const sequence = (record: TelemetryRecord): number => Number(record.id.slice(1)) || 0;

function Row({ record, fresh, showService }: { readonly record: TelemetryRecord; readonly fresh: boolean; readonly showService: boolean }) {
  const [open, setOpen] = useState(false);
  const severity = SEVERITY[record.severity];
  const attributes = Object.entries(record.attributes);
  return (
    <li className={cx("border-b border-line-muted last:border-b-0", severity.row, fresh && "telemetry-fresh")}>
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left font-mono text-xs leading-5 hover:bg-canvas-muted focus-visible:outline-2"
        aria-expanded={attributes.length ? open : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <time className="shrink-0 text-fg-muted tabular-nums" dateTime={record.at}>
          {clockMs(record.at)}
        </time>
        <span className={cx("w-10 shrink-0", severity.tone)}>{severity.label}</span>
        <span className="min-w-0 flex-1 break-words">
          {showService ? <span className="text-fg-muted">{record.service} </span> : null}
          {record.event ? <span className="text-fg-done">{record.event} </span> : null}
          <span className="text-fg">{record.body}</span>
        </span>
      </button>
      {open && attributes.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-3 pb-2 pl-[7.5rem] font-mono text-[11px] leading-4 max-sm:pl-3">
          {attributes.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-fg-muted">{key}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
          {record.traceId ? (
            <div className="contents">
              <dt className="text-fg-muted">trace_id</dt>
              <dd className="break-all">{record.traceId}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

/**
 * Services' OpenTelemetry logs as they arrive, newest first: every service's, or one service's (`service`). Pause holds
 * the list still to read it; new records keep arriving behind it.
 */
export function LiveTelemetry({ service, className, listClassName = "max-h-96" }: { readonly service?: string; readonly className?: string; readonly listClassName?: string }) {
  const all = useStore((state) => state.telemetry);
  const baseline = useStore((state) => state.telemetryBaseline);
  const arrivedAt = useStore((state) => state.telemetryAt);
  const integrations = useStore((state) => state.integrations);
  const now = useNow(1_000);
  const [paused, setPaused] = useState<readonly TelemetryRecord[]>();
  const mine = (records: readonly TelemetryRecord[]) => (service ? records.filter((record) => record.service === service) : records);
  const shown = mine(paused ?? all)
    .slice(-SHOWN)
    .reverse();
  const pausedAfter = paused?.length ? sequence(paused[paused.length - 1]!) : 0;
  const waiting = paused ? mine(all).filter((record) => sequence(record) > pausedAfter).length : 0;
  const live = !paused && arrivedAt !== undefined && now - arrivedAt < LIVE_MS;

  return (
    <section aria-label={service ? `Live telemetry from ${service}` : "Live telemetry"} className={cx("Box flex min-w-0 flex-col", className)}>
      <div className="Box-header flex items-center gap-2 px-3 py-2">
        <PulseIcon size={16} className={live ? "animate-pulse text-fg-success" : "text-fg-muted"} />
        <h2 className="text-sm font-semibold">Live telemetry</h2>
        {live ? <span className="Label Label--success">Live</span> : null}
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{service ?? "OpenTelemetry logs from your services"}</span>
        <button type="button" className="btn btn-sm shrink-0" aria-pressed={paused !== undefined} onClick={() => setPaused((current) => (current ? undefined : all))}>
          {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
          {paused ? (waiting ? `Resume (${waiting} new)` : "Resume") : "Pause"}
        </button>
      </div>
      {shown.length ? (
        <ol className={cx("overflow-y-auto", listClassName)} aria-live={paused ? "off" : "polite"} aria-relevant="additions">
          {shown.map((record) => (
            <Row key={record.id} record={record} fresh={sequence(record) > baseline} showService={!service} />
          ))}
        </ol>
      ) : (
        <div className="px-4 py-6 text-center text-sm text-fg-muted">
          {integrations && !integrations.alertsConfigured ? (
            <p>Telemetry is off. Set INCIDENT_ALERT_SECRET: services send it as a bearer token with their logs, as alerts do.</p>
          ) : (
            <>
              <p className="font-semibold text-fg">Waiting for {service ? `${service}'s logs` : "logs"}</p>
              <p className="mt-1">
                Services export OpenTelemetry logs (OTLP/HTTP, JSON) to{" "}
                <code className="font-mono text-xs">{integrations?.telemetryUrl ?? "/api/otlp/v1/logs"}</code> with the alert secret. Under{" "}
                <code className="font-mono text-xs">aspire run</code>, play Downhill: its rides, tricks, and checkouts stream here.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
