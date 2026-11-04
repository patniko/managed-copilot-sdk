import { AlertIcon, CheckIcon, CloudIcon, CopilotIcon, LightBulbIcon, SearchIcon, TrashIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChatItem, ConversationView as View, UserView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { clock } from "../lib/format.js";
import { navigate } from "../lib/router.js";
import { dismissOutgoing, openConversation, sendMessage, stopConversation, useStore, type Outgoing } from "../lib/store.js";
import { Composer } from "./Composer.js";
import { MarkdownView } from "./Markdown.js";
import { Avatar, Callout, Spinner } from "./ui/index.js";

const NO_OUTGOING: readonly Outgoing[] = [];

export function ConversationPage({ id, user }: { readonly id: string; readonly user: UserView }) {
  const view = useStore((state) => state.views[id]);
  const error = useStore((state) => state.viewErrors[id]);
  const loaded = view && "items" in view;

  useEffect(() => {
    void openConversation(id);
  }, [id]);

  if (error && !loaded) {
    const gone = error.code === "not_found" || error.code === "gone";
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-16">
        <Callout
          tone={gone ? "warning" : "danger"}
          title={gone ? "This conversation isn't available" : "Couldn't open this conversation"}
          actions={
            gone ? (
              <button type="button" className="btn btn-sm" onClick={() => navigate("/")}>
                Start a new one
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void openConversation(id)}>
                Try again
              </button>
            )
          }
        >
          {error.message}
        </Callout>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6" aria-busy>
        <div className="SkeletonText ml-auto w-1/3" />
        <div className="SkeletonText w-3/4" />
        <div className="SkeletonText w-2/3" />
        <span className="sr-only">Loading the conversation…</span>
      </div>
    );
  }
  return <Chat view={view} user={user} />;
}

function Chat({ view, user }: { readonly view: View; readonly user: UserView }) {
  const outgoing = useStore((state) => state.outgoing[view.id] ?? NO_OUTGOING);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  const streaming = view.items.at(-1)?.kind === "assistant" && (view.items.at(-1) as Extract<ChatItem, { kind: "assistant" }>).streaming;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line-muted px-4 py-2.5 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{view.title}</h1>
          <RouteLabel view={view} />
        </div>
      </div>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-2 sm:px-6"
        aria-live="polite"
        aria-busy={view.busy}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {view.items.map((item) => (
            <Item key={item.id} item={item} user={user} />
          ))}
          {outgoing.map((item) => (
            <OutgoingItem key={item.key} conversationId={view.id} item={item} user={user} />
          ))}
          {view.busy && !streaming && outgoing.every((item) => item.failed) ? (
            <div role="status" className="flex items-center gap-2 pl-10 text-sm text-fg-muted">
              <Spinner size={14} className="text-fg-accent" />
              Thinking…
            </div>
          ) : null}
        </div>
      </div>
      <ChatComposer view={view} user={user} />
    </div>
  );
}

function RouteLabel({ view }: { readonly view: View }) {
  const copilot = view.route === "copilot";
  return (
    <span
      className={cx("Label shrink-0 gap-1", copilot ? "Label--done" : "Label--accent")}
      title={copilot ? "This conversation's model use goes to your own Copilot plan." : "Front Desk pays for this conversation's model use through its Azure AI Foundry."}
    >
      {copilot ? <CopilotIcon size={12} /> : <CloudIcon size={12} />}
      <span className="max-sm:hidden">{copilot ? "Your Copilot plan" : "Azure AI Foundry"}</span>
      {view.model ? <span className="font-normal opacity-80 max-sm:hidden">· {view.model}</span> : null}
    </span>
  );
}

function UserBubble({ text, user, meta }: { readonly text: string; readonly user: UserView; readonly meta?: ReactNode }) {
  return (
    <div className="flex items-start justify-end gap-2.5">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        <div className="rounded-xl border border-line-muted bg-canvas-muted px-3.5 py-2 text-sm break-words whitespace-pre-wrap">{text}</div>
        {meta}
      </div>
      <Avatar name={user.name} {...(user.avatarUrl ? { src: user.avatarUrl } : {})} size={28} className="mt-0.5" />
    </div>
  );
}

function Item({ item, user }: { readonly item: ChatItem; readonly user: UserView }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} user={user} meta={<span className="text-xs text-fg-muted">{clock(item.at)}</span>} />;
    case "assistant":
      return (
        <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5">
          <span className="mt-0.5 grid size-7 place-items-center rounded-full border border-line bg-canvas" aria-hidden>
            <CopilotIcon size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 text-sm font-semibold">
              Front Desk <span className="text-xs font-normal text-fg-muted">{clock(item.at)}</span>
            </div>
            <MarkdownView source={item.text} streaming={item.streaming === true} className="mt-0.5" />
          </div>
        </div>
      );
    case "tool": {
      const Glyph = item.tool === "recall" ? SearchIcon : item.tool === "forget" ? TrashIcon : LightBulbIcon;
      return (
        <div className="flex items-center gap-2 pl-10 text-xs text-fg-muted">
          <span className={cx("inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1", item.status === "failed" ? "border-line-danger-muted text-fg-danger" : "border-line-muted bg-canvas")}>
            {item.status === "running" ? <Spinner size={12} /> : item.status === "failed" ? <AlertIcon size={12} /> : <Glyph size={12} className="text-fg-done" />}
            <span className="font-semibold text-fg">{item.label}</span>
            {item.detail ? <span className="truncate">“{item.detail}”</span> : null}
            {item.status === "done" ? <CheckIcon size={12} className="text-fg-success" /> : null}
          </span>
        </div>
      );
    }
    case "notice":
      return (
        <Callout tone={item.tone === "danger" ? "danger" : item.tone === "warning" ? "warning" : "info"} compact className="ml-10">
          {item.text}
        </Callout>
      );
  }
}

function OutgoingItem({ conversationId, item, user }: { readonly conversationId: string; readonly item: Outgoing; readonly user: UserView }) {
  return (
    <div className={cx(!item.failed && "opacity-70")}>
      <UserBubble
        text={item.text}
        user={user}
        meta={
          item.failed ? (
            <span className="flex items-center gap-1.5 text-xs text-fg-danger">
              <AlertIcon size={12} />
              {item.failed}
              <button type="button" className="btn-octicon" aria-label="Dismiss" onClick={() => dismissOutgoing(conversationId, item.key)}>
                <XIcon size={12} />
              </button>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Spinner size={12} />
              Sending…
            </span>
          )
        }
      />
    </div>
  );
}

function ChatComposer({ view, user }: { readonly view: View; readonly user: UserView }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const outOfMessages = user.billing.remainingToday === 0;

  useEffect(() => setText(""), [view.id]);

  const submit = async () => {
    const prompt = text;
    setSending(true);
    setText("");
    const sent = await sendMessage(view.id, prompt);
    setSending(false);
    if (!sent) setText((current) => current || prompt);
  };

  return (
    <div className="shrink-0 px-4 pb-4 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {outOfMessages ? (
          <Callout tone="warning" compact className="mb-2">
            You've used today's {user.billing.dailyLimit} messages. Your allowance starts again at midnight UTC.
          </Callout>
        ) : null}
        <Composer
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          {...(view.busy ? { onStop: () => void stopConversation(view.id) } : {})}
          label="Message Front Desk"
          placeholder={view.busy ? "Front Desk is answering…" : "Reply to Front Desk…"}
          sending={sending}
          disabled={outOfMessages}
          minRows={1}
          footer={
            <span className="inline-flex items-center gap-1">
              {view.route === "copilot" ? <CopilotIcon size={12} /> : <CloudIcon size={12} />}
              {view.route === "copilot" ? "Uses your Copilot plan" : "Front Desk pays"}
              {user.billing.remainingToday !== undefined ? ` · ${user.billing.remainingToday} of ${user.billing.dailyLimit} messages left today` : ""}
            </span>
          }
        />
      </div>
    </div>
  );
}
