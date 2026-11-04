import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard.js";
import { cx } from "../../lib/cx.js";
import { toast } from "../../lib/toast.js";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./Button.js";

export interface CopyButtonProps {
  readonly text: string;
  /** Accessible name, e.g. "Copy session ID". */
  readonly label: string;
  /** Visible text; omit for an icon-only button. */
  readonly children?: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
}

/** GitHub's clipboard button: a CopyIcon that turns into a green check once copied. */
export function CopyButton({ text, label, children, variant = "default", size = "sm", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async (): Promise<void> => {
    const ok = await copyText(text);
    if (!ok) {
      toast.error("Couldn't copy to the clipboard", "Select the text and copy it manually.");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  const iconOnly = !children;
  const StateIcon = copied ? CheckIcon : CopyIcon;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void onCopy();
      }}
      aria-label={iconOnly ? label : undefined}
      title={label}
      className={iconOnly ? cx("btn-octicon", className) : buttonClass(variant, size, className)}
    >
      <StateIcon size={16} className={copied ? "text-fg-success" : undefined} />
      {children ? <span>{copied ? "Copied!" : children}</span> : null}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
