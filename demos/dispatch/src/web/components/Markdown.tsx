import { memo, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/cx.js";

function Link({ href, children }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  if (href && /^(https?:|mailto:)/i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  // Relative links point into a sandbox's workspace, not this app: show them as text.
  return (
    <span className="underline decoration-fg-muted decoration-dotted underline-offset-2" title={href}>
      {children}
    </span>
  );
}

function Image({ src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  const label = alt || (typeof src === "string" ? src : "image");
  if (typeof src === "string" && /^https?:/i.test(src)) {
    return (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    );
  }
  return <span className="text-fg-muted">{label}</span>;
}

function Input({ type, checked }: ComponentPropsWithoutRef<"input"> & ExtraProps) {
  if (type !== "checkbox") return null;
  return <input type="checkbox" className="task-list-item-checkbox" checked={Boolean(checked)} disabled aria-label={checked ? "Done" : "Not done"} />;
}

const COMPONENTS: Components = { a: Link, img: Image, input: Input };
const PLUGINS = [remarkGfm];

/** Markdown rendered the way github.com renders comments (`markdown-body`). */
export const MarkdownView = memo(function MarkdownView({ source, className, streaming = false }: { readonly source: string; readonly className?: string; readonly streaming?: boolean }) {
  return (
    <div className={cx("markdown-body markdown-body--sm", streaming && "markdown-streaming", className)}>
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
});
