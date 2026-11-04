import { CopilotIcon, ShieldIcon, ShieldLockIcon, XIcon } from "@primer/octicons-react";
import type { CustomerCard, Ticket, ToolItem } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { latestMessage, money, plainText } from "../lib/format.js";
import { customerHref } from "../lib/router.js";
import { answer, useStore } from "../lib/store.js";
import { CustomerAvatar, StatusLabel } from "./ui/Status.js";
import { Tooltip } from "./ui/Tooltip.js";

/** Every tile has the same height, so the wall never shifts while conversations stream in. */
const TILE = "h-[112px] min-w-0 p-3";

/** A customer on the wall: who, how it's going, the latest message, and anything that needs the operator. */
export function Tile({ customer, ticket }: { readonly customer: CustomerCard; readonly ticket: Ticket }) {
  const latest = latestMessage(ticket);
  const bar = ticket.approval ? <ApprovalBar customerId={customer.id} ticket={ticket} /> : ticket.blocked > 0 ? <Blocked ticket={ticket} /> : null;
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

function ApprovalBar({ customerId, ticket }: { readonly customerId: string; readonly ticket: Ticket }) {
  const approval = ticket.approval!;
  const busy = useStore((state) => Boolean(state.answering[approval.id]));
  const what = approval.action === "refund" ? "Refund" : "Cancel";
  return (
    <>
      <ShieldIcon size={14} className="shrink-0 text-fg-attention" />
      <span className="min-w-0 truncate font-semibold" title={`${what} ${approval.orderId} (${money(approval.amount)})${approval.reason ? `: ${approval.reason}` : ""}`}>
        {what} {money(approval.amount)}
      </span>
      <span className="relative z-10 ml-auto flex shrink-0 items-center gap-1">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void answer(customerId, approval.id, true)}>
          Approve
        </button>
        <Tooltip content="Decline">
          <button type="button" className="btn btn-sm btn-icon" aria-label={`Decline ${what.toLowerCase()} of ${approval.orderId}`} disabled={busy} onClick={() => void answer(customerId, approval.id, false)}>
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

/** A customer before the simulation reaches them: their question, waiting. */
export function GhostTile({ customer, queued }: { readonly customer: CustomerCard; readonly queued: boolean }) {
  return (
    <article className={cx("flex flex-col rounded-md border border-dashed border-line transition-opacity", TILE, !queued && "opacity-40")}>
      <div className="flex min-w-0 items-center gap-2">
        <CustomerAvatar customer={customer} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-muted" title={customer.name}>
          {customer.name}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-fg-muted" title={customer.opening}>
        {customer.opening}
      </p>
    </article>
  );
}
