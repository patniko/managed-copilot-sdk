import { createContext, memo, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../../lib/cx.js";
import { languageForFence } from "../../lib/highlight.js";
import { CodeBlock } from "./CodeViewer.js";

const InsidePre = createContext(false);

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

function Pre({ children }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  return <InsidePre.Provider value={true}>{children}</InsidePre.Provider>;
}

function Code({ className, children }: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  const block = useContext(InsidePre);
  if (!block) return <code>{children}</code>;
  const fence = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
  return <CodeBlock code={textOf(children)} language={languageForFence(fence)} className="mb-4" />;
}

function Link({ href, children }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  if (href && href.startsWith("#/")) return <a href={href}>{children}</a>;
  if (href && /^(https?:|mailto:)/i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  // Relative links point into the agent's workspace, not this app: show them as text.
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

const COMPONENTS: Components = { pre: Pre, code: Code, a: Link, img: Image, input: Input };
const PLUGINS = [remarkGfm];

export interface MarkdownViewProps {
  readonly source: string;
  /** `sm` is the 14px comment style; `md` the 16px README style. */
  readonly size?: "sm" | "md";
  readonly className?: string;
  /** Shows a blinking caret after the last block (streaming text). */
  readonly streaming?: boolean;
}

/** Markdown rendered the way github.com renders READMEs and comments (`markdown-body`). */
export const MarkdownView = memo(function MarkdownView({ source, size = "sm", className, streaming = false }: MarkdownViewProps) {
  return (
    <div className={cx("markdown-body", size === "sm" && "markdown-body--sm", streaming && "markdown-streaming", className)}>
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
});
