import { useMemo, useState } from "react";
import { viewerKind } from "../../lib/artifacts.js";
import { cx } from "../../lib/cx.js";
import { languageForPath } from "../../lib/highlight.js";
import { Callout } from "../ui/Feedback.js";
import { CodeViewer } from "./CodeViewer.js";
import { DiffViewer } from "./DiffViewer.js";
import { MarkdownView } from "./MarkdownView.js";
import { TestReportViewer } from "./TestReportViewer.js";

/** Picks the right viewer for a text artifact by its path. */
export function FileViewer({ path, text }: { readonly path: string; readonly text: string }) {
  if (text.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-zinc-500">This file is empty.</p>;
  }
  switch (viewerKind({ path, viewable: true })) {
    case "diff":
      return <DiffViewer text={text} />;
    case "test-report":
      return <TestReportViewer text={text} />;
    case "markdown":
      return <MarkdownFile text={text} />;
    case "json":
      return <JsonFile text={text} />;
    default:
      return <CodeViewer code={text} language={languageForPath(path)} />;
  }
}

function MarkdownFile({ text }: { readonly text: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div>
      <div className="flex justify-end border-b border-zinc-800/70 px-3 py-2">
        <div className="flex rounded-lg bg-zinc-950/70 p-0.5 ring-1 ring-inset ring-white/5" role="group" aria-label="Markdown view">
          {(["preview", "source"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
              className={cx(
                "rounded-md px-2.5 py-0.5 text-[11px] font-medium capitalize transition-colors",
                mode === option ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {mode === "preview" ? (
        <MarkdownView source={text} className="max-w-3xl px-5 py-4" />
      ) : (
        <CodeViewer code={text} language="markdown" />
      )}
    </div>
  );
}

function JsonFile({ text }: { readonly text: string }) {
  const pretty = useMemo(() => {
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { ok: false, text };
    }
  }, [text]);
  return (
    <div>
      {pretty.ok ? null : (
        <Callout tone="warning" className="m-3">
          This file isn't valid JSON, so it's shown as is.
        </Callout>
      )}
      <CodeViewer code={pretty.text} language="json" />
    </div>
  );
}
