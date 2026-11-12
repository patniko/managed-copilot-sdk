import { BugIcon, CheckCircleFillIcon, CircleSlashIcon, ClockIcon, LinkExternalIcon, WorkflowIcon, XCircleFillIcon } from "@primer/octicons-react";
import { BUG_AREA_INFO, type IssueReport, type RoutedWorkOrder, type SoftwareIssue, type WorkOrderStatus } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { playerLabel, plural, WORK_ORDER_STATUS, workOrderActive, workOrderName } from "../lib/format.js";
import { customerHref, playerHref } from "../lib/router.js";
import { routeIssue, useStore } from "../lib/store.js";
import { CustomerAvatar, TONE_TEXT } from "./ui/Status.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

const AVATARS = 5;

/** How an issue lists a report: the customer's name, or "Mona · Downhill" for a player. */
const reporter = (report: IssueReport): string => (report.product ? playerLabel(report.name) : report.name);

/**
 * The software issues: problems customers hit on the store's website and players hit in the Downhill Shop (the same
 * checkout code), grouped by what they're about.
 */
export function Issues() {
  const issues = useStore((state) => state.issues);
  if (issues.length === 0) return null;
  return (
    <section aria-label="Software issues" className="Box mt-4 animate-fade-in">
      <div className="Box-header py-2">
        <BugIcon size={16} className="shrink-0 text-fg-done" />
        <h2 className="Box-title">Software issues</h2>
        <span className="Counter">{issues.length}</span>
        <span className="ml-auto min-w-0 truncate text-xs text-fg-muted max-md:hidden">Problems customers and players hit with the store's checkout code, reported by their agents</span>
      </div>
      <ul>
        {issues.map((issue) => (
          <IssueRow key={issue.area} issue={issue} />
        ))}
      </ul>
    </section>
  );
}

function IssueRow({ issue }: { readonly issue: SoftwareIssue }) {
  const names = issue.reports.map(reporter).join(", ");
  return (
    <li className="Box-row flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <div className="flex min-w-0 flex-1 basis-72 items-center gap-3">
        <span className="Label Label--done shrink-0">{BUG_AREA_INFO[issue.area].label}</span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={issue.title}>
            {issue.title}
          </div>
          <div className="truncate text-xs text-fg-muted" title={names}>
            {plural(issue.reports.length, "ticket")}
            {names ? ` · ${names}` : ""}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center -space-x-1 max-sm:hidden" aria-hidden>
        {issue.reports.slice(0, AVATARS).map((report) => (
          <ReporterAvatar key={report.ticketId ?? report.customerId} report={report} />
        ))}
        {issue.reports.length > AVATARS ? <span className="pl-2.5 text-xs text-fg-muted">+{issue.reports.length - AVATARS}</span> : null}
      </div>
      <IssueAction issue={issue} />
    </li>
  );
}

/** A reporting customer's or player's avatar, linking to their conversation. */
function ReporterAvatar({ report }: { readonly report: IssueReport }) {
  const customer = useStore((state) => (report.customerId ? state.customers.find((candidate) => candidate.id === report.customerId) : undefined));
  const player = useStore((state) => (report.ticketId ? state.players.find((candidate) => candidate.ticketId === report.ticketId) : undefined));
  const person = customer ?? player?.player;
  if (!person) return null;
  const href = report.ticketId ? playerHref(report.ticketId) : customerHref(report.customerId ?? "");
  return (
    <a href={href} tabIndex={-1} title={`${reporter(report)}: ${report.whatHappened}`} className="rounded-full ring-2 ring-canvas">
      <CustomerAvatar customer={person} />
    </a>
  );
}

/** **Send to Software Factory**, or once sent, the work order's status and a link to it. */
export function IssueAction({ issue }: { readonly issue: SoftwareIssue }) {
  const configured = useStore((state) => state.desk?.factory.configured ?? false);
  const sending = useStore((state) => Boolean(state.routing[issue.area]));
  if (issue.routed) return <WorkOrder routed={issue.routed} />;
  const label = (
    <>
      {sending ? <Spinner size={16} /> : <WorkflowIcon size={16} />}
      {sending ? "Sending…" : "Send to Software Factory"}
    </>
  );
  if (!configured) {
    return (
      <Tooltip
        className="shrink-0"
        content={
          <>
            Software Factory isn't connected. Start it with <code className="inline-code">aspire run</code>, or set <code className="inline-code">SOFTWARE_FACTORY_URL</code>.
          </>
        }
      >
        <button type="button" className="btn btn-sm btn-primary" aria-disabled="true">
          {label}
        </button>
      </Tooltip>
    );
  }
  return (
    <button type="button" className="btn btn-sm btn-primary" disabled={sending || issue.reports.length === 0} onClick={() => void routeIssue(issue.area)}>
      {label}
    </button>
  );
}

function WorkOrder({ routed }: { readonly routed: RoutedWorkOrder }) {
  const { label, tone } = WORK_ORDER_STATUS[routed.status];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <Tooltip content={routed.error ? `${routed.title}: ${routed.error}` : routed.title}>
        <span className={cx("inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap", TONE_TEXT[tone])}>
          <WorkOrderIcon status={routed.status} />
          {workOrderName(routed.number)} · {label}
        </span>
      </Tooltip>
      <a href={routed.url} target="_blank" rel="noreferrer" className="btn btn-sm">
        <LinkExternalIcon size={16} />
        Open in Software Factory
      </a>
    </span>
  );
}

function WorkOrderIcon({ status }: { readonly status: WorkOrderStatus }) {
  if (status === "queued") return <ClockIcon size={16} />;
  if (workOrderActive(status)) return <Spinner size={16} />;
  if (status === "completed") return <CheckCircleFillIcon size={16} />;
  if (status === "failed") return <XCircleFillIcon size={16} />;
  return <CircleSlashIcon size={16} />;
}
