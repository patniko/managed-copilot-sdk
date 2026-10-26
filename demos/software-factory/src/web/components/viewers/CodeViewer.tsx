import { useMemo } from "react";
import { cx } from "../../lib/cx.js";
import { tokenizeLines, tokenStyle, type Token } from "../../lib/highlight.js";
import { CopyButton } from "../ui/CopyButton.js";

const MAX_HIGHLIGHT_CHARS = 180_000;
const MAX_LINES = 6000;

function trimTrailingNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

/** Highlighted tokens of one line, colored with GitHub's syntax palette. */
export function TokenLine({ tokens }: { readonly tokens: readonly Token[] }) {
  return (
    <>
      {tokens.map((token, index) =>
        token.empty ? null : (
          <span key={index} style={tokenStyle(token.types)}>
            {token.content}
          </span>
        ),
      )}
    </>
  );
}

export interface CodeViewerProps {
  readonly code: string;
  readonly language: string;
  readonly lineNumbers?: boolean;
  readonly className?: string;
}

/** A file like github.com's code view: line numbers in `blob-num`, code in `blob-code`. Large or unknown files stay plain. */
export function CodeViewer({ code, language, lineNumbers = true, className }: CodeViewerProps) {
  const { lines, total, highlighted } = useMemo(() => {
    const all = trimTrailingNewline(code.replace(/\r\n?/g, "\n")).split("\n");
    const shown = all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all;
    const text = shown.join("\n");
    return {
      lines: shown,
      total: all.length,
      highlighted: text.length <= MAX_HIGHLIGHT_CHARS ? tokenizeLines(text, language) : undefined,
    };
  }, [code, language]);

  return (
    <div className={className}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              {lineNumbers ? <td className="blob-num">{index + 1}</td> : null}
              <td className={cx("blob-code", lineNumbers ? "pl-3" : "pl-4")}>
                {highlighted?.[index] && line ? <TokenLine tokens={highlighted[index]} /> : line || "\n"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > MAX_LINES ? (
        <p className="border-t border-line px-4 py-2 text-xs text-fg-muted">
          Showing the first {MAX_LINES.toLocaleString()} of {total.toLocaleString()} lines. Open the raw file to see everything.
        </p>
      ) : null}
    </div>
  );
}

export interface CodeBlockProps {
  readonly code: string;
  readonly language: string;
  readonly className?: string;
  readonly maxHeightClass?: string;
}

/** A fenced code block the way github.com renders Markdown: muted panel, copy button on hover. */
export function CodeBlock({ code, language, className, maxHeightClass = "max-h-96" }: CodeBlockProps) {
  const text = trimTrailingNewline(code);
  const lines = useMemo(() => tokenizeLines(text, language), [text, language]);
  return (
    <div className={cx("group/code relative", className)}>
      <pre className={cx("m-0 overflow-auto rounded-md bg-canvas-muted p-4 font-mono text-xs leading-normal", maxHeightClass)}>
        {lines
          ? lines.map((tokens, index) => (
              <div key={index}>
                <TokenLine tokens={tokens} />
                {tokens.every((token) => token.empty || token.content === "") ? "\n" : null}
              </div>
            ))
          : text}
      </pre>
      <div className="absolute top-2 right-2 sm:opacity-0 sm:transition-opacity sm:group-hover/code:opacity-100 sm:focus-within:opacity-100">
        <CopyButton text={text} label="Copy code" variant="default" size="sm" />
      </div>
    </div>
  );
}
