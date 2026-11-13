import { CopilotIcon, DotFillIcon, PaperAirplaneIcon, PaperclipIcon, PlugIcon } from "@primer/octicons-react";
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { TicketStatus, TranscriptItem } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { customerLine, inlineMarkdown } from "../lib/format.js";
import { TONE_TEXT } from "./ui/Status.js";

/**
 * Contoso Outdoors' support widget, as the customer or player sees it: the conversation as it streams in, what the agent
 * did in a word, and a box to write in. The wall shows it next to what happened behind it; a player's chat page is
 * nothing else.
 */
export function ChatWidget({
  label,
  subtitle,
  avatar,
  greeting,
  items,
  status,
  ended = false,
  notice,
  composer,
  className,
}: {
  /** For assistive technology: whose chat this is. */
  readonly label: string;
  /** Under "Contoso Outdoors": "Support", or "Downhill Shop support". */
  readonly subtitle: string;
  /** The person's avatar, at the right of the header. */
  readonly avatar?: ReactNode;
  /** A fixed first line from support, shown before anyone writes (not part of the conversation). */
  readonly greeting?: string;
  readonly items: readonly TranscriptItem[];
  readonly status: TicketStatus;
  /** The conversation is over: no one is typing anymore. */
  readonly ended?: boolean;
  /** A line under the header: what the chat waits for, or why it can't go on. */
  readonly notice?: ReactNode;
  readonly composer?: ReactNode;
  /** Its size and elevation. */
  readonly className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = items.at(-1);
  const typing = !ended && (status === "answering" || status === "starting") && !(last?.kind === "message" && last.from === "agent" && last.streaming);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [items, typing]);
  return (
    <section aria-label={label} className={cx("Box flex flex-col overflow-hidden", className)}>
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-display-green-emphasis text-sm font-semibold text-fg-on-emphasis" aria-hidden>
          C
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Contoso Outdoors</div>
          <div className="flex items-center gap-1 text-xs text-fg-muted">
            <DotFillIcon size={12} className="text-fg-success" />
            <span className="truncate">{subtitle}</span>
          </div>
        </div>
        {avatar}
      </header>
      {notice}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        <ol className="flex flex-col gap-2">
          {greeting ? (
            <AgentBubble>
              <span>{greeting}</span>
            </AgentBubble>
          ) : null}
          {items.map((item) => {
            if (item.kind === "message") {
              // The team's notes to the agent are internal: the customer never sees them.
              if (item.from === "team") return null;
              return item.from === "customer" ? (
                <li key={item.id} className="flex flex-col items-end gap-1">
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent-emphasis px-3 py-2 text-sm whitespace-pre-wrap text-fg-on-emphasis">{item.text}</div>
                  {item.attachment ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                      <PaperclipIcon size={12} />
                      {item.attachment}
                    </span>
                  ) : null}
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
              <li key={item.id} className={cx("flex items-center justify-center gap-1 py-0.5 text-center text-xs", TONE_TEXT[line.tone])}>
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
      {composer}
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

/** The box to write in. `onSend` says whether the message went out (the text is kept when it didn't). */
export function Composer({
  placeholder,
  label,
  disabled,
  onSend,
}: {
  readonly placeholder: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    if (await onSend(message)) setText("");
    setSending(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex shrink-0 items-center gap-2 border-t border-line p-2">
      <input
        className="form-control min-w-0 flex-1"
        placeholder={placeholder}
        aria-label={label}
        value={text}
        maxLength={2_000}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="btn btn-primary btn-icon" aria-label="Send" disabled={disabled || sending || !text.trim()}>
        <PaperAirplaneIcon size={16} />
      </button>
    </form>
  );
}
