import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard.js";
import { cx } from "../../lib/cx.js";
import { toast } from "../../lib/toast.js";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./Button.js";

export interface CopyButtonProps {
  readonly text: string;
  /** Accessible name, e.g. "Copy session id". */
  readonly label: string;
  /** Visible text; omit for an icon-only button. */
  readonly children?: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
}

export function CopyButton({ text, label, children, variant = "ghost", size = "xs", className }: CopyButtonProps) {
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

  const Icon = copied ? Check : Copy;
  const iconOnly = !children;
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={iconOnly ? label : undefined}
      title={label}
      className={cx(
        buttonClass(variant, size),
        iconOnly && (size === "xs" ? "w-6 px-0" : "w-7 px-0"),
        copied && "text-emerald-300 hover:text-emerald-300",
        className,
      )}
    >
      <Icon className={size === "xs" ? "size-3" : "size-3.5"} aria-hidden />
      {children ? <span>{copied ? "Copied" : children}</span> : null}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
