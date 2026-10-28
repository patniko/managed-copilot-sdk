import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard.js";
import { cx } from "../../lib/cx.js";
import { toast } from "../../lib/toast.js";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./Button.js";
import { Tooltip } from "./Tooltip.js";

export interface CopyButtonProps {
  readonly text: string;
  /** Accessible name and tooltip, e.g. "Copy session id". */
  readonly label: string;
  /** Visible text; omit for an icon-only button. */
  readonly children?: string;
  /** `octicon` is the bare icon button GitHub uses next to ids and in Box headers. */
  readonly variant?: ButtonVariant | "octicon";
  readonly size?: ButtonSize;
  readonly className?: string;
}

export function CopyButton({ text, label, children, variant = "octicon", size = "sm", className }: CopyButtonProps) {
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

  const Glyph = copied ? CheckIcon : CopyIcon;
  const iconOnly = !children;
  return (
    <Tooltip content={copied ? "Copied!" : label}>
      <button
        type="button"
        onClick={() => void onCopy()}
        aria-label={iconOnly ? label : undefined}
        className={cx(variant === "octicon" ? "btn-octicon" : buttonClass(variant, size, iconOnly ? "btn-icon" : undefined), className)}
      >
        <Glyph size={16} className={copied && variant !== "primary" ? "text-fg-success" : undefined} />
        {children ? <span>{copied ? "Copied" : children}</span> : null}
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </Tooltip>
  );
}
