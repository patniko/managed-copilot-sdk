import { BugIcon, CopilotIcon, FlameIcon, LightBulbIcon, ShieldIcon, ShieldLockIcon, XIcon } from "@primer/octicons-react";
import { BUG_AREA_INFO, PRODUCT_NAME, type ApprovalRequest, type BugReport, type CustomerCard, type PlayerTicket, type Ticket, type ToolItem } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { checkoutLine, latestMessage, money, openerText, plainText, playerLabel, WORK_ORDER_STATUS, workOrderLine } from "../lib/format.js";
import { customerHref, playerHref } from "../lib/router.js";
import { answer, answerPlayer, decide, useStore } from "../lib/store.js";
import { CustomerAvatar, LiveBadge, ProductChip, StatusLabel, TONE_TEXT } from "./ui/Status.js";
import { Tooltip } from "./ui/Tooltip.js";

/** Every tile has the same height, so the wall never shifts while conversations stream in. */
const TILE = "h-[112px] min-w-0 p-3";

/** A customer on the wall: who, how it's going, the latest message, and anything that needs the operator. */
export function Tile({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const latest = latestMessage(ticket);
  const bug = ticket.bug;
  const approval = ticket.approval;
  const bar = approval ? (
    <ApprovalBar approval={approval} onAnswer={(approve) => void answer(customer.id, approval.id, approve)} />
  ) : ticket.memory ? (
    <MemoryBar customerId={customer.id} ticket={ticket} />
  ) : ticket.blocked > 0 ? (
    <Blocked ticket={ticket} />
  ) : bug ? (
    <IssueMarker bug={bug} />
  ) : null;
  return (
    <article
      data-ticket={customer.id}
      className={cx(
        "tile Box relative flex flex-col transition-colors hover:bg-canvas-muted",
        TILE,
        ticket.status === "approval" && "tile-asking",
        ticket.status === "failed" && "border-line-danger-muted",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <CustomerAvatar customer={customer} />
        <a href={customerHref(customer.id)} className="tile-link min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={customer.name}>
          {customer.name}
        </a>
        {ticket.triage?.state === "done" && ticket.triage.urgent ? (
          <Tooltip content="Urgent, by the decision model" className="relative z-10 shrink-0">
            <FlameIcon size={14} className="text-fg-severe" aria-label="Urgent" />
          </Tooltip>
        ) : null}
        {bug && (approval || ticket.memory || ticket.blocked > 0) ? <BugMark bug={bug} /> : null}
        <StatusLabel status={ticket.status} />
      </div>
      <p className={cx("mt-2 text-sm", bar ? "line-clamp-1" : "line-clamp-2", latest?.from === "agent" ? "text-fg" : "text-fg-muted")} title={latest ? plainText(latest.text) : customer.opening}>
        {latest?.from === "agent" ? <CopilotIcon size={14} className="mr-1 inline-block align-[-2px] text-fg-muted" /> : null}
        {latest ? plainText(latest.text) : (ticket.problem ?? customer.opening)}
      </p>
      {bar ? <div className="mt-auto flex h-7 min-w-0 items-center gap-1.5 text-xs">{bar}</div> : null}
    </article>
  );
}

/**
 * A live player of Downhill on the wall, before the simulated customers: their name with the game's, a Live badge, the
 * latest message, and what they tried at the Downhill Shop's checkout, or anything that needs the operator.
 */
export function PlayerTile({ ticket }: { readonly ticket: PlayerTicket }) {
  const latest = latestMessage(ticket);
  const bug = ticket.bug;
  const approval = ticket.approval;
  const name = ticket.player.name;
  const bar = approval ? (
    <ApprovalBar approval={approval} to={name} onAnswer={(approve) => void answerPlayer(ticket.ticketId, approval.id, approve)} />
  ) : bug ? (
    <IssueMarker bug={bug} />
  ) : (
    <ContextMarker ticket={ticket} />
  );
  const preview = ticket.ending
    ? "Ending this ticket…"
    : (ticket.problem ?? (ticket.status === "opened" ? "Waiting for the player to write…" : "Starting the conversation…"));
  return (
    <article
      data-player={ticket.ticketId}
      className={cx(
        "tile tile-player Box relative flex flex-col transition-colors hover:bg-canvas-muted",
        TILE,
        ticket.status === "approval" && "tile-asking",
        ticket.status === "failed" && "border-line-danger-muted",
        ticket.ending && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <CustomerAvatar customer={ticket.player} />
        <a href={playerHref(ticket.ticketId)} className="tile-link min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={playerLabel(name)}>
          {name}
          <span className="text-xs font-normal text-fg-muted"> · {PRODUCT_NAME}</span>
        </a>
        <StatusLabel status={ticket.status} />
      </div>
      <p className={cx("mt-2 text-sm", bar ? "line-clamp-1" : "line-clamp-2", latest?.from === "agent" ? "text-fg" : "text-fg-muted")} title={latest ? plainText(latest.text) : preview}>
        <LiveBadge className="mr-1.5" />
        {latest?.from === "agent" ? <CopilotIcon size={14} className="mr-1 inline-block align-[-2px] text-fg-muted" /> : null}
        {latest && !ticket.ending ? plainText(latest.text) : preview}
      </p>
      {bar ? <div className="mt-auto flex h-7 min-w-0 items-center gap-1.5 text-xs">{bar}</div> : null}
    </article>
  );
}

/** The bar below is taken: the software issue shows as an icon. */
function BugMark({ bug }: { readonly bug: BugReport }) {
  return (
    <Tooltip content={`Software issue: ${bug.title}`} className="relative z-10 shrink-0">
      <BugIcon size={14} className="text-fg-done" aria-label="Software issue" />
    </Tooltip>
  );
}

/** A refund or cancellation waiting for the operator: what it would do, Approve, and Decline (×). */
function ApprovalBar({ approval, to, onAnswer }: { readonly approval: ApprovalRequest; readonly to?: string; readonly onAnswer: (approve: boolean) => void }) {
  const busy = useStore((state) => Boolean(state.answering[approval.id]));
  const what = approval.action === "refund" ? "Refund" : "Cancel";
  const detail = `${what} ${money(approval.amount)} of ${approval.orderId}${to ? ` to ${to}` : ""}${approval.reason ? `: ${approval.reason}` : ""}`;
  return (
    <>
      <ShieldIcon size={14} className="shrink-0 text-fg-attention" />
      <span className="min-w-0 truncate font-semibold" title={detail}>
        {what} {money(approval.amount)}
      </span>
      <span className="relative z-10 ml-auto flex shrink-0 items-center gap-1">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAnswer(true)}>
          Approve
        </button>
        <Tooltip content="Decline">
          <button type="button" className="btn btn-sm btn-icon" aria-label={`Decline ${what.toLowerCase()} of ${approval.orderId}`} disabled={busy} onClick={() => onAnswer(false)}>
            <XIcon size={16} />
          </button>
        </Tooltip>
      </span>
    </>
  );
}

/** The agent proposed a fact for the team knowledge base: the operator adds it or not. */
function MemoryBar({ customerId, ticket }: { readonly customerId: string; readonly ticket: Ticket }) {
  const memory = ticket.memory!;
  const busy = useStore((state) => Boolean(state.answering[memory.id]));
  return (
    <>
      <LightBulbIcon size={14} className="shrink-0 text-fg-attention" />
      <span className="min-w-0 truncate font-semibold" title={`Proposed for team knowledge: ${memory.subject}: ${memory.fact}`}>
        {memory.subject}
      </span>
      <span className="relative z-10 ml-auto flex shrink-0 items-center gap-1">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decide(memory.id, true)}>
          Add
        </button>
        <Tooltip content="Don't add">
          <button type="button" className="btn btn-sm btn-icon" aria-label={`Don't add "${memory.subject}" to team knowledge`} disabled={busy} onClick={() => void decide(memory.id, false)}>
            <XIcon size={16} />
          </button>
        </Tooltip>
      </span>
    </>
  );
}

function Blocked({ ticket }: { readonly ticket: Ticket }) {
  const orders = [...new Set(ticket.items.filter((item): item is ToolItem => item.kind === "tool" && item.blocked === true).map((item) => String(item.args["orderId"]).toUpperCase()))];
  return (
    <Tooltip content={`Asked for ${orders.join(", ")}, another customer's order. The store's tools refused.`} className="relative z-10">
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-fg-danger">
        <ShieldLockIcon size={14} className="shrink-0" />
        <span className="truncate">Blocked: not their order</span>
      </span>
    </Tooltip>
  );
}

/** The agent reported a software problem: what it's about, or the work order it's in. */
function IssueMarker({ bug }: { readonly bug: BugReport }) {
  const routed = useStore((state) => state.issues.find((issue) => issue.area === bug.area)?.routed);
  return (
    <>
      <Tooltip content={`Reported to engineering: ${bug.title}`} className="relative z-10">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-fg-done">
          <BugIcon size={14} className="shrink-0" />
          <span className="truncate">Software issue</span>
        </span>
      </Tooltip>
      {routed ? (
        <span className={cx("ml-auto min-w-0 truncate", TONE_TEXT[WORK_ORDER_STATUS[routed.status].tone])}>{workOrderLine(routed)}</span>
      ) : (
        <span className="ml-auto min-w-0 truncate text-fg-muted">{BUG_AREA_INFO[bug.area].label}</span>
      )}
    </>
  );
}

/** Where a player came from: the Downhill chip, and the code the shop's checkout turned down or where they opened support. */
function ContextMarker({ ticket }: { readonly ticket: PlayerTicket }) {
  const checkout = ticket.checkout;
  const text = checkout ? checkoutLine(checkout) : openerText(ticket.opener);
  return (
    <>
      <ProductChip />
      <span className="min-w-0 truncate text-fg-muted" title={checkout?.offer ? `${text} (${checkout.offer})` : text}>
        {text}
      </span>
    </>
  );
}

/** A customer before the simulation reaches them: their question, waiting. */
export function GhostTile({ customer, queued, urgent = false }: { readonly customer: CustomerCard; readonly queued: boolean; readonly urgent?: boolean }) {
  return (
    <article className={cx("flex flex-col rounded-md border border-dashed border-line transition-opacity", TILE, !queued && "opacity-40")}>
      <div className="flex min-w-0 items-center gap-2">
        <CustomerAvatar customer={customer} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-muted" title={customer.name}>
          {customer.name}
        </span>
        {urgent ? (
          <Tooltip content="Urgent, by the decision model" className="shrink-0">
            <FlameIcon size={14} className="text-fg-severe" aria-label="Urgent" />
          </Tooltip>
        ) : null}
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-fg-muted" title={customer.opening}>
        {customer.opening}
      </p>
    </article>
  );
}
