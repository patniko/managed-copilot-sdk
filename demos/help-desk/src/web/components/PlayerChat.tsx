import { AlertIcon, CheckCircleIcon, ShieldIcon, SyncIcon } from "@primer/octicons-react";
import { useEffect, useState, type ReactNode } from "react";
import { PRODUCT_NAME, SHOP_NAME, type PlayerTicket } from "../../shared/types.js";
import { retryChat, sendChat, startChat, UNREACHABLE, useChat, type ChatState } from "../lib/chat.js";
import { cx } from "../lib/cx.js";
import { latestRefund, money, PLAYER_GREETING } from "../lib/format.js";
import { ChatWidget, Composer } from "./Chat.js";
import { Spinner } from "./ui/Spinner.js";
import { CustomerAvatar } from "./ui/Status.js";

/**
 * A player's support chat, on its own: what Downhill shows in a frame (about 420 by 640) when a player opens support in
 * the game. It also works as a full page. No wall chrome: only the conversation.
 */
export function PlayerChat({ ticketId }: { readonly ticketId: string }) {
  useEffect(() => {
    document.title = `${SHOP_NAME} support · Contoso Outdoors`;
    startChat(ticketId);
  }, [ticketId]);
  const chat = useChat();
  // Framed by the game: fill the frame. Opened on its own: a card in the middle of the page.
  const [framed] = useState(() => window.self !== window.top);
  return (
    <div className={cx("flex h-dvh flex-col bg-canvas text-fg", !framed && "sm:items-center sm:justify-center sm:bg-canvas-inset sm:p-6")}>
      <div className={cx("flex min-h-0 w-full flex-1 flex-col", !framed && "sm:max-h-[720px] sm:max-w-[440px]")}>
        {chat.phase === "ready" && chat.ticket ? <PlayerConversation chat={chat} ticket={chat.ticket} framed={framed} /> : <Waiting chat={chat} />}
      </div>
    </div>
  );
}

/** Before the conversation shows: connecting, no such chat, or Help Desk unreachable. */
function Waiting({ chat }: { readonly chat: ChatState }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="status">
      {chat.phase === "loading" ? (
        <>
          <Spinner size={24} className="text-fg-muted" />
          <p className="text-sm text-fg-muted">Connecting you to Contoso Outdoors support…</p>
        </>
      ) : chat.phase === "missing" ? (
        <>
          <h1 className="text-base font-semibold">There's no such support chat</h1>
          <p className="text-sm text-fg-muted">It may have ended. To get help, open support again in {PRODUCT_NAME}.</p>
        </>
      ) : (
        <>
          <AlertIcon size={24} className="text-fg-attention" />
          <h1 className="text-base font-semibold">{UNREACHABLE}</h1>
          <p className="text-sm text-fg-muted">Check your connection, then try again.</p>
          <button type="button" className="btn btn-sm" onClick={retryChat}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

/** The conversation, from the greeting on, with the box to write in. Exported for tests. */
export function PlayerConversation({ chat, ticket, framed }: { readonly chat: ChatState; readonly ticket: PlayerTicket; readonly framed: boolean }) {
  const [problem, setProblem] = useState<string | undefined>();
  const online = chat.platform?.state === "connected" && chat.connection === "open";
  // The first message starts the conversation; after a message that failed, the player can try again.
  const ready = online && !chat.ended && !ticket.ending;
  const name = ticket.player.name;
  return (
    <ChatWidget
      label={`Contoso Outdoors support chat for ${name}`}
      subtitle={`${SHOP_NAME} support`}
      avatar={<CustomerAvatar customer={ticket.player} size={28} />}
      greeting={PLAYER_GREETING}
      items={ticket.items}
      status={ticket.status}
      ended={chat.ended || ticket.ending === true}
      className={cx("flex-1", framed ? "rounded-none border-0" : "sm:shadow-lg max-sm:rounded-none max-sm:border-0")}
      notice={<Notice chat={chat} ticket={ticket} />}
      composer={
        chat.ended || ticket.ending ? (
          <p className="shrink-0 border-t border-line px-4 py-3 text-center text-sm text-fg-muted">This chat has ended. To get help again, open support in {PRODUCT_NAME}.</p>
        ) : (
          <div className="shrink-0">
            {problem ? (
              <p className="border-t border-line px-3 pt-2 text-xs text-fg-danger" role="alert">
                {problem}
              </p>
            ) : null}
            <Composer
              placeholder={ticket.status === "opened" ? "Tell us what happened…" : "Write a message…"}
              label="Message to Contoso Outdoors support"
              disabled={!ready}
              onSend={async (text) => {
                const failed = await sendChat(text);
                setProblem(failed);
                return failed === undefined;
              }}
            />
          </div>
        )
      }
    />
  );
}

/** One line under the header: what the chat is waiting for, how it went, or why it can't go on. */
function Notice({ chat, ticket }: { readonly chat: ChatState; readonly ticket: PlayerTicket }) {
  const refund = latestRefund(ticket.items);
  const refunded = typeof refund?.result?.["refunded"] === "number" ? (refund.result["refunded"] as number) : undefined;
  if (chat.ended || ticket.ending) return <Strip tone="neutral">This support chat has ended.</Strip>;
  if (chat.connection === "reconnecting") {
    return (
      <Strip tone="warn" icon={<SyncIcon size={16} />}>
        Reconnecting to support…
      </Strip>
    );
  }
  if (chat.platform && chat.platform.state !== "connected") {
    return (
      <Strip tone="warn" icon={<AlertIcon size={16} />}>
        Support is offline for a moment. Your chat comes back by itself.
      </Strip>
    );
  }
  if (ticket.status === "failed") {
    return (
      <Strip tone="error" icon={<AlertIcon size={16} />}>
        {ticket.items.length === 0 ? "Your message didn't reach support. Try sending it again." : "Something went wrong with this chat. A team member can see it and will follow up."}
      </Strip>
    );
  }
  if (ticket.status === "approval") {
    return (
      <Strip tone="warn" icon={<ShieldIcon size={16} />}>
        A support team member is reviewing your refund{ticket.approval ? ` of ${money(ticket.approval.amount)}` : ""}.
      </Strip>
    );
  }
  if (ticket.status === "resolved") {
    return (
      <Strip tone="success" icon={<CheckCircleIcon size={16} />}>
        {refunded !== undefined ? `Resolved: ${money(refunded)} is on its way back to you.` : "Resolved."} Write again if you need anything else.
      </Strip>
    );
  }
  if (refunded !== undefined) {
    return (
      <Strip tone="success" icon={<CheckCircleIcon size={16} />}>
        Refund approved: {money(refunded)} is on its way back to you.
      </Strip>
    );
  }
  return null;
}

const STRIP = { neutral: "flash-neutral", warn: "flash-warn", error: "flash-error", success: "flash-success" } as const;

function Strip({ tone, icon, children }: { readonly tone: keyof typeof STRIP; readonly icon?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className={cx("flash flash-full flex shrink-0 items-center gap-2 border-t-0 px-4 py-2 text-sm", STRIP[tone])} role="status">
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
