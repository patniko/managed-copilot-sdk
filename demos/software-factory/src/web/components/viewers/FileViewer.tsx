import { CodeIcon, EyeIcon } from "@primer/octicons-react";
import { useMemo, useState } from "react";
import { viewerKind } from "../../lib/artifacts.js";
import { languageForPath } from "../../lib/highlight.js";
import { Callout } from "../ui/Feedback.js";
import { CodeViewer } from "./CodeViewer.js";
import { DiffViewer } from "./DiffViewer.js";
import { MarkdownView } from "./MarkdownView.js";
import { TestReportViewer } from "./TestReportViewer.js";

/** Picks the right viewer for a text artifact by its path. */
export function FileViewer({ path, text }: { readonly path: string; readonly text: string }) {
  if (text.length === 0) {
    return <p className="px-4 py-10 text-center text-fg-muted">This file is empty.</p>;
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
      return <CodeViewer code={text} language={languageForPath(path)} className="py-2" />;
  }
}

/** Rendered Markdown with a Preview / Code switch, like github.com's file view. */
function MarkdownFile({ text }: { readonly text: string }) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const options = [
    { id: "preview", label: "Preview", icon: EyeIcon },
    { id: "code", label: "Code", icon: CodeIcon },
  ] as const;
  return (
    <div>
      <div className="flex border-b border-line-muted px-4 py-2">
        <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Markdown view">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={mode === option.id}
              onClick={() => setMode(option.id)}
              className="SegmentedControl-item"
            >
              <option.icon size={16} />
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {mode === "preview" ? (
        <MarkdownView source={text} size="md" className="max-w-[1012px] p-6 md:p-8" />
      ) : (
        <CodeViewer code={text} language="markdown" className="py-2" />
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
        <Callout tone="warning" compact className="m-4">
          This file isn't valid JSON, so it's shown as is.
        </Callout>
      )}
      <CodeViewer code={pretty.text} language="json" className="py-2" />
    </div>
  );
}
