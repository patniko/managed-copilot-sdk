import { CommentDiscussionIcon, LockIcon, PlusIcon, TrashIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import type { ConversationSummary } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { relativeTime } from "../lib/format.js";
import { conversationHref, navigate, useRoute } from "../lib/router.js";
import { deleteConversation, setSidebarOpen, useStore } from "../lib/store.js";
import { Spinner } from "./ui/index.js";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Row({ conversation, current, now }: { readonly conversation: ConversationSummary; readonly current: boolean; readonly now: number }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="group relative">
      <a
        href={conversationHref(conversation.id)}
        aria-current={current ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          setSidebarOpen(false);
          navigate(conversationHref(conversation.id));
        }}
        className={cx(
          "flex min-h-11 flex-col justify-center rounded-md px-2 py-1.5 pr-9 text-sm no-underline hover:bg-control-transparent-hover",
          current ? "bg-control-transparent-selected font-semibold text-fg" : "text-fg",
        )}
      >
        <span className="flex items-center gap-1.5">
          {conversation.busy ? <Spinner size={12} className="text-fg-accent" label="Answering" /> : null}
          <span className="truncate">{conversation.title}</span>
        </span>
        <span className="text-xs font-normal text-fg-muted">{relativeTime(conversation.updatedAt, now)}</span>
      </a>
      {confirming ? (
        <div className="absolute inset-y-0 right-1 flex items-center gap-1 rounded-md bg-canvas pl-1">
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => {
              setConfirming(false);
              void deleteConversation(conversation.id);
            }}
          >
            Delete
          </button>
          <button type="button" className="btn btn-sm btn-invisible" aria-label="Keep it" onClick={() => setConfirming(false)}>
            <XIcon size={16} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn-octicon btn-octicon-danger absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label={`Delete "${conversation.title}"`}
          onClick={() => setConfirming(true)}
        >
          <TrashIcon size={16} />
        </button>
      )}
    </li>
  );
}

export function Sidebar() {
  const conversations = useStore((state) => state.conversations);
  const loaded = useStore((state) => state.conversationsLoaded);
  const open = useStore((state) => state.sidebarOpen);
  const route = useRoute();
  const now = useNow();
  const currentId = route.page === "conversation" ? route.id : undefined;

  const panel = (
    <nav aria-label="Your conversations" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 p-3">
        <button
          type="button"
          className="btn btn-block justify-center"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/");
          }}
        >
          <PlusIcon size={16} />
          New conversation
        </button>
        <button type="button" className="btn btn-sm btn-invisible lg:hidden" aria-label="Close" onClick={() => setSidebarOpen(false)}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!loaded ? (
          <div className="flex flex-col gap-2 px-2 pt-1" aria-busy>
            {[0, 1, 2].map((index) => (
              <div key={index} className="SkeletonText" style={{ width: `${80 - index * 15}%` }} />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 pt-8 text-center text-sm text-fg-muted">
            <CommentDiscussionIcon size={24} />
            Your conversations show up here.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((conversation) => (
              <Row key={conversation.id} conversation={conversation} current={conversation.id === currentId} now={now} />
            ))}
          </ul>
        )}
      </div>
      <p className="flex shrink-0 items-start gap-1.5 border-t border-line-muted px-4 py-3 text-xs text-fg-muted">
        <LockIcon size={12} className="mt-0.5 shrink-0" />
        Only you can see your conversations and memory. Other people using Front Desk have their own.
      </p>
    </nav>
  );

  return (
    <>
      <aside className="hidden w-72 shrink-0 border-r border-line-muted bg-canvas-inset lg:block">{panel}</aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" className="absolute inset-0 bg-backdrop" aria-label="Close" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-80 max-w-[85vw] animate-slide-in-left border-r border-line bg-canvas shadow-xl">{panel}</aside>
        </div>
      ) : null}
    </>
  );
}
