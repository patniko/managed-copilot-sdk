import { Highlight } from "prism-react-renderer";
import { cx } from "../../lib/cx.js";
import { codeTheme, LANGUAGE_LABELS, PLAIN, Prism } from "../../lib/highlight.js";
import { CopyButton } from "../ui/CopyButton.js";

const MAX_HIGHLIGHT_CHARS = 180_000;
const MAX_LINES = 6000;

function trimTrailingNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export interface CodeViewerProps {
  readonly code: string;
  readonly language: string;
  readonly lineNumbers?: boolean;
  readonly className?: string;
}

/** Syntax-highlighted file with line numbers; falls back to plain text for unknown or very large files. */
export function CodeViewer({ code, language, lineNumbers = true, className }: CodeViewerProps) {
  const all = trimTrailingNewline(code.replace(/\r\n/g, "\n"));
  const lines = all.split("\n");
  const truncated = lines.length > MAX_LINES;
  const text = truncated ? lines.slice(0, MAX_LINES).join("\n") : all;
  const highlight = language !== PLAIN && text.length <= MAX_HIGHLIGHT_CHARS;
  const gutter = "table-cell w-px select-none pr-4 pl-4 text-right align-top text-zinc-600 tabular";

  const body = highlight ? (
    <Highlight prism={Prism} theme={codeTheme} code={text} language={language}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <code className="table min-w-full border-separate border-spacing-0">
          {tokens.map((line, index) => {
            const { className: lineClass, ...lineProps } = getLineProps({ line });
            return (
              <span key={index} {...lineProps} className={cx(lineClass, "table-row hover:bg-white/[0.025]")}>
                {lineNumbers ? <span className={gutter}>{index + 1}</span> : null}
                <span className={cx("table-cell whitespace-pre pr-6", !lineNumbers && "pl-4")}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </span>
            );
          })}
        </code>
      )}
    </Highlight>
  ) : (
    <code className="table min-w-full border-separate border-spacing-0 text-zinc-200">
      {text.split("\n").map((line, index) => (
        <span key={index} className="table-row hover:bg-white/[0.025]">
          {lineNumbers ? <span className={gutter}>{index + 1}</span> : null}
          <span className={cx("table-cell whitespace-pre pr-6", !lineNumbers && "pl-4")}>{line || "\n"}</span>
        </span>
      ))}
    </code>
  );

  return (
    <div className={className}>
      <pre className="overflow-x-auto py-3 font-mono text-[12.5px] leading-[1.6]">{body}</pre>
      {truncated ? (
        <p className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
          Showing the first {MAX_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines. Open the raw file to see
          everything.
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

/** Fenced code inside markdown: language label, copy button, scrollable body. */
export function CodeBlock({ code, language, className, maxHeightClass = "max-h-96" }: CodeBlockProps) {
  const text = trimTrailingNewline(code);
  return (
    <div className={cx("group/code my-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70", className)}>
      <div className="flex h-7 items-center justify-between border-b border-zinc-800/80 bg-zinc-900/60 pr-1 pl-3">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-zinc-500">
          {LANGUAGE_LABELS[language] ?? language}
        </span>
        <CopyButton text={text} label="Copy code" className="opacity-70 group-hover/code:opacity-100" />
      </div>
      <div className={cx("overflow-auto", maxHeightClass)}>
        <Highlight prism={Prism} theme={codeTheme} code={text} language={language}>
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre className="px-3 py-2.5 font-mono text-[12px] leading-[1.6]">
              {tokens.map((line, index) => (
                <div key={index} {...getLineProps({ line })}>
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} {...getTokenProps({ token })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
}
