import { TagIcon, TrashIcon } from "@primer/octicons-react";
import { useState } from "react";
import { PRODUCT_NAME, SHOP_NAME, type PlayerTicket } from "../../shared/types.js";
import { approvalTitle, cents, money, openerText, PLAYER_GREETING, playerLabel } from "../lib/format.js";
import { wallHref } from "../lib/router.js";
import { answerPlayer, endPlayer, sendAsPlayer, useStore } from "../lib/store.js";
import { ChatWidget, Composer } from "./Chat.js";
import { Approval, BackToWall, Blank, ReportedIssue, SeesOnly, SessionDetails, ToolCalls, WhereItRuns, WIDGET } from "./Customer.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";
import { Spinner } from "./ui/Spinner.js";
import { CustomerAvatar, LiveBadge, ProductChip, StatusLabel } from "./ui/Status.js";

/** A live player's conversation: their support chat as they see it in the game, and what happened behind it. */
export function PlayerPage({ id }: { readonly id: string }) {
  const phase = useStore((state) => state.phase);
  const ticket = useStore((state) => state.players.find((candidate) => candidate.ticketId === id));
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4 sm:px-6">
      <BackToWall />
      {phase === "loading" ? (
        <div className="SkeletonBox mt-3 h-96! rounded-md!" />
      ) : !ticket ? (
        <Blank text="This player's ticket was ended, or doesn't exist." />
      ) : (
        <div className="mt-3 grid items-start gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <PlayerWidget ticket={ticket} />
          <BehindTheScenes ticket={ticket} />
        </div>
      )}
    </main>
  );
}

/** The player's support chat, the same one the game shows them. */
function PlayerWidget({ ticket }: { readonly ticket: PlayerTicket }) {
  const connected = useStore((state) => state.platform?.state === "connected");
  const ready = connected && !ticket.ending;
  const name = ticket.player.name;
  return (
    <ChatWidget
      label={`${name}'s support chat in ${PRODUCT_NAME}`}
      subtitle={`${SHOP_NAME} support`}
      avatar={<CustomerAvatar customer={ticket.player} size={28} />}
      greeting={PLAYER_GREETING}
      items={ticket.items}
      status={ticket.status}
      ended={ticket.ending === true}
      className={WIDGET}
      composer={<Composer placeholder={`Write as ${name}…`} label={`Message as ${name}`} disabled={!ready} onSend={(text) => sendAsPlayer(ticket.ticketId, text)} />}
    />
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** What the operator sees: where the session runs, the player's checkout, and every tool call. */
function BehindTheScenes({ ticket }: { readonly ticket: PlayerTicket }) {
  const desk = useStore((state) => state.desk);
  const busy = useStore((state) => (ticket.approval ? Boolean(state.answering[ticket.approval.id]) : false));
  const endingHere = useStore((state) => Boolean(state.ending[ticket.ticketId]));
  const ending = endingHere || ticket.ending === true;
  const [confirm, setConfirm] = useState(false);
  const name = ticket.player.name;
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <CustomerAvatar customer={ticket.player} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-lg font-semibold">{playerLabel(name)}</h1>
            <LiveBadge />
          </div>
          <div className="truncate text-sm text-fg-muted">
            {openerText(ticket.opener)}
            {ticket.player.rider ? ` · rider ${ticket.player.rider}` : ""}
          </div>
        </div>
        <StatusLabel status={ticket.status} />
      </div>

      {ticket.status === "opened" ? (
        <div className="flash flash-neutral text-sm" role="status">
          Waiting for the player: {name} sees the greeting, and their first message starts the session.
        </div>
      ) : null}

      <WhereItRuns tools={desk?.playerTools} />

      {ticket.approval ? (
        <Approval
          approval={ticket.approval}
          title={approvalTitle(ticket.approval, name)}
          busy={busy}
          onAnswer={(approve) => void answerPlayer(ticket.ticketId, ticket.approval!.id, approve)}
        />
      ) : null}

      {ticket.bug ? <ReportedIssue bug={ticket.bug} /> : null}

      {ticket.checkout ? <Checkout ticket={ticket} /> : null}

      <SeesOnly>
        <span className="branch-name">{name}'s checkout</span>
        {ticket.checkout?.order ? <span className="branch-name">{ticket.checkout.order.id}</span> : null}
      </SeesOnly>

      {ticket.checkout ? null : <p className="text-sm text-fg-muted">The game sent no checkout: {name} hasn't tried one in the {SHOP_NAME} yet, so the agent asks what they tried.</p>}

      <ToolCalls items={ticket.items} />

      {ticket.problem ? <div className="flash flash-error text-sm">{ticket.problem}</div> : null}

      <SessionDetails sessionId={ticket.sessionId} premiumRequests={ticket.premiumRequests}>
        <dt className="text-fg-muted">Opened</dt>
        <dd>{TIME.format(new Date(ticket.createdAt))}</dd>
        {ticket.gameVersion ? (
          <>
            <dt className="text-fg-muted">Game</dt>
            <dd>
              {PRODUCT_NAME} {ticket.gameVersion}
            </dd>
          </>
        ) : null}
        {ticket.userAgent ? (
          <>
            <dt className="text-fg-muted">Browser</dt>
            <dd className="truncate text-xs leading-5" title={ticket.userAgent}>
              {ticket.userAgent}
            </dd>
          </>
        ) : null}
      </SessionDetails>

      <div>
        <button type="button" className="btn btn-danger btn-sm" disabled={ending} onClick={() => setConfirm(true)}>
          {ending ? <Spinner size={16} /> : <TrashIcon size={16} />}
          {ending ? "Ending…" : "End ticket"}
        </button>
      </div>
      {confirm ? (
        <ConfirmDialog
          title={`End ${name}'s ticket?`}
          confirm="End ticket"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void endPlayer(ticket.ticketId).then((ended) => {
              if (ended) window.location.hash = wallHref();
            });
          }}
        >
          Its session is deleted, and {name}'s support chat in the game says it ended.
        </ConfirmDialog>
      ) : null}
    </aside>
  );
}

/** What the player tried at the Downhill Shop's checkout, as the game sent it. */
function Checkout({ ticket }: { readonly ticket: PlayerTicket }) {
  const checkout = ticket.checkout!;
  const order = checkout.order;
  return (
    <section aria-label={`${SHOP_NAME} checkout`} className="Box">
      <div className="Box-header py-2">
        <TagIcon size={16} className="shrink-0 text-fg-muted" />
        <h2 className="Box-title">{SHOP_NAME} checkout</h2>
        <ProductChip className="ml-auto" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
        <dt className="text-fg-muted">Code</dt>
        <dd>
          {/* Exactly as checkout got it: quotes show stray spaces. */}
          {checkout.code ? <code className="inline-code">{JSON.stringify(checkout.code)}</code> : <span className="text-fg-muted">None reached checkout</span>}
        </dd>
        {checkout.error ? (
          <>
            <dt className="text-fg-muted">Checkout said</dt>
            <dd className="text-fg-danger">{checkout.error}</dd>
          </>
        ) : null}
        {checkout.offer ? (
          <>
            <dt className="text-fg-muted">Offer</dt>
            <dd>{checkout.offer}</dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Cart</dt>
        <dd>{checkout.items.length ? checkout.items.map((item) => `${item.name} (${cents(item.priceCents)})`).join(", ") : <span className="text-fg-muted">Empty</span>}</dd>
        <dt className="text-fg-muted">Subtotal</dt>
        <dd>{cents(checkout.subtotalCents)}</dd>
        <dt className="text-fg-muted">Order</dt>
        <dd>
          {order ? (
            <>
              <span className="branch-name">{order.id}</span> {cents(order.totalCents)} paid at full price
              {ticket.refunded ? <span className="text-fg-success">, {money(ticket.refunded)} refunded</span> : null}
            </>
          ) : (
            "Not bought yet"
          )}
        </dd>
      </dl>
    </section>
  );
}
