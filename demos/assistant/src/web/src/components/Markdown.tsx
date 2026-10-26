import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Assistant markdown, rendered like a GitHub comment: GitHub-flavored, no raw HTML, links open in a new tab. */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`markdown-body markdown-body--sm ${streaming ? "streaming-caret" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});