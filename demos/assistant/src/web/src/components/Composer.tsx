import { PaperAirplaneIcon, ShieldIcon, SquareFillIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { cx } from "./ui";

export interface ComposerProps {
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  /** What always asks first, shown under the message box. */
  hint?: string;
  onSend(text: string): void;
  onStop(): void;
  /** Text to place in the box (e.g. from a suggestion), with a nonce so the same text can be set twice. */
  draft?: { text: string; nonce: number };
}

/** The message box, like Copilot Chat's on github.com: a bordered field with a toolbar and a send button. */
export function Composer({ disabled, disabledReason, busy, hint = "Sending mail and changing your calendar always asks you first", onSend, onStop, draft }: ComposerProps) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const ready = !disabled && text.trim().length > 0;

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
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, [text]);

  /** Clicking the frame or toolbar (not a button) focuses the message box, like Copilot Chat. */
  const focusBox = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    area.current?.focus();
  };

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4 md:px-6 md:pb-5">
      <div
        className={cx(
          "rounded-lg border border-line transition-[border-color,box-shadow] duration-100 focus-within:border-line-accent focus-within:ring-1 focus-within:ring-line-accent",
          disabled ? "bg-canvas-disabled" : "bg-canvas",
        )}
        onMouseDown={focusBox}
      >
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
          // The frame shows focus (accent border and ring), so the field itself draws no second outline.
          className="block max-h-[200px] min-h-11 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-base leading-normal outline-none focus-visible:outline-none disabled:cursor-not-allowed sm:text-sm"
        />
        <div className="flex items-center gap-2 px-2 pb-2" onMouseDown={focusBox}>
          <span className="ml-1 hidden min-w-0 items-center gap-1.5 truncate text-xs text-fg-muted sm:inline-flex">
            <ShieldIcon size={12} />
            <span className="truncate">{hint}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            {busy && (
              <button type="button" onClick={onStop} className="btn btn-sm btn-icon btn-invisible" aria-label="Stop" title="Stop">
                <SquareFillIcon />
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!ready}
              className={cx("btn btn-sm btn-icon", ready ? "btn-primary" : "btn-invisible")}
              aria-label="Send"
              title="Send"
            >
              <PaperAirplaneIcon />
            </button>
          </div>
        </div>
      </div>
      <div className="mt-2 hidden justify-center text-xs text-fg-muted sm:flex">
        <span>
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
        </span>
      </div>
    </div>
  );
}
