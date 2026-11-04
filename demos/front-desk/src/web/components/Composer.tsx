import { PaperAirplaneIcon, SquareFillIcon } from "@primer/octicons-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { LIMITS } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { Spinner } from "./ui/index.js";

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** While an answer is being written: the send button becomes a stop button. */
  readonly onStop?: () => void;
  readonly placeholder: string;
  readonly label: string;
  readonly sending?: boolean;
  readonly disabled?: boolean;
  readonly footer?: ReactNode;
  readonly autoFocus?: boolean;
  readonly minRows?: number;
}

export interface ComposerHandle {
  focus(): void;
}

/** The message box: Enter sends, Shift+Enter starts a new line; it grows with the text. */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, onChange, onSubmit, onStop, placeholder, label, sending = false, disabled = false, footer, autoFocus = false, minRows = 2 },
  ref,
) {
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
  }, [value]);

  const tooLong = value.length > LIMITS.prompt;
  const canSend = value.trim().length > 0 && !sending && !disabled && !tooLong && !onStop;
  return (
    <form
      className="rounded-xl border border-line bg-canvas px-3 pt-2.5 pb-2 shadow-sm transition-shadow focus-within:border-[var(--borderColor-accent-emphasis)] focus-within:shadow-[0_0_0_1px_var(--borderColor-accent-emphasis)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <textarea
        ref={area}
        value={value}
        rows={minRows}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={LIMITS.prompt + 1_000}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        className="block w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed"
      />
      <div className="mt-1.5 flex min-h-8 items-center gap-3 text-xs text-fg-muted">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {tooLong ? <span className="text-fg-danger">Keep messages under {LIMITS.prompt.toLocaleString()} characters.</span> : footer}
        </div>
        {onStop ? (
          <button type="button" onClick={onStop} aria-label="Stop answering" title="Stop" className="btn btn-sm shrink-0">
            <SquareFillIcon size={12} />
          </button>
        ) : (
          <button type="submit" disabled={!canSend} aria-label="Send" title="Send (Enter)" className={cx("btn btn-sm shrink-0", canSend && "btn-primary")}>
            {sending ? <Spinner size={16} /> : <PaperAirplaneIcon size={16} />}
          </button>
        )}
      </div>
    </form>
  );
});
