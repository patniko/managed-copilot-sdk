import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { prettyJson } from "../../lib/format.js";
import { CopyButton } from "./CopyButton.js";

export interface CodeBlockProps {
  readonly text: string;
  readonly label?: string;
  readonly copyLabel?: string;
  readonly maxHeight?: "sm" | "md" | "lg" | "none";
  readonly wrap?: boolean;
  readonly className?: string;
}

const HEIGHTS = { sm: "max-h-48", md: "max-h-80", lg: "max-h-[32rem]", none: "" } as const;

/** Monospace text (commands, prompts, output tails) with a copy button. */
export function CodeBlock({ text, label, copyLabel = "Copy", maxHeight = "md", wrap = true, className }: CodeBlockProps) {
  return (
    <div className={cx("group relative min-w-0 rounded-lg border border-zinc-800 bg-zinc-950", className)}>
      <pre
        aria-label={label}
        tabIndex={0}
        className={cx(
          "overflow-auto px-3 py-2.5 pr-10 font-mono text-[12px] leading-relaxed text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
          HEIGHTS[maxHeight],
        )}
      >
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5 opacity-70 transition-opacity group-hover:opacity-100">
        <CopyButton text={text} label={copyLabel} />
      </div>
    </div>
  );
}

export function JsonBlock({ value, label, maxHeight = "md" }: { readonly value: unknown; readonly label?: string; readonly maxHeight?: CodeBlockProps["maxHeight"] }) {
  return <CodeBlock text={prettyJson(value)} label={label} copyLabel="Copy JSON" maxHeight={maxHeight} wrap={false} />;
}

/** A disclosure (native `<details>`) with a consistent look. */
export function Disclosure({ summary, children, className, defaultOpen = false }: { readonly summary: ReactNode; readonly children: ReactNode; readonly className?: string; readonly defaultOpen?: boolean }) {
  return (
    <details className={cx("group/details min-w-0", className)} open={defaultOpen || undefined}>
      <summary className="inline-flex items-center gap-1 rounded-md py-0.5 pr-1 text-[12.5px] font-medium text-zinc-400 select-none hover:text-zinc-200">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/details:rotate-90" aria-hidden />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
