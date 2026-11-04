import { ChevronRightIcon } from "@primer/octicons-react";
import { useMemo, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { prettyJson } from "../../lib/format.js";
import { CopyButton } from "./CopyButton.js";

export interface CodeBlockProps {
  readonly text: string;
  /** What the code is: the accessible name, and the header title unless `title` is given. */
  readonly label?: string;
  /** Header title, when it should differ from the accessible name. */
  readonly title?: ReactNode;
  /** Extra header content before the copy button (a mode label). */
  readonly headerExtra?: ReactNode;
  readonly copyLabel?: string;
  readonly maxHeight?: "sm" | "md" | "lg" | "none";
  readonly wrap?: boolean;
  /** The title is a file path or identifier: set it in monospace, like a file header on github.com. */
  readonly path?: boolean;
  readonly className?: string;
}

const HEIGHTS = { sm: "max-h-48", md: "max-h-80", lg: "max-h-[32rem]", none: "" } as const;

/** Monospace text (commands, prompts, output tails) as GitHub shows code: a Box with a file header and a copy button. */
export function CodeBlock({ text, label, title, headerExtra, copyLabel = "Copy", maxHeight = "md", wrap = true, path = false, className }: CodeBlockProps) {
  return (
    <div className={cx("Box min-w-0 overflow-hidden", className)}>
      <div className="file-header min-h-10 py-1 pr-1">
        <span className={cx("min-w-0 flex-1 truncate", path ? "font-semibold text-fg" : "font-sans text-fg-muted")} title={label}>
          {title ?? label ?? "Code"}
        </span>
        {headerExtra ? <span className="font-sans">{headerExtra}</span> : null}
        <CopyButton text={text} label={copyLabel} />
      </div>
      <pre
        aria-label={label}
        tabIndex={0}
        className={cx(
          "overflow-auto bg-canvas-muted px-4 py-3 font-mono text-xs leading-5 text-fg focus-visible:-outline-offset-2",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
          HEIGHTS[maxHeight],
        )}
      >
        {text}
      </pre>
    </div>
  );
}

export function JsonBlock({ value, label, maxHeight = "md" }: { readonly value: unknown; readonly label?: string; readonly maxHeight?: CodeBlockProps["maxHeight"] }) {
  return <CodeBlock text={prettyJson(value)} label={label} copyLabel="Copy JSON" maxHeight={maxHeight} wrap={false} />;
}

/** A file's text as github.com's code view shows it: muted line numbers in a gutter beside the lines. */
export function CodeLines({ text, label }: { readonly text: string; readonly label: string }) {
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  return (
    <div className="relative overflow-x-auto py-2" tabIndex={0} aria-label={label}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td className="blob-num" data-line-number={index + 1}>
                {index + 1}
              </td>
              <td className="blob-code pl-4">{line || "\n"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A disclosure (native `<details>`) with a rotating chevron, like "Show more" on github.com. */
export function Disclosure({ summary, children, className, defaultOpen = false }: { readonly summary: ReactNode; readonly children: ReactNode; readonly className?: string; readonly defaultOpen?: boolean }) {
  return (
    <details className={cx("group/details min-w-0", className)} open={defaultOpen || undefined}>
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded-md text-sm text-fg-muted select-none hover:text-fg-accent">
        <ChevronRightIcon size={16} className="transition-transform duration-150 group-open/details:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
