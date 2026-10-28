import { AlertIcon, CopilotIcon, HourglassIcon, ShieldIcon, TerminalIcon, ZapIcon } from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Blueprint, ChatMessage, ConversationView } from "../../shared/types.js";
import { handlingTime } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { between, formatClock, formatDuration } from "../lib/format.js";
import { homeHref, navigate } from "../lib/router.js";
import { dismissOutgoing, sendMessage, setApprovals, setDraft, useStore, type Outgoing } from "../lib/store.js";
import { STYLE_META } from "../lib/styles.js";
import { useNow } from "../lib/useNow.js";
import { CommandsCard } from "./Commands.js";
import { Composer } from "./Composer.js";
import { ApprovalCard, DecisionCard } from "./Decisions.js";
import { StyleChoice } from "./Home.js";
import { MarkdownView } from "./Markdown.js";
import { Callout } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";

const NO_OUTGOING: readonly Outgoing[] = [];

export function Chat({ view, blueprints }: { readonly view: ConversationView; readonly blueprints: readonly Blueprint[] }) {
  const outgoing = useStore((state) => state.outgoing[view.id] ?? NO_OUTGOING);
  const live = view.busy || view.approvals.length > 0 || outgoing.length > 0;
  const now = useNow(live);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastUser = [...view.messages].reverse().find((message) => message.role === "user");
  const sandboxApprovals = view.approvals.filter((approval) => approval.kind !== "command");

  // Follow new content while the person is at the bottom; leave them be when they scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-2 sm:px-6"
        aria-live="polite"
        aria-busy={view.busy}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {view.messages.map((message) => (
            <MessageItem key={message.id} view={view} message={message} current={view.busy && message.id === lastUser?.id} now={now} />
          ))}
          {outgoing.map((item) => (
            <OutgoingItem key={item.key} conversationId={view.id} item={item} />
          ))}
          <ApprovalCard conversationId={view.id} approvals={sandboxApprovals} blueprints={blueprints} now={now} />
          <WorkingRow view={view} now={now} />
        </div>
      </div>
      <ChatComposer view={view} />
    </div>
  );
}

function MessageItem({ view, message, current, now }: { readonly view: ConversationView; readonly message: ChatMessage; readonly current: boolean; readonly now: number }) {
  if (message.role === "user") {
    const decisions = message.decisions ?? [];
    const commands = message.commands ?? [];
    const subagents = message.subagents ?? [];
    const took = formatDuration(handlingTime(message.at, [...decisions, ...commands, ...subagents], now, current));
    return (
      <>
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[86%] rounded-xl border border-line-muted bg-canvas-muted px-3 py-2 text-sm whitespace-pre-wrap">{message.content}</div>
          <div className="flex items-center gap-1.5 text-xs text-fg-muted">
            {message.index !== undefined ? <span className="font-semibold">#{message.index}</span> : null}
            <span>{formatClock(message.at)}</span>
            {message.via === "other" ? (
              <span className="Label Label--secondary" title="Sent from another client of this session, such as Copilot CLI">
                <TerminalIcon size={12} />
                from Copilot CLI
              </span>
            ) : (
              <span>· from Dispatch</span>
            )}
            {message.delivery ? <span title="Sent while the agent was working; it answered between steps">· while it worked</span> : null}
          </div>
        </div>
        {decisions.length ? <DecisionCard decisions={decisions} took={took} now={now} /> : null}
        {commands.length || subagents.length ? <CommandsCard view={view} commands={commands} subagents={subagents} now={now} {...(decisions.length ? {} : { took })} /> : null}
      </>
    );
  }
  if (message.role === "notice") {
    return (
      <Callout tone={message.tone === "danger" ? "danger" : "warning"} compact>
        {message.content}
      </Callout>
    );
  }
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5">
      <span className="grid size-7 place-items-center rounded-full border border-line bg-canvas" aria-hidden>
        <CopilotIcon size={16} />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-sm font-semibold">
          Coordinator <span className="text-xs font-normal text-fg-muted">{formatClock(message.at)}</span>
        </div>
        <MarkdownView source={message.content} streaming={message.streaming === true} className="mt-0.5" />
      </div>
    </div>
  );
}

function OutgoingItem({ conversationId, item }: { readonly conversationId: string; readonly item: Outgoing }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={cx("max-w-[86%] rounded-xl border px-3 py-2 text-sm whitespace-pre-wrap", item.failed ? "border-[var(--borderColor-danger-emphasis)]" : "border-line-muted bg-canvas-muted opacity-70")}>{item.text}</div>
      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
        {item.failed ? (
          <>
            <AlertIcon size={12} className="text-fg-danger" />
            <span className="text-fg-danger">{item.failed}</span>
            <button type="button" className="Link--muted underline" onClick={() => dismissOutgoing(conversationId, item.key)}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            <Spinner size={12} />
            Sending…
          </>
        )}
      </div>
    </div>
  );
}

function WorkingRow({ view, now }: { readonly view: ConversationView; readonly now: number }) {
  if (!view.busy) return null;
  const streaming = view.messages.at(-1)?.streaming === true;
  if (view.approvals.length > 0 || streaming) return null;
  if (view.waiting) {
    const names = view.waiting.workers.length ? view.waiting.workers.join(", ") : "its workers";
    return (
      <div role="status" className="flex flex-col gap-0.5 pl-9 text-sm text-fg-muted">
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <HourglassIcon size={14} />
          Waiting for <strong className="font-semibold text-fg">{names}</strong>
          <span className="font-mono tabular-nums">{formatDuration(between(view.waiting.since, undefined, now))}</span>
        </span>
        <span className="text-xs">No model time while it waits. Ask anything: it answers right away, then keeps waiting.</span>
      </div>
    );
  }
  const working = [...view.messages].reverse().find((message) => message.role === "user");
  const hands = working?.commands?.some((command) => command.status === "running") || working?.subagents?.some((subagent) => subagent.status === "running");
  return (
    <div role="status" className="flex items-center gap-2 pl-9 text-sm text-fg-muted">
      <Spinner size={14} className="text-fg-accent" />
      {hands ? "Working in its sandbox…" : view.style === "direct" ? "Working…" : "Deciding what to do…"}
    </div>
  );
}

function ChatComposer({ view }: { readonly view: ConversationView }) {
  const platform = useStore((state) => state.platform);
  const styles = useStore((state) => state.styles);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const unavailable = view.problem ?? (platform?.state !== "connected" ? (platform?.message ?? "Managed Copilot isn't connected.") : undefined);
  const ask = view.settings.approvals === "ask";
  const labels = STYLE_META[view.style].approvals;

  useEffect(() => setText(""), [view.id]);

  const submit = async (): Promise<void> => {
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
        {unavailable ? (
          <Callout tone="warning" compact className="mb-2">
            {unavailable}
          </Callout>
        ) : null}
        <Composer
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          label="Message the agent"
          placeholder={view.busy ? "Ask while it works: it answers right away, then keeps going…" : "Ask a follow-up…"}
          sending={sending}
          disabled={Boolean(unavailable)}
          minRows={1}
          footer={
            <>
              <StyleChoice
                value={view.style}
                styles={styles}
                onChange={(style) => {
                  if (style === view.style) return;
                  // A conversation keeps its style: another style starts a new conversation, with this message.
                  setDraft({ style, text });
                  navigate(homeHref());
                }}
              />
              <button
                type="button"
                className="btn btn-invisible btn-sm m-0 shrink-0 gap-1 px-1.5 text-xs font-normal whitespace-nowrap text-fg-muted"
                onClick={() => void setApprovals(view.id, ask ? "auto" : "ask")}
                title={`${ask ? labels.auto.title : labels.ask.title}. Click to switch.${view.style === "delegate" ? " Work sent to sandboxes it already has never asks." : ""}`}
                aria-label={`${ask ? labels.ask.state : labels.auto.state}. Switch to: ${ask ? labels.auto.label : labels.ask.label}`}
              >
                {ask ? <ShieldIcon size={14} /> : <ZapIcon size={14} className="text-fg-attention" />}
                {ask ? labels.ask.state : labels.auto.state}
              </button>
            </>
          }
        />
        <p className="mt-1 px-1 text-xs text-fg-muted">This conversation keeps its style. Picking another starts a new conversation with your message.</p>
      </div>
    </div>
  );
}
