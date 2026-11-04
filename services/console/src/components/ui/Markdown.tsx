import { memo, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../../lib/cx.js";
import { safeExternalUrl } from "../../lib/format.js";

/** Only absolute http(s) links are clickable (in a new tab); relative and other links read as text. */
function SafeLink({ href, children, title }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const url = safeExternalUrl(href);
  if (url) {
    return (
      <a href={url} title={title ?? url} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <span className="underline decoration-dotted underline-offset-2" title={href}>
      {children}
    </span>
  );
}

/** Images are never loaded (the console only loads GitHub avatars); show their alt text and source instead. */
function ImagePlaceholder({ src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  const source = typeof src === "string" ? src : "";
  const label = alt || source || "image";
  const url = safeExternalUrl(source);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
      [image: {label}]
    </a>
  ) : (
    <span className="text-fg-muted" title={source}>
      [image: {label}]
    </span>
  );
}

const COMPONENTS: Components = { a: SafeLink, img: ImagePlaceholder };
const PLUGINS = [remarkGfm];

/**
 * Markdown from deployed customization files. `sm` (default) renders like a GitHub comment (14px); `md` like a README
 * (16px). Raw HTML is never rendered (react-markdown shows it as text without `rehype-raw`), and links/images are
 * restricted as above.
 */
export const MarkdownView = memo(function MarkdownView({ source, className, size = "sm" }: { readonly source: string; readonly className?: string; readonly size?: "sm" | "md" }) {
  return (
    <div className={cx("markdown-body", size === "sm" && "markdown-body--sm", className)}>
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
});
