import { AlertIcon, ArrowLeftIcon, BugIcon, CheckIcon, ClockIcon, CommentIcon, ContainerIcon, CpuIcon, LightBulbIcon, LockIcon, PlugIcon, ShieldIcon, ShieldLockIcon, XIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { BUG_AREA_INFO, type ApprovalRequest, type BugReport, type CustomerCard, type MessageItem, type Ticket, type TicketKnownIssue, type ToolInfo, type ToolItem, type TranscriptItem } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { approvalNoun, approvalTitle, KNOWN_ISSUE_STATE, operatorOutcome, playerLabel, plural, premium, toolArgs } from "../lib/format.js";
import { wallHref } from "../lib/router.js";
import { answer, decide, sendAsCustomer, sendNote, useStore } from "../lib/store.js";
import { ChatWidget, Composer } from "./Chat.js";
import { IssueAction } from "./Issues.js";
import { CustomerAvatar, StatusLabel, TONE_TEXT } from "./ui/Status.js";

/** One customer's conversation: their support widget, and what happened behind it. */
export function CustomerPage({ id }: { readonly id: string }) {
  const phase = useStore((state) => state.phase);
  const customer = useStore((state) => state.customers.find((candidate) => candidate.id === id));
  const ticket = useStore((state) => state.tickets[id]);
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4 sm:px-6">
      <BackToWall />
      {phase === "loading" ? (
        <div className="SkeletonBox mt-3 h-96! rounded-md!" />
      ) : !customer ? (
        <Blank text="There's no such customer." />
      ) : !ticket ? (
        <Blank text={`${customer.name} isn't in this simulation.`} />
      ) : (
        <div className="mt-3 grid items-start gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <Widget customer={customer} ticket={ticket} />
          <BehindTheScenes customer={customer} ticket={ticket} />
        </div>
      )}
    </main>
  );
}

export function BackToWall() {
  return (
    <a href={wallHref()} className="btn btn-invisible btn-sm -ml-2">
      <ArrowLeftIcon size={16} />
      All conversations
    </a>
  );
}

export function Blank({ text }: { readonly text: string }) {
  return (
    <div className="blankslate mt-3 rounded-md border border-line">
      <p className="blankslate-description">{text}</p>
      <div className="blankslate-action">
        <a href={wallHref()} className="btn">
          Back to the wall
        </a>
      </div>
    </div>
  );
}

const firstName = (customer: CustomerCard) => customer.name.split(" ")[0] ?? customer.name;

/** The size the wall gives a support widget. */
export const WIDGET = "h-[min(640px,calc(100dvh-150px))] min-h-[420px] shadow-lg";

/** The store's support widget, as the customer sees it. */
function Widget({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const connected = useStore((state) => state.platform?.state === "connected");
  const ready = connected && ticket.sessionId !== undefined && ticket.status !== "failed";
  return (
    <ChatWidget
      label={`${firstName(customer)}'s support chat`}
      subtitle="Support"
      avatar={<CustomerAvatar customer={customer} size={28} />}
      items={ticket.items}
      status={ticket.status}
      className={WIDGET}
      composer={<Composer placeholder={`Write as ${firstName(customer)}…`} label={`Message as ${firstName(customer)}`} disabled={!ready} onSend={(text) => sendAsCustomer(customer.id, text)} />}
    />
  );
}

/** What the operator sees: where the session runs, what it may touch, and every tool call. */
function BehindTheScenes({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const desk = useStore((state) => state.desk);
  const busy = useStore((state) => (ticket.approval ? Boolean(state.answering[ticket.approval.id]) : false));
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <CustomerAvatar customer={customer} size={40} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{customer.name}</h1>
          <div className="truncate text-sm text-fg-muted">{customer.email}</div>
        </div>
        <StatusLabel status={ticket.status} />
      </div>

      <WhereItRuns tools={desk?.tools} />

      {ticket.approval ? (
        <Approval
          approval={ticket.approval}
          title={approvalTitle(ticket.approval)}
          busy={busy}
          onAnswer={(approve) => void answer(customer.id, ticket.approval!.id, approve)}
        />
      ) : null}

      {ticket.memory ? <MemoryProposalBox ticket={ticket} /> : null}

      <TeamNotes
        items={ticket.items}
        knownIssue={ticket.knownIssue}
        disabled={ticket.sessionId === undefined || ticket.status === "failed"}
        onSend={(text) => sendNote({ customerId: customer.id }, text)}
        name={firstName(customer)}
        waitingOn={ticket.approval ? approvalNoun(ticket.approval) : undefined}
      />

      {ticket.bug ? <ReportedIssue bug={ticket.bug} /> : null}

      <SeesOnly>
        {customer.orderIds.map((orderId) => (
          <span key={orderId} className="branch-name">
            {orderId}
          </span>
        ))}
      </SeesOnly>

      <ToolCalls items={ticket.items} />

      {ticket.problem ? <div className="flash flash-error text-sm">{ticket.problem}</div> : null}

      <SessionDetails sessionId={ticket.sessionId} premiumRequests={ticket.premiumRequests} />
    </aside>
  );
}

/** Where a session runs: the shared runtime, this app's tools, and no sandbox. */
export function WhereItRuns({ tools }: { readonly tools: readonly ToolInfo[] | undefined }) {
  const desk = useStore((state) => state.desk);
  return (
    <div className="Box grid grid-cols-1 gap-px overflow-hidden bg-line-muted text-sm sm:grid-cols-3">
      <Placement icon={<CpuIcon size={16} />} label="Agent" value="Shared runtime" title={desk?.model ? `Model ${desk.model}` : undefined} />
      <Placement icon={<PlugIcon size={16} />} label="Tools" value="In Help Desk" title={tools?.map((tool) => (tool.approval ? `${tool.name} (needs approval)` : tool.name)).join(", ")} />
      <Placement icon={<ContainerIcon size={16} />} label="Sandbox" value="None" />
    </div>
  );
}

function Placement({ icon, label, value, title }: { readonly icon: ReactNode; readonly label: string; readonly value: string; readonly title?: string | undefined }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 bg-canvas px-3 py-2 sm:flex-col sm:items-start sm:justify-start sm:gap-0.5" title={title}>
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        {icon}
        {label}
      </span>
      <span className="truncate font-semibold">{value}</span>
    </div>
  );
}

/** The only things a session's tools can reach. */
export function SeesOnly({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <LockIcon size={16} className="shrink-0 text-fg-muted" />
      <span className="shrink-0 text-fg-muted">Sees only</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

/** Every tool call of a conversation, with what it did. */
export function ToolCalls({ items }: { readonly items: readonly TranscriptItem[] }) {
  const tools = items.filter((item): item is ToolItem => item.kind === "tool");
  return (
    <div className="Box">
      <div className="Box-header py-2">
        <h2 className="Box-title">Tool calls</h2>
        <span className="Counter">{tools.length}</span>
      </div>
      {tools.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-muted">None yet.</p>
      ) : (
        <ul>
          {tools.map((item) => {
            const outcome = operatorOutcome(item);
            return (
              <li key={item.id} className="Box-row flex min-w-0 items-center gap-2 py-2 text-sm">
                {item.blocked ? (
                  <ShieldLockIcon size={16} className="shrink-0 text-fg-danger" />
                ) : item.name === "report_bug" ? (
                  <BugIcon size={16} className="shrink-0 text-fg-done" />
                ) : item.name === "store_memory" ? (
                  <LightBulbIcon size={16} className="shrink-0 text-fg-attention" />
                ) : item.name === "report_known_issue" ? (
                  <AlertIcon size={16} className="shrink-0 text-fg-attention" />
                ) : (
                  <PlugIcon size={16} className="shrink-0 text-fg-muted" />
                )}
                <span className="shrink-0 font-mono text-xs">{item.name}</span>
                <span className="shrink-0 text-xs text-fg-muted">{toolArgs(item)}</span>
                <span className={cx("ml-auto min-w-0 truncate text-right text-xs", TONE_TEXT[outcome.tone])} title={outcome.text}>
                  {outcome.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A session's ID, environment, model, and premium requests, folded away. */
export function SessionDetails({ sessionId, premiumRequests, children }: { readonly sessionId?: string | undefined; readonly premiumRequests?: number | undefined; readonly children?: ReactNode }) {
  const desk = useStore((state) => state.desk);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-fg-muted select-none">Session details</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-fg-muted">Session</dt>
        <dd className="truncate font-mono text-xs leading-5" title={sessionId}>
          {sessionId ?? "Starting…"}
        </dd>
        <dt className="text-fg-muted">Environment</dt>
        <dd className="font-mono text-xs leading-5">{desk?.environment}</dd>
        <dt className="text-fg-muted">Model</dt>
        <dd className="font-mono text-xs leading-5">{desk?.model ?? "Default"}</dd>
        <dt className="text-fg-muted">Premium requests</dt>
        <dd>{premiumRequests !== undefined ? premium(premiumRequests) : "Not counted yet"}</dd>
        {children}
      </dl>
    </details>
  );
}

/** A refund or cancellation waiting for the operator: what it would do, and Decline or Approve. */
export function Approval({
  approval,
  title,
  busy,
  onAnswer,
}: {
  readonly approval: ApprovalRequest;
  readonly title: string;
  readonly busy: boolean;
  readonly onAnswer: (approve: boolean) => void;
}) {
  return (
    <div className="Box Box--attention animate-fade-in">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <ShieldIcon size={20} className="shrink-0 text-fg-attention" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          {approval.reason ? (
            <div className="truncate text-sm text-fg-muted" title={approval.reason}>
              {approval.reason}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => onAnswer(false)}>
            <XIcon size={16} />
            Decline
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => onAnswer(true)}>
            <CheckIcon size={16} className="text-fg-success!" />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A fact the agent proposed for the team knowledge base, or a known issue: every later conversation is told it once
 * it's added (recorded).
 */
function MemoryProposalBox({ ticket }: { readonly ticket: Ticket }) {
  const memory = ticket.memory!;
  const busy = useStore((state) => Boolean(state.answering[memory.id]));
  const issue = memory.kind === "known-issue";
  const Icon = issue ? AlertIcon : LightBulbIcon;
  return (
    <section aria-label={issue ? "Proposed known issue" : "Proposed team knowledge"} className="Box Box--attention animate-fade-in">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <Icon size={20} className="mt-0.5 shrink-0 text-fg-attention" />
        <div className="min-w-0 flex-1 basis-60">
          <div className="text-xs text-fg-muted">{issue ? "Proposed as a known issue for the whole desk" : "Proposed for the team knowledge base"}</div>
          <div className="font-semibold">{memory.subject}</div>
          {issue ? (
            <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-fg-muted">Customers say</dt>
              <dd>{memory.symptoms ?? memory.subject}</dd>
              <dt className="text-fg-muted">They're told</dt>
              <dd>{memory.fact}</dd>
            </dl>
          ) : (
            <p className="mt-1 text-sm">{memory.fact}</p>
          )}
          {memory.citations ? <p className="mt-1 text-xs text-fg-muted">Source: {memory.citations}</p> : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => void decide(memory.id, false)}>
            <XIcon size={16} />
            {issue ? "Don't record" : "Don't add"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void decide(memory.id, true)}>
            <CheckIcon size={16} className="text-fg-success!" />
            {issue ? "Record known issue" : "Add to knowledge"}
          </button>
        </div>
      </div>
    </section>
  );
}

const NOTE_TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The team's side of a conversation: notes team members wrote to the agent (the customer never sees them), the known
 * issue updates Help Desk sent, and a box to write a note.
 */
export function TeamNotes({
  items,
  knownIssue,
  disabled,
  onSend,
  name,
  waitingOn,
}: {
  readonly items: readonly TranscriptItem[];
  readonly knownIssue: TicketKnownIssue | undefined;
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
  /** Whose agent: "Maya", "Mona". */
  readonly name: string;
  /** What the agent waits on before it reads a note, such as the refund above: notes queue until it's answered. */
  readonly waitingOn?: string | undefined;
}) {
  const notes = items.filter((item): item is MessageItem => item.kind === "message" && item.from === "team");
  const connected = useStore((state) => state.platform?.state === "connected");
  const state = knownIssue ? KNOWN_ISSUE_STATE[knownIssue.state] : undefined;
  return (
    <section aria-label="Team notes" className="Box">
      <div className="Box-header py-2">
        <CommentIcon size={16} className="shrink-0 text-fg-muted" />
        <h2 className="Box-title">Team notes</h2>
        <span className="Counter">{notes.length}</span>
        {knownIssue && state ? (
          <span className={cx("ml-auto inline-flex min-w-0 items-center gap-1 text-xs", TONE_TEXT[state.tone])} title={knownIssue.message ?? `Known issue: ${knownIssue.title}`}>
            <AlertIcon size={12} className="shrink-0 text-fg-attention" />
            <span className="truncate">Known issue · {state.label}</span>
          </span>
        ) : (
          <span className="ml-auto min-w-0 truncate text-xs text-fg-muted">Only the agent sees these</span>
        )}
      </div>
      {notes.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-muted">Write to {name}'s agent: tell it what the team knows, such as an ongoing problem. {name} won't see your note, only the agent's reply.</p>
      ) : (
        <ul>
          {notes.map((note) => (
            <li key={note.id} className="Box-row py-2 text-sm">
              <div className="flex items-center gap-1.5 text-xs text-fg-muted">
                {note.knownIssueId ? <AlertIcon size={12} className="shrink-0 text-fg-attention" /> : <CommentIcon size={12} className="shrink-0" />}
                <span className="font-semibold text-fg">{note.knownIssueId ? "Known issue update" : note.author}</span>
                {note.knownIssueId ? <span>sent by {note.author}</span> : null}
                <span>· {NOTE_TIME.format(new Date(note.at))}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap">{note.text}</p>
            </li>
          ))}
        </ul>
      )}
      {waitingOn ? (
        <p className="flex items-start gap-1.5 border-t border-line-muted px-4 py-2 text-xs text-fg-attention">
          <ClockIcon size={12} className="mt-0.5 shrink-0" />
          <span>
            {name}'s agent is waiting on the {waitingOn} above. It reads your notes once you answer it.
          </span>
        </p>
      ) : null}
      <Composer placeholder={`Write to ${name}'s agent…`} label={`Note to ${name}'s agent`} disabled={disabled || !connected} onSend={onSend} />
    </section>
  );
}

/** The software problem the agent reported, and the software issue it's part of. */
export function ReportedIssue({ bug }: { readonly bug: BugReport }) {
  const issue = useStore((state) => state.issues.find((candidate) => candidate.area === bug.area));
  return (
    <section aria-label="Software issue" className="Box animate-fade-in">
      <div className="Box-header py-2">
        <BugIcon size={16} className="shrink-0 text-fg-done" />
        <h2 className="Box-title">Software issue reported</h2>
        <span className="Label Label--done ml-auto">{BUG_AREA_INFO[bug.area].label}</span>
      </div>
      <div className="px-4 py-3 text-sm">
        <p className="font-semibold">{bug.title}</p>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="text-fg-muted">What happened</dt>
          <dd>{bug.whatHappened}</dd>
          <dt className="text-fg-muted">Expected</dt>
          <dd>{bug.expected}</dd>
          {bug.orderId ? (
            <>
              <dt className="text-fg-muted">Order</dt>
              <dd>
                <span className="branch-name">{bug.orderId}</span>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      {issue ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-muted px-4 py-2.5">
          <span className="min-w-0 flex-1 basis-72 truncate text-xs text-fg-muted" title={issue.reports.map((report) => (report.product ? playerLabel(report.name) : report.name)).join(", ")}>
            {issue.title} · {plural(issue.reports.length, "ticket")}
          </span>
          <IssueAction issue={issue} />
        </div>
      ) : null}
    </section>
  );
}
