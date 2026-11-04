import { LinkExternalIcon } from "@primer/octicons-react";
import type { Run } from "../../shared/types.js";
import { ReportMarkdown } from "./Markdown.js";

/** The finished report: the question, a direct answer, the body with numbered citations, and the sources. */
export function Report({ run }: { readonly run: Run }) {
  const report = run.report!;
  const readers = (readBy: readonly string[]) => {
    const numbers = readBy.map((id) => run.researchers.findIndex((candidate) => candidate.id === id) + 1).filter((n) => n > 0);
    if (numbers.length <= 1) return `Researcher ${numbers[0] ?? "?"}`;
    return `Researchers ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  };
  return (
    <article className="min-w-0">
      <p className="line-clamp-2 text-sm text-fg-muted" title={run.question}>
        {run.question}
      </p>
      <h1 className="mt-1 text-2xl leading-tight font-semibold sm:text-3xl">{report.title}</h1>
      <div className="mt-5 rounded-md border-l-4 border-line-accent bg-canvas-muted px-4 py-3">
        <ReportMarkdown source={report.summary} sources={report.sources} className="report-summary" />
      </div>
      <ReportMarkdown source={report.body} sources={report.sources} className="mt-6" />
      {report.sources.length > 0 ? (
        <section className="mt-8 border-t border-line-muted pt-6" aria-labelledby="sources">
          <h2 id="sources" className="text-base font-semibold">
            Sources
          </h2>
          <ol className="mt-3 flex flex-col gap-1">
            {report.sources.map((source) => (
              <li key={source.n} id={`source-${source.n}`} className="flex items-start gap-3 rounded-md p-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-muted text-xs font-semibold text-fg-accent">{source.n}</span>
                <span className="min-w-0">
                  <a href={source.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 font-medium" title={source.url}>
                    <span className="truncate">{source.title}</span>
                    <LinkExternalIcon size={12} className="shrink-0 text-fg-muted" />
                  </a>
                  <span className="block truncate text-xs text-fg-muted">
                    {source.host} · read by {readers(source.readBy)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}
