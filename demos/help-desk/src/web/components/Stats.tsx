import { CommentDiscussionIcon, CommentIcon, ContainerIcon, CopilotIcon, CpuIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { playerLabel, premium, toolCallCount } from "../lib/format.js";
import { useStore } from "../lib/store.js";
import { STATUS_DOT } from "./ui/Status.js";
import { Tooltip } from "./ui/Tooltip.js";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The economics at a glance: many sessions, one runtime, no sandboxes, and what it cost. */
export function Stats() {
  const counters = useStore((state) => state.counters);
  const tickets = useStore((state) => state.tickets);
  const players = useStore((state) => state.players);
  const toolCalls = Object.values(tickets).reduce((sum, ticket) => sum + toolCallCount(ticket), 0) + players.reduce((sum, ticket) => sum + toolCallCount(ticket), 0);
  const perCustomer = counters.sessions > 0 ? counters.premiumRequests / counters.sessions : undefined;
  return (
    <section aria-label="Counters" className="Box grid grid-cols-2 gap-px overflow-hidden bg-line-muted sm:grid-cols-4 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1.2fr]">
      <Stat
        icon={CommentDiscussionIcon}
        value={counters.sessions}
        label={plural(counters.sessions, "session", "sessions")}
        caption={players.length > 0 ? "One per customer and player" : "One per customer"}
        className="col-span-2 sm:col-span-4 lg:col-span-1"
      >
        <SessionMap />
      </Stat>
      <Stat icon={CpuIcon} value={counters.runtimes} label={plural(counters.runtimes, "runtime", "runtimes")} caption="Shared by every session" tip="All sessions run in the one shared runtime process: no machine per customer." />
      <Stat icon={ContainerIcon} value={counters.sandboxes} label={plural(counters.sandboxes, "sandbox", "sandboxes")} caption="Tools run in Help Desk" tip="The agents' hands are this app's tools, so no session needs a sandbox." />
      <Stat icon={CommentIcon} value={counters.messages} label={plural(counters.messages, "message", "messages")} caption={`${toolCalls} tool ${plural(toolCalls, "call", "calls")}`} />
      <Stat
        icon={CopilotIcon}
        value={premium(counters.premiumRequests)}
        label={plural(counters.premiumRequests, "premium request", "premium requests")}
        caption={perCustomer !== undefined ? `${premium(Math.round(perCustomer * 100) / 100)} per ${players.length > 0 ? "conversation" : "customer"}` : "From each session's usage"}
      />
    </section>
  );
}

function Stat({
  icon: Glyph,
  value,
  label,
  caption,
  tip,
  className,
  children,
}: {
  readonly icon: Icon;
  readonly value: number | string;
  readonly label: string;
  readonly caption: string;
  readonly tip?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const body = (
    <div className="flex min-w-0 items-center gap-3">
      <Glyph size={20} className="shrink-0 text-fg-muted max-sm:hidden" />
      <div className="min-w-0">
        <div className="flex flex-col whitespace-nowrap xl:flex-row xl:items-baseline xl:gap-1.5">
          <span className="text-2xl font-semibold">{value}</span>
          <span className="truncate text-sm text-fg-muted">{label}</span>
        </div>
        <div className="truncate text-xs text-fg-muted max-sm:hidden" title={caption}>
          {caption}
        </div>
      </div>
    </div>
  );
  return (
    <div className={cx("flex min-w-0 items-center justify-between gap-3 bg-canvas px-4 py-3", className)}>
      {tip ? <Tooltip content={tip}>{body}</Tooltip> : body}
      {children}
    </div>
  );
}

/** One dot per live player and customer of the simulation, colored by status: the wall in miniature. */
function SessionMap() {
  const customers = useStore((state) => state.customers);
  const tickets = useStore((state) => state.tickets);
  const players = useStore((state) => state.players);
  const run = useStore((state) => state.run);
  const size = useStore((state) => state.size);
  const shown = customers.slice(0, run?.size ?? size);
  return (
    <div className="grid shrink-0 grid-cols-5 gap-1" aria-hidden>
      {players.map((player) => (
        <span key={player.ticketId} title={playerLabel(player.player.name)} className={cx("size-2.5 rounded-full ring-1 ring-line-accent transition-colors duration-500", STATUS_DOT[player.status])} />
      ))}
      {shown.map((customer) => {
        const ticket = tickets[customer.id];
        return (
          <span
            key={customer.id}
            title={customer.name}
            className={cx("size-2.5 rounded-full transition-colors duration-500", ticket ? STATUS_DOT[ticket.status] : "border border-line")}
          />
        );
      })}
    </div>
  );
}
