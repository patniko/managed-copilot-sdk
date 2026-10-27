import { PaperAirplaneIcon } from "@primer/octicons-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Spinner } from "./ui/Spinner.js";

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly placeholder: string;
  readonly label: string;
  /** Sending: the text stays, the button spins. */
  readonly sending?: boolean;
  readonly disabled?: boolean;
  /** Under the text, left of the send button. */
  readonly footer?: ReactNode;
  readonly autoFocus?: boolean;
  readonly minRows?: number;
  readonly className?: string;
}

export interface ComposerHandle {
  focus(): void;
}

/** The message box: Enter sends, Shift+Enter starts a new line; it grows with the text. */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, onChange, onSubmit, placeholder, label, sending = false, disabled = false, footer, autoFocus = false, minRows = 2, className },
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

  const canSend = value.trim().length > 0 && !sending && !disabled;
  return (
    <form
      className={cx(
        "rounded-xl border border-line bg-canvas px-3 pt-2.5 pb-2 shadow-sm transition-shadow focus-within:border-[var(--borderColor-accent-emphasis)] focus-within:shadow-[0_0_0_1px_var(--borderColor-accent-emphasis)]",
        className,
      )}
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
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{footer}</div>
        <button type="submit" disabled={!canSend} aria-label="Send" title="Send (Enter)" className={cx("btn btn-sm shrink-0", canSend && "btn-primary")}>
          {sending ? <Spinner size={16} /> : <PaperAirplaneIcon size={16} />}
        </button>
      </div>
    </form>
  );
});
