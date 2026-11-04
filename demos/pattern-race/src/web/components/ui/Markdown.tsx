import { memo, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

function Link({ href, children }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  if (href && /^(https?:|mailto:)/i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  // Relative links point into a lane's sandbox, not this app: show them as text.
  return <span title={href}>{children}</span>;
}

function Image({ alt, src }: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  return <span className="text-fg-muted">{alt || (typeof src === "string" ? src : "image")}</span>;
}

const COMPONENTS: Components = { a: Link, img: Image };
const PLUGINS = [remarkGfm];

/** An agent's answer, rendered the way github.com renders comments (`markdown-body`). */
export const MarkdownView = memo(function MarkdownView({ source }: { readonly source: string }) {
  return (
    <div className="markdown-body markdown-body--sm">
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
});
