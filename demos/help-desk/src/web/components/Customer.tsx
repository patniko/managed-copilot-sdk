import { ArrowLeftIcon, BugIcon, CheckIcon, ContainerIcon, CopilotIcon, CpuIcon, DotFillIcon, LightBulbIcon, LockIcon, PaperAirplaneIcon, PlugIcon, ShieldIcon, ShieldLockIcon, XIcon } from "@primer/octicons-react";
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BUG_AREA_INFO, type BugReport, type CustomerCard, type Ticket } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { customerLine, inlineMarkdown, money, operatorOutcome, plural, premium, toolArgs } from "../lib/format.js";
import { wallHref } from "../lib/router.js";
import { answer, decide, sendAsCustomer, useStore } from "../lib/store.js";
import { IssueAction } from "./Issues.js";
import { CustomerAvatar, StatusLabel, TONE_TEXT } from "./ui/Status.js";

/** One customer's conversation: their support widget, and what happened behind it. */
export function CustomerPage({ id }: { readonly id: string }) {
  const phase = useStore((state) => state.phase);
  const customer = useStore((state) => state.customers.find((candidate) => candidate.id === id));
  const ticket = useStore((state) => state.tickets[id]);
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4 sm:px-6">
      <a href={wallHref()} className="btn btn-invisible btn-sm -ml-2">
        <ArrowLeftIcon size={16} />
        All customers
      </a>
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

function Blank({ text }: { readonly text: string }) {
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

/** The store's support widget, as the customer sees it. */
function Widget({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = ticket.items.at(-1);
  const typing = (ticket.status === "answering" || ticket.status === "starting") && !(last?.kind === "message" && last.from === "agent" && last.streaming);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [ticket, typing]);
  return (
    <section aria-label={`${firstName(customer)}'s support chat`} className="Box flex h-[min(640px,calc(100dvh-150px))] min-h-[420px] flex-col overflow-hidden shadow-lg">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-display-green-emphasis text-sm font-semibold text-fg-on-emphasis" aria-hidden>
          C
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Contoso Outdoors</div>
          <div className="flex items-center gap-1 text-xs text-fg-muted">
            <DotFillIcon size={12} className="text-fg-success" />
            Support
          </div>
        </div>
        <CustomerAvatar customer={customer} size={28} />
      </header>
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-4 py-4"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        <ol className="flex flex-col gap-2">
          {ticket.items.map((item) => {
            if (item.kind === "message") {
              return item.from === "customer" ? (
                <li key={item.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent-emphasis px-3 py-2 text-sm whitespace-pre-wrap text-fg-on-emphasis">{item.text}</div>
                </li>
              ) : (
                <AgentBubble key={item.id}>
                  <span className={cx(item.streaming && "streaming")}>
                    <Rich text={item.text} />
                  </span>
                </AgentBubble>
              );
            }
            const line = customerLine(item);
            return line ? (
              <li key={item.id} className={cx("flex items-center justify-center gap-1 py-0.5 text-xs", TONE_TEXT[line.tone])}>
                <PlugIcon size={12} className="shrink-0" />
                {line.text}
              </li>
            ) : null;
          })}
          {typing ? (
            <AgentBubble>
              <span className="typing" aria-label="Typing">
                <span />
                <span />
                <span />
              </span>
            </AgentBubble>
          ) : null}
        </ol>
      </div>
      <Composer customer={customer} ticket={ticket} />
    </section>
  );
}

function AgentBubble({ children }: { readonly children: ReactNode }) {
  return (
    <li className="flex items-end gap-2">
      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-canvas-muted" aria-hidden>
        <CopilotIcon size={14} className="text-fg-muted" />
      </span>
      <div className="max-w-[85%] rounded-xl rounded-bl-sm border border-line bg-canvas-muted px-3 py-2 text-sm whitespace-pre-wrap">{children}</div>
    </li>
  );
}

/** An agent's reply with its bold, italic, and code marks applied. */
function Rich({ text }: { readonly text: string }) {
  return inlineMarkdown(text).map((span, index) =>
    span.kind === "strong" ? (
      <strong key={index}>{span.text}</strong>
    ) : span.kind === "em" ? (
      <em key={index}>{span.text}</em>
    ) : span.kind === "code" ? (
      <code key={index} className="inline-code">
        {span.text}
      </code>
    ) : (
      span.text
    ),
  );
}

function Composer({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const connected = useStore((state) => state.platform?.state === "connected");
  const ready = connected && ticket.sessionId !== undefined && ticket.status !== "failed";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    if (await sendAsCustomer(customer.id, message)) setText("");
    setSending(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex items-center gap-2 border-t border-line p-2">
      <input
        className="form-control min-w-0 flex-1"
        placeholder={`Write as ${firstName(customer)}…`}
        aria-label={`Message as ${firstName(customer)}`}
        value={text}
        maxLength={2_000}
        disabled={!ready}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="btn btn-primary btn-icon" aria-label="Send" disabled={!ready || sending || !text.trim()}>
        <PaperAirplaneIcon size={16} />
      </button>
    </form>
  );
}

/** What the operator sees: where the session runs, what it may touch, and every tool call. */
function BehindTheScenes({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const desk = useStore((state) => state.desk);
  const tools = ticket.items.filter((item) => item.kind === "tool");
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

      <div className="Box grid grid-cols-1 gap-px overflow-hidden bg-line-muted text-sm sm:grid-cols-3">
        <Placement icon={<CpuIcon size={16} />} label="Agent" value="Shared runtime" title={desk?.model ? `Model ${desk.model}` : undefined} />
        <Placement
          icon={<PlugIcon size={16} />}
          label="Tools"
          value="In Help Desk"
          title={desk?.tools.map((tool) => (tool.approval ? `${tool.name} (needs approval)` : tool.name)).join(", ")}
        />
        <Placement icon={<ContainerIcon size={16} />} label="Sandbox" value="None" />
      </div>

      {ticket.approval ? <Approval customerId={customer.id} ticket={ticket} /> : null}

      {ticket.memory ? <MemoryProposalBox customerId={customer.id} ticket={ticket} /> : null}

      {ticket.bug ? <ReportedIssue bug={ticket.bug} /> : null}

      <div className="flex min-w-0 items-center gap-2 text-sm">
        <LockIcon size={16} className="shrink-0 text-fg-muted" />
        <span className="shrink-0 text-fg-muted">Sees only</span>
        <span className="flex min-w-0 flex-wrap gap-1">
          {customer.orderIds.map((orderId) => (
            <span key={orderId} className="branch-name">
              {orderId}
            </span>
          ))}
        </span>
      </div>

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

      {ticket.problem ? <div className="flash flash-error text-sm">{ticket.problem}</div> : null}

      <details className="text-sm">
        <summary className="cursor-pointer text-fg-muted select-none">Session details</summary>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-fg-muted">Session</dt>
          <dd className="truncate font-mono text-xs leading-5" title={ticket.sessionId}>
            {ticket.sessionId ?? "Starting…"}
          </dd>
          <dt className="text-fg-muted">Environment</dt>
          <dd className="font-mono text-xs leading-5">{desk?.environment}</dd>
          <dt className="text-fg-muted">Model</dt>
          <dd className="font-mono text-xs leading-5">{desk?.model ?? "Default"}</dd>
          <dt className="text-fg-muted">Premium requests</dt>
          <dd>{ticket.premiumRequests !== undefined ? premium(ticket.premiumRequests) : "Not counted yet"}</dd>
        </dl>
      </details>
    </aside>
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

function Approval({ customerId, ticket }: { readonly customerId: string; readonly ticket: Ticket }) {
  const approval = ticket.approval!;
  const busy = useStore((state) => Boolean(state.answering[approval.id]));
  const what = approval.action === "refund" ? "Refund" : "Cancel";
  return (
    <div className="Box Box--attention animate-fade-in">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <ShieldIcon size={20} className="shrink-0 text-fg-attention" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {what} {money(approval.amount)} · {approval.orderId}
          </div>
          {approval.reason ? (
            <div className="truncate text-sm text-fg-muted" title={approval.reason}>
              {approval.reason}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => void answer(customerId, approval.id, false)}>
            <XIcon size={16} />
            Decline
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void answer(customerId, approval.id, true)}>
            <CheckIcon size={16} className="text-fg-success!" />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

/** A fact the agent proposed for the team knowledge base: every later conversation is told it once it's added. */
function MemoryProposalBox({ customerId, ticket }: { readonly customerId: string; readonly ticket: Ticket }) {
  const memory = ticket.memory!;
  const busy = useStore((state) => Boolean(state.answering[memory.id]));
  return (
    <section aria-label="Proposed team knowledge" className="Box Box--attention animate-fade-in">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <LightBulbIcon size={20} className="mt-0.5 shrink-0 text-fg-attention" />
        <div className="min-w-0 flex-1 basis-60">
          <div className="text-xs text-fg-muted">Proposed for the team knowledge base</div>
          <div className="font-semibold">{memory.subject}</div>
          <p className="mt-1 text-sm">{memory.fact}</p>
          {memory.citations ? <p className="mt-1 text-xs text-fg-muted">Source: {memory.citations}</p> : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => void decide(memory.id, false)}>
            <XIcon size={16} />
            Don't add
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void decide(memory.id, true)}>
            <CheckIcon size={16} className="text-fg-success!" />
            Add to knowledge
          </button>
        </div>
      </div>
    </section>
  );
}

/** The problem with the store's website the agent reported, and the software issue it's part of. */
function ReportedIssue({ bug }: { readonly bug: BugReport }) {
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
          <span className="min-w-0 flex-1 basis-72 truncate text-xs text-fg-muted" title={issue.reports.map((report) => report.name).join(", ")}>
            {issue.title} · {plural(issue.reports.length, "ticket")}
          </span>
          <IssueAction issue={issue} />
        </div>
      ) : null}
    </section>
  );
}
