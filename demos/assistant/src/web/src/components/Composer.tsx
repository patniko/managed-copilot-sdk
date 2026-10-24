import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface ComposerProps {
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** Text to place in the box (e.g. from a suggestion), with a nonce so the same text can be set twice. */
  draft?: { text: string; nonce: number };
}

export function Composer({ disabled, disabledReason, busy, onSend, onStop, draft }: ComposerProps) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    area.current?.focus();
  }, [draft]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-6">
      <div className="card flex items-end gap-2 p-2 focus-within:ring-violet-400 dark:focus-within:ring-violet-500/60">
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? (disabledReason ?? "Connecting…") : "Message your assistant…"}
          aria-label="Message your assistant"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] leading-relaxed outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed"
        />
        {busy && (
          <button type="button" onClick={onStop} className="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700" aria-label="Stop">
            <Square className="size-3.5 fill-current" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-600 text-white shadow-sm transition-colors hover:bg-violet-700 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
          aria-label="Send"
        >
          <ArrowUp className="size-4.5" strokeWidth={2.4} aria-hidden />
        </button>
      </div>
      <div className="mt-2 hidden justify-center gap-3 text-[11px] text-zinc-400 sm:flex">
        <span>
          <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span> + <span className="kbd">Enter</span> for a new line
        </span>
        <span>·</span>
        <span>Sending mail and changing your calendar always asks you first</span>
      </div>
    </div>
  );
}
