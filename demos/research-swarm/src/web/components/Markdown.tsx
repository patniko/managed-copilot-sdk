import { memo, useCallback, type ComponentPropsWithoutRef } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReportSource } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { Tooltip } from "./ui/Tooltip.js";

const CITATION = /\[(\d{1,3})\]/g;
const CITE = "cite:";

/** Scrolls to a source in the list and highlights it for a moment. */
function showSource(n: number): void {
  const element = document.getElementById(`source-${n}`);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.remove("source-flash");
  void element.offsetWidth;
  element.classList.add("source-flash");
}

function Citation({ n, source }: { readonly n: number; readonly source: ReportSource | undefined }) {
  const open = useCallback(() => showSource(n), [n]);
  return (
    <Tooltip content={source ? `${source.title} · ${source.host}` : `Source ${n}`}>
      <button type="button" onClick={open} className="citation" aria-label={`Source ${n}${source ? `: ${source.title}` : ""}`}>
        {n}
      </button>
    </Tooltip>
  );
}

/**
 * Markdown as github.com renders it. With `sources`, its `[n]` citations become links to the report's numbered
 * sources; without, `[n]` stays text (a researcher's findings aren't numbered).
 */
export const ReportMarkdown = memo(function ReportMarkdown({ source, sources, className }: { readonly source: string; readonly sources?: readonly ReportSource[]; readonly className?: string }) {
  const components: Components = {
    a: ({ href, children }: ComponentPropsWithoutRef<"a"> & ExtraProps) => {
      if (href?.startsWith(CITE)) {
        const n = Number(href.slice(CITE.length));
        return <Citation n={n} source={sources?.find((candidate) => candidate.n === n)} />;
      }
      return href && /^https?:/i.test(href) ? (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) => <span className="text-fg-muted">{alt}</span>,
  };
  return (
    <div className={cx("markdown-body", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => (url.startsWith(CITE) ? url : defaultUrlTransform(url))}>
        {sources ? source.replace(CITATION, (_match, n: string) => `[${n}](${CITE}${n})`) : source}
      </Markdown>
    </div>
  );
});
