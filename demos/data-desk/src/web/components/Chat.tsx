import {
  AlertIcon,
  CheckIcon,
  ContainerIcon,
  CopilotIcon,
  EyeIcon,
  FileIcon,
  PaperAirplaneIcon,
  PlugIcon,
  ShieldIcon,
  SquareFillIcon,
  TerminalIcon,
  ToolsIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AnalysisView, ChatItem, StepType } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatSeconds } from "../lib/format.js";
import { selectResult, useSelectedResult } from "../lib/selection.js";
import { answerMove, dismissOutgoing, sendMessage, stopTurn, useStore, type Outgoing } from "../lib/store.js";
import { FactoryLine } from "./Factory.js";
import { MarkdownView } from "./Markdown.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

type Step = Extract<ChatItem, { kind: "step" }>;

const STEP_ICON: Readonly<Record<StepType, Icon>> = { data: PlugIcon, move: ContainerIcon, shell: TerminalIcon, file: FileIcon, read: EyeIcon, other: ToolsIcon };
const NO_OUTGOING: readonly Outgoing[] = [];

/** The conversation side of the workspace. */
export function ChatPanel({ view, className }: { readonly view: AnalysisView; readonly className?: string }) {
  const outgoing = useStore((state) => state.outgoing[view.id]) ?? NO_OUTGOING;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const empty = view.items.length === 0 && outgoing.length === 0;

  // Follows new content while the reader is at the bottom; leaves them alone when they scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <section aria-label="Conversation" className={cx("flex min-h-0 flex-col bg-canvas", className)}>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {empty ? <Starters view={view} /> : <Transcript view={view} outgoing={outgoing} />}
      </div>
      {view.moveRequest ? <MoveCard view={view} /> : null}
      <Composer view={view} />
    </section>
  );
}

function Starters({ view }: { readonly view: AnalysisView }) {
  const prompts = view.dataset?.prompts ?? [];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-6 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-accent-muted text-fg-accent">
        <CopilotIcon size={24} />
      </span>
      <h2 className="text-lg font-semibold">Ask about {view.dataset?.name ?? "this data"}</h2>
      <div className="flex w-full max-w-sm flex-col gap-2">
        {prompts.map((prompt) => {
          const code = prompt.needs === "code";
          return (
            <button
              key={prompt.text}
              type="button"
              disabled={view.placement === "moving"}
              onClick={() => void sendMessage(view.id, prompt.text)}
              className="Box flex items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:border-line-accent focus-visible:border-line-accent"
            >
              <span className="min-w-0 flex-1">{prompt.text}</span>
              <Tooltip content={code ? "Needs code: moves into a sandbox" : "Data Desk's tools answer this on the shared runtime"}>
                <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", code ? "bg-done-muted text-fg-done" : "bg-accent-muted text-fg-accent")}>
                  {code ? <ContainerIcon size={16} /> : <PlugIcon size={16} />}
                </span>
              </Tooltip>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Consecutive steps render as one tight group under the message they serve. */
function groups(items: readonly ChatItem[]): (Exclude<ChatItem, Step> | Step[])[] {
  const out: (Exclude<ChatItem, Step> | Step[])[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind !== "step") out.push(item);
    else if (Array.isArray(last)) last.push(item);
    else out.push([item]);
  }
  return out;
}

function Transcript({ view, outgoing }: { readonly view: AnalysisView; readonly outgoing: readonly Outgoing[] }) {
  const selected = useSelectedResult(view.id);
  const last = view.items.at(-1);
  const working = view.busy && !(last?.kind === "assistant" && last.streaming) && !view.moveRequest && view.placement !== "moving";
  return (
    <ol className="flex flex-col gap-4">
      {groups(view.items).map((entry) =>
        Array.isArray(entry) ? (
          <li key={entry[0]!.id} className="flex flex-col gap-1 pl-8">
            {entry.map((step) => (
              <StepLine key={step.id} step={step} active={step.resultId !== undefined && step.resultId === selected} onShow={step.resultId ? () => selectResult(view.id, step.resultId) : undefined} />
            ))}
          </li>
        ) : (
          <li key={entry.id}>
            <Item item={entry} />
          </li>
        ),
      )}
      {outgoing.map((item) => (
        <li key={`outgoing-${item.key}`}>
          <UserBubble text={item.text} pending={!item.failed} />
          {item.failed ? (
            <p className="mt-1 flex items-center justify-end gap-1 text-xs text-fg-danger">
              <AlertIcon size={12} /> {item.failed}
              <button type="button" className="btn-octicon" aria-label="Dismiss" onClick={() => dismissOutgoing(view.id, item.key)}>
                <XIcon size={12} />
              </button>
            </p>
          ) : null}
        </li>
      ))}
      {working ? (
        <li className="flex items-center gap-2 pl-8 text-sm text-fg-muted" role="status">
          <Spinner size={16} /> Working…
        </li>
      ) : null}
    </ol>
  );
}

function Item({ item }: { readonly item: Exclude<ChatItem, Step> }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} via={item.via} />;
    case "assistant":
      return (
        <div className="flex gap-2">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-muted text-fg-accent">
            <CopilotIcon size={14} />
          </span>
          <MarkdownView source={item.text} streaming={item.streaming === true} className="min-w-0 flex-1" />
        </div>
      );
    case "moved":
      return (
        <div className="flex animate-fade-in items-center gap-2 text-xs font-semibold text-fg-done" role="note">
          <span className="h-px flex-1 bg-done-muted" />
          <Tooltip content={item.sandboxId ? `Sandbox ${item.sandboxId}` : "Its own sandbox"}>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line-done-muted bg-done-muted px-2.5 py-1" tabIndex={0}>
              <ContainerIcon size={14} />
              Moved into a sandbox{item.durationMs !== undefined ? ` · ${formatSeconds(item.durationMs)}` : ""}
            </span>
          </Tooltip>
          <span className="h-px flex-1 bg-done-muted" />
        </div>
      );
    case "factory":
      return <FactoryLine routing={item.routing} />;
    case "error":
      return (
        <div className="flash flash-error flash-sm flex items-start gap-2" role="alert">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{item.text}</span>
        </div>
      );
  }
}

function UserBubble({ text, via = "app", pending = false }: { readonly text: string; readonly via?: "app" | "cli"; readonly pending?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-1">
      {via === "cli" ? (
        <span className="flex items-center gap-1 text-xs text-fg-muted">
          <TerminalIcon size={12} /> Copilot CLI
        </span>
      ) : null}
      <div className={cx("max-w-[85%] rounded-lg bg-canvas-muted px-3 py-2 break-words whitespace-pre-wrap", pending && "opacity-70")}>{text}</div>
    </div>
  );
}

function StatusGlyph({ step }: { readonly step: Step }) {
  switch (step.status) {
    case "running":
      return <Spinner size={14} className={step.type === "move" ? "text-fg-done" : "text-fg-muted"} label={step.type === "move" ? "Moving" : "Running"} />;
    case "asking":
      return <ShieldIcon size={14} className="shrink-0 text-fg-attention" aria-label="Waiting for you" />;
    case "done":
      return <CheckIcon size={14} className="shrink-0 text-fg-success" aria-label="Done" />;
    case "declined":
      return <XIcon size={14} className="shrink-0 text-fg-muted" aria-label="Not now" />;
    case "failed":
      return <XIcon size={14} className="shrink-0 text-fg-danger" aria-label="Failed" />;
  }
}

function StepLine({ step, active, onShow }: { readonly step: Step; readonly active: boolean; readonly onShow: (() => void) | undefined }) {
  const Glyph = STEP_ICON[step.type];
  const label = step.type === "move" && step.status === "running" ? "Moving into a sandbox" : step.label;
  const body = (
    <>
      <StatusGlyph step={step} />
      <Glyph size={14} className={cx("shrink-0", step.type === "data" ? "text-fg-accent" : step.type === "move" ? "text-fg-done" : "text-fg-muted")} />
      <span className={cx("min-w-0 truncate", step.type === "shell" && !step.label.includes(" ") && "font-mono text-xs")}>{label}</span>
      {step.outcome ? <span className={cx("shrink-0 text-xs", step.status === "failed" ? "text-fg-danger" : "text-fg-muted")}>· {step.outcome}</span> : null}
    </>
  );
  const className = cx("flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm", active && "bg-accent-muted");
  const tip = step.detail && step.detail !== label ? step.detail : undefined;
  const line = onShow ? (
    <button type="button" onClick={onShow} className={cx(className, "w-full text-left hover:bg-canvas-muted")} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
  return tip ? (
    <Tooltip
      content={<span className={cx("block max-h-40 overflow-hidden text-left whitespace-pre-wrap", step.type !== "data" && step.type !== "move" && "font-mono text-xs")}>{tip.length > 400 ? `${tip.slice(0, 400)}…` : tip}</span>}
      className="w-full"
    >
      {line}
    </Tooltip>
  ) : (
    line
  );
}

/** The agent asked to move into a sandbox: the one decision on screen. */
function MoveCard({ view }: { readonly view: AnalysisView }) {
  const [answering, setAnswering] = useState<"move" | "stay" | undefined>();
  const request = view.moveRequest!;
  const answer = async (approve: boolean) => {
    setAnswering(approve ? "move" : "stay");
    await answerMove(view.id, approve);
    setAnswering(undefined);
  };
  return (
    <div className="shrink-0 border-t border-line-attention bg-attention-muted px-4 py-3 animate-slide-up" role="alertdialog" aria-labelledby="move-title" aria-describedby="move-reason">
      <div className="flex items-start gap-2">
        <ShieldIcon size={16} className="mt-0.5 shrink-0 text-fg-attention" />
        <div className="min-w-0 flex-1">
          <p id="move-title" className="font-semibold">
            Move into a sandbox?
          </p>
          <p id="move-reason" className="mt-0.5 line-clamp-2 text-sm text-fg-muted" title={request.reason}>
            {request.reason || "Copilot needs to run code."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 pl-6">
        <button type="button" className="btn btn-primary" disabled={answering !== undefined} onClick={() => void answer(true)}>
          {answering === "move" ? <Spinner size={16} /> : <ContainerIcon size={16} />}
          Move
        </button>
        <button type="button" className="btn" disabled={answering !== undefined} onClick={() => void answer(false)}>
          Not now
        </button>
      </div>
    </div>
  );
}

function Composer({ view }: { readonly view: AnalysisView }) {
  const [text, setText] = useState("");
  const [stopping, setStopping] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const blocked = view.moveRequest !== undefined || view.placement === "moving";
  const busy = view.busy;

  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  // Grows with its text, up to about six lines.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = text.trim();
    if (!prompt || busy || blocked) return;
    setText("");
    void sendMessage(view.id, prompt);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form onSubmit={submit} className="shrink-0 border-t border-line p-3">
      <div className="flex items-end gap-2 rounded-lg border border-line bg-canvas px-3 py-2 focus-within:border-line-accent focus-within:shadow-[0_0_0_1px_var(--borderColor-accent-emphasis)]">
        <label htmlFor="composer" className="sr-only">
          Ask about this data
        </label>
        <textarea
          id="composer"
          ref={input}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          placeholder={view.moveRequest ? "Waiting for your answer" : view.placement === "moving" ? "Moving into the sandbox…" : "Ask about this data"}
          disabled={blocked}
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent py-0.5 leading-6 outline-none placeholder:text-fg-muted disabled:cursor-not-allowed"
        />
        {busy ? (
          <button
            type="button"
            className="btn btn-sm shrink-0"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void stopTurn(view.id);
            }}
          >
            {stopping ? <Spinner size={16} /> : <SquareFillIcon size={16} />}
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-sm btn-primary shrink-0" aria-label="Send" disabled={!text.trim() || blocked}>
            <PaperAirplaneIcon size={16} />
          </button>
        )}
      </div>
    </form>
  );
}
