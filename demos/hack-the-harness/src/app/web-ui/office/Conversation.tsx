import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChatContainerContent, ChatContainerRoot } from "../components/ui/chat-container";
import { atComputer, type Npc } from "./Office";
import type { SessionInfo } from "@managed-copilot/sdk";
import type { SessionEvent } from "@github/copilot-sdk";
import { Download, FileText, Loader2, Paperclip, Send, Square } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import type { useSessions } from "../hooks/useSessions";
import { request } from "../lib/api";
import { toAttachment } from "../lib/attachments";
import { timeline } from "../lib/timeline";
import { fileColor } from "./Files";
import { groupSteps, Steps } from "../components/steps";

export type Sessions = ReturnType<typeof useSessions>;

// Each NPC keeps the same session across visits, so its conversation is also in the normal chat list.
const STORAGE_KEY = "officeSessions";

function storedIds(): Record<string, string> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

export async function npcSession(name: string, data: Sessions): Promise<string> {
  const ids = storedIds();
  const existing = ids[name];

  // Only reuse a session that was made for this character.
  if (existing?.includes(`-npc-${name}-`) && data.sessions.some(session => session.id === existing)) {
    return existing;
  }

  const session = await request<SessionInfo>("/api/sessions", "POST", { npc: name });
  data.setSessions(previous => [session, ...previous]);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...ids, [name]: session.id }));
  return session.id;
}

/** Deletes the NPC's session, so they start afresh next time. */
export async function forgetNpc(name: string, sessionId: string, data: Sessions) {
  await request(`/api/sessions/${sessionId}`, "DELETE");
  data.setSessions(previous => previous.filter(session => session.id !== sessionId));
  const { [name]: _, ...rest } = storedIds();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
}

const FORGOTTEN_LINES = [
  "I just forgot everything I know!",
  "My mind just went blank!",
  "Wait… who are you again?",
  "Huh. What was I doing?",
  "Everything's gone. Like a fresh install.",
  "Sorry, have we met?",
];

export function forgottenLine() {
  return FORGOTTEN_LINES[Math.floor(Math.random() * FORGOTTEN_LINES.length)];
}

export function isBusy(data: Sessions, id: string | null) {
  const state = data.sessions.find(session => session.id === id)?.state;
  return state === "running" || state === "waiting";
}

/** A thought bubble, or a speech bubble when `speech` is set. `at` restarts the fade for a repeated line. */
export type Thought = { text: string; done: boolean; speech?: boolean; at?: number };

/** The NPC's latest reasoning in the current turn, and whether they have since moved on to acting or replying. */
export function currentThought(events: SessionEvent[]): Thought | null {
  let id: string | null = null;
  let text = "";
  let done = false;

  for (const event of events) {
    if (event.type === "user.message") {
      id = null;
      text = "";
    } else if (event.type === "assistant.reasoning_delta") {
      if (event.data.reasoningId !== id) {
        id = event.data.reasoningId;
        text = "";
      }
      text += event.data.deltaContent;
      done = false;
    } else if (event.type === "assistant.reasoning") {
      id = event.data.reasoningId;
      text = event.data.content;
    } else if (event.type === "assistant.message_delta" || event.type === "assistant.message" || event.type === "tool.execution_start") {
      done = true;
    }
  }

  return text.trim() ? { text: text.trim(), done } : null;
}

const EDGE = "linear-gradient(to {d}, transparent, black 2rem, black calc(100% - 2rem), transparent)";
const FADE_EDGES = {
  maskImage: `${EDGE.replace("{d}", "right")}, ${EDGE.replace("{d}", "bottom")}`,
  maskComposite: "intersect",
} as const;

/** A text-message style conversation with an NPC, overlaid on the right half of the office. Escape ends it. */
type ChatPanelProps = {
  npc: Npc;
  data: Sessions;
  sessionId: string | null;
  error: string | null;
  onEnd: () => void;
  /** Files the player has picked up, which go with the next message. */
  carrying: File[];
  onSent: (files: File[]) => void;
};

export function ChatPanel({ npc, data, sessionId, error: startError, onEnd, carrying, onSent }: ChatPanelProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = isBusy(data, sessionId);
  const items = sessionId ? groupSteps(timeline(data.events[sessionId] ?? [])) : [];
  const last = items.at(-1);
  const replying = !busy || (last?.kind === "assistant" && last.content.trim() !== "");
  const toolCount = items.reduce((count, item) => count + (item.kind === "steps" ? item.tools.length : item.kind === "tool" ? 1 : 0), 0);
  const seenTools = useRef(toolCount);

  // A new tool call swivels the NPC to their computer; they turn back once they reply (after at least a second).
  useEffect(() => {
    if (busy && toolCount > seenTools.current) {
      atComputer[npc.name] = { since: performance.now(), replying: false };
    }
    seenTools.current = toolCount;
    if (atComputer[npc.name] && replying) {
      atComputer[npc.name].replying = true;
    }
  });
  async function send() {
    const prompt = text.trim();

    if (!prompt || !sessionId || busy) {
      return;
    }

    setText("");
    setError(null);
    const files = carrying;
    try {
      await request(`/api/sessions/${sessionId}/messages`, "POST", { prompt, attachments: await Promise.all(files.map(toAttachment)) });
      onSent(files);
    } catch (error) {
      setError((error as Error).message);
      setText(prompt);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.currentTarget.blur();
      onEnd();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void send();
    }
  }

  const shownError = error ?? startError;

  return (
    <div className="absolute bottom-4 right-4 top-16 z-20 flex w-[calc(50%-2rem)] flex-col">
      <div aria-hidden className="absolute -inset-4 -z-10 bg-white/10 backdrop-blur-md" style={FADE_EDGES} />
      <ChatContainerRoot className="relative min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [&>div]:[scrollbar-color:rgba(255,255,255,0.35)_transparent] [&>div]:[scrollbar-width:thin]">
        <ChatContainerContent className="min-h-full gap-2 px-4 py-8">
        {!sessionId && !shownError && (
          <div className="m-auto flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Connecting…</div>
        )}
        {items.map(item => {
          if (item.kind === "tool") {
            const path = String(item.input.path);
            const name = path.split("/").pop() ?? path;
            return (
              <a
                key={item.id}
                href={`/api/sessions/${sessionId}/files?${new URLSearchParams(item.input as Record<string, string>)}`}
                download
                className="group flex max-w-[80%] items-center gap-3 self-start rounded-2xl bg-slate-300 p-2 pr-3 text-sm text-black animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-[0_6px_20px_rgba(0,0,0,0.55)]"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: fileColor(name) }}>
                  <FileText className="size-5" />
                </div>
                <span className="min-w-0 truncate font-medium">{name}</span>
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-slate-600 transition-colors group-hover:bg-green-600 group-hover:text-white">
                  <Download className="size-4" />
                </div>
              </a>
            );
          }

          if (item.kind === "steps") {
            return (
              <div key={item.id} className="max-w-[80%] self-start rounded-2xl bg-slate-900/75 animate-in fade-in slide-in-from-bottom-2 duration-300 px-4 py-2 text-white/80 shadow-[0_6px_20px_rgba(0,0,0,0.55)] [&_*]:border-white/20 [&>*]:text-inherit [&_button:hover]:text-white">
                <Steps tools={item.tools} />
              </div>
            );
          }

          if (item.kind === "error") {
            return <div key={item.id} role="alert" className="text-center text-xs text-destructive">{item.content}</div>;
          }

          if (!item.content.trim()) {
            return null;
          }

          const mine = item.kind === "user";
          return (
            <div
              key={item.id}
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-[0_6px_20px_rgba(0,0,0,0.55)] ${mine ? "self-end rounded-br-md bg-[#0b84ff] text-white" : "self-start rounded-bl-md bg-white text-black"}`}
            >
              {item.attachments?.map((name, index) => (
                <div key={index} className="mb-1 flex items-center gap-1 text-xs opacity-90"><Paperclip className="size-3" /> {name}</div>
              ))}
              <Markdown className={`prose prose-sm max-w-none break-words text-inherit [&_:not(a)]:text-inherit ${mine ? "[&_.font-mono]:bg-white/20" : ""}`}>{item.content}</Markdown>
            </div>
          );
        })}
        {busy && !(last?.kind === "assistant" && last.content.trim()) && (
          <div className="self-start rounded-2xl rounded-bl-md bg-white px-3 py-2 text-sm text-black animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-[0_6px_20px_rgba(0,0,0,0.55)]">…</div>
        )}
        </ChatContainerContent>
      </ChatContainerRoot>

      <div className="p-3">
        {carrying.length > 0 && (
          <div aria-label="Attached files" className="mb-2 flex flex-wrap justify-end gap-1.5">
            {carrying.map((file, index) => (
              <div key={index} className="flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white"><Paperclip className="size-3" /> {file.name}</div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            autoFocus
            className="min-w-0 flex-1 rounded-full border bg-background px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={`Speak to ${npc.name} · Esc to leave`}
            value={text}
            onChange={event => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button type="button" title="Stop" aria-label="Stop" className="rounded-full border px-3" onClick={() => void request(`/api/sessions/${sessionId}/cancel`, "POST")}>
              <Square className="size-4" />
            </button>
          ) : (
            <button type="button" title="Send" aria-label="Send" className="rounded-full bg-[#0b84ff] px-3 text-white disabled:opacity-40" disabled={!text.trim() || !sessionId} onClick={() => void send()}>
              <Send className="size-4" />
            </button>
          )}
        </div>
        {shownError && <div role="alert" className="mt-2 text-xs text-destructive">{shownError}</div>}
      </div>
    </div>
  );
}
