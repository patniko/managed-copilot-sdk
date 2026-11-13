import { AlertIcon, CheckIcon, ZapIcon } from "@primer/octicons-react";
import type { KnownIssue, KnownIssueTicket } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { answerLine, answerProgress, playerLabel } from "../lib/format.js";
import { customerHref, playerHref } from "../lib/router.js";
import { answerKnownIssue, resolveKnownIssue, useStore } from "../lib/store.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The known issues: ongoing problems a team member recorded from an agent's proposal. Every new conversation is told
 * them, and **Answer matching tickets** has the decision model find the open tickets about one and sends each the update.
 */
export function KnownIssues() {
  const issues = useStore((state) => state.knownIssues);
  if (issues.length === 0) return null;
  return (
    <section aria-label="Known issues" className="Box mt-4 animate-fade-in">
      <div className="Box-header py-2">
        <AlertIcon size={16} className="shrink-0 text-fg-attention" />
        <h2 className="Box-title">Known issues</h2>
        <span className="Counter">{issues.length}</span>
        <span className="ml-auto min-w-0 truncate text-xs text-fg-muted max-md:hidden">Recorded from the agents' proposals; every new conversation is told them</span>
      </div>
      <ul>
        {issues.map((issue) => (
          <KnownIssueRow key={issue.id} issue={issue} />
        ))}
      </ul>
    </section>
  );
}

function KnownIssueRow({ issue }: { readonly issue: KnownIssue }) {
  const work = useStore((state) => state.issueWork[issue.id]);
  const answer = issue.answer;
  const running = answer !== undefined && answer.finishedAt === undefined;
  return (
    <li className="Box-row flex flex-wrap items-start gap-x-4 gap-y-2 py-2.5">
      <div className="min-w-0 flex-1 basis-80">
        <div className="text-sm">
          <span className="font-semibold">{issue.title}</span>
          <span className="text-fg-muted"> · </span>
          {issue.update}
        </div>
        <div className="truncate text-xs text-fg-muted" title={`Customers describe it as: ${issue.symptoms}`}>
          Recorded by {issue.recordedBy} · {DATE.format(new Date(issue.recordedAt))} · from {issue.source.name}'s conversation
        </div>
        {answer ? <AnswerLine issue={issue} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AnswerButton issue={issue} busy={work !== undefined || running} working={work === "answer" || running} />
        <button type="button" className="btn btn-sm" disabled={work !== undefined || running} onClick={() => void resolveKnownIssue(issue.id)} title="It's fixed: new conversations aren't told it anymore">
          {work === "resolve" ? <Spinner size={16} /> : <CheckIcon size={16} />}
          Resolve
        </button>
      </div>
    </li>
  );
}

/** **Answer matching tickets**: needs the decision model. */
function AnswerButton({ issue, busy, working }: { readonly issue: KnownIssue; readonly busy: boolean; readonly working: boolean }) {
  const triage = useStore((state) => state.desk?.triage);
  const connected = useStore((state) => state.platform?.state === "connected");
  const label = (
    <>
      {working ? <Spinner size={16} /> : <ZapIcon size={16} />}
      {working ? "Answering…" : "Answer matching tickets"}
    </>
  );
  const usable = triage?.state === "ready" || triage?.state === "unavailable";
  if (!usable) {
    return (
      <Tooltip
        className="shrink-0"
        content={triage?.state === "connecting" ? "The decision model's environment is connecting…" : "Needs the decision model, which isn't set up. Help Desk's README shows how to turn it on."}
      >
        <button type="button" className="btn btn-sm btn-primary" aria-disabled="true">
          {label}
        </button>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      disabled={busy || !connected}
      title="The decision model checks every open ticket against this issue, and each match's agent replies with its update"
      onClick={() => void answerKnownIssue(issue.id)}
    >
      {label}
    </button>
  );
}

/** How the latest answer went: classifying, matched, updates sent, and the tickets it reached. */
function AnswerLine({ issue }: { readonly issue: KnownIssue }) {
  const answer = issue.answer!;
  const progress = answerProgress(answer);
  const reached = answer.tickets.filter((ticket) => ticket.matched);
  const failure = answer.tickets.find((ticket) => ticket.state === "failed");
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" role="status">
      {progress.finished ? <ZapIcon size={14} className="shrink-0 text-fg-attention" /> : <Spinner size={12} />}
      <span className={cx("shrink-0 font-semibold", progress.failed > 0 && progress.finished ? "text-fg-attention" : "")}>{answerLine(answer)}</span>
      {reached.length > 0 ? (
        <span className="min-w-0 truncate text-fg-muted">
          {" · "}
          {reached.map((ticket, index) => (
            <span key={ticket.sessionId}>
              {index > 0 ? ", " : ""}
              <TicketLink ticket={ticket} />
            </span>
          ))}
        </span>
      ) : null}
      {failure?.message ? (
        <span className="min-w-0 basis-full truncate text-fg-danger" title={failure.message}>
          {failure.name}: {failure.message}
        </span>
      ) : null}
    </div>
  );
}

function TicketLink({ ticket }: { readonly ticket: KnownIssueTicket }) {
  const live = useStore((state) =>
    ticket.ticketId ? state.players.some((player) => player.sessionId === ticket.sessionId) : ticket.customerId ? state.tickets[ticket.customerId]?.sessionId === ticket.sessionId : false,
  );
  const name = ticket.ticketId ? playerLabel(ticket.name) : ticket.name;
  if (!live) return <>{name}</>;
  return (
    <a href={ticket.ticketId ? playerHref(ticket.ticketId) : customerHref(ticket.customerId ?? "")} className="Link--secondary">
      {name}
    </a>
  );
}
