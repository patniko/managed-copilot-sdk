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
  return <span>{children}</span>;
}

/** Images from answers are shown as links: the page's content security policy allows no outside images. */
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

const COMPONENTS: Components = { a: Link, img: Image };
const PLUGINS = [remarkGfm];

/** Markdown rendered the way github.com renders comments (`markdown-body`). Raw HTML is never rendered. */
export const MarkdownView = memo(function MarkdownView({ source, className, streaming = false }: { readonly source: string; readonly className?: string; readonly streaming?: boolean }) {
  return (
    <div className={cx("markdown-body markdown-body--sm", streaming && "markdown-streaming", className)}>
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
});
