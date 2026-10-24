import { Check } from "lucide-react";
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
  if (!block) return <code className="md-inline-code">{children}</code>;
  const fence = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
  return <CodeBlock code={textOf(children)} language={languageForFence(fence)} />;
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
    <span className="text-zinc-200 underline decoration-zinc-500 decoration-dotted underline-offset-2" title={href}>
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
  return <span className="text-zinc-400">{label}</span>;
}

function Table({ children }: ComponentPropsWithoutRef<"table"> & ExtraProps) {
  return (
    <div className="md-table">
      <table>{children}</table>
    </div>
  );
}

function Input({ type, checked }: ComponentPropsWithoutRef<"input"> & ExtraProps) {
  if (type !== "checkbox") return null;
  return (
    <span
      role="img"
      aria-label={checked ? "Done" : "Not done"}
      className={cx(
        "mr-1.5 inline-grid size-3.5 translate-y-[2px] place-items-center rounded border",
        checked ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-300" : "border-zinc-600",
      )}
    >
      {checked ? <Check className="size-2.5" strokeWidth={3} aria-hidden /> : null}
    </span>
  );
}

const COMPONENTS: Components = { pre: Pre, code: Code, a: Link, img: Image, table: Table, input: Input };
const PLUGINS = [remarkGfm];

export interface MarkdownViewProps {
  readonly source: string;
  readonly className?: string;
  /** Shows a blinking caret after the last block (streaming text). */
  readonly streaming?: boolean;
}

export const MarkdownView = memo(function MarkdownView({ source, className, streaming = false }: MarkdownViewProps) {
  return (
    <div className={cx("md", streaming && "md-streaming", className)}>
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
});
