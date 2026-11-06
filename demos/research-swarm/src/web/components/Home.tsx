import { BookIcon, ContainerIcon, CopilotIcon, GlobeIcon, TelescopeIcon } from "@primer/octicons-react";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { QUESTION_MAX, SAMPLE_QUESTIONS } from "../../shared/types.js";
import { errorMessage } from "../lib/api.js";
import { ago, plural } from "../lib/format.js";
import { navigate, runHref } from "../lib/router.js";
import { startRun, useStore } from "../lib/store.js";
import { RunStatusBadge } from "./Status.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

export function Home() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:py-12">
      <div className="flex flex-col items-center gap-4 text-center">
        <SwarmGlyph />
        <div>
          <h1 className="text-2xl font-semibold sm:text-3xl">Ask a research question</h1>
          <p className="mt-1 text-fg-muted">Researchers read the web in parallel and write one cited report.</p>
        </div>
      </div>
      <Ask />
      <Recent />
    </div>
  );
}

/** One lead fanning out to researchers and back into a report: the pattern at a glance. */
function SwarmGlyph() {
  const rows = [10, 34, 58, 82];
  return (
    <div className="flex items-center" aria-hidden>
      <span className="grid size-10 place-items-center rounded-full bg-accent-muted text-fg-accent">
        <CopilotIcon size={20} />
      </span>
      <svg width="44" height="92" viewBox="0 0 44 92" className="shrink-0">
        {rows.map((y) => (
          <path key={y} d={`M0 46 C 22 46, 22 ${y}, 44 ${y}`} className="wire wire-active" />
        ))}
      </svg>
      <span className="flex flex-col gap-1">
        {rows.map((y) => (
          <span key={y} className="grid size-5 place-items-center rounded-full border border-line bg-canvas text-fg-muted">
            <ContainerIcon size={12} />
          </span>
        ))}
      </span>
      <svg width="44" height="92" viewBox="0 0 44 92" className="shrink-0">
        {rows.map((y) => (
          <path key={y} d={`M0 ${y} C 22 ${y}, 22 46, 44 46`} className="wire wire-done" />
        ))}
      </svg>
      <span className="grid size-10 place-items-center rounded-full bg-success-muted text-fg-success">
        <BookIcon size={20} />
      </span>
    </div>
  );
}

function Ask() {
  const platform = useStore((state) => state.app?.platform);
  const swarm = useStore((state) => state.app?.swarm);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const ready = platform?.state === "connected" && swarm !== undefined;
  const text = question.trim();

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready || !text || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const run = await startRun(text);
      navigate(runHref(run.id));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) void submit(event);
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={(event) => void submit(event)} className="rounded-lg border border-line bg-canvas shadow-sm focus-within:border-line-accent focus-within:shadow-[0_0_0_1px_var(--borderColor-accent-emphasis)]">
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <textarea
          id="question"
          ref={input}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          maxLength={QUESTION_MAX}
          autoFocus
          placeholder="What do you want to know?"
          className="block w-full resize-none rounded-t-lg border-0 bg-transparent px-4 pt-3 text-base outline-none placeholder:text-fg-muted"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 pt-1 pb-3">
          <Capacity />
          <button type="submit" className="btn btn-primary" disabled={!ready || !text || busy}>
            {busy ? <Spinner size={16} /> : <TelescopeIcon size={16} />}
            Research
          </button>
        </div>
      </form>
      {error ? (
        <div className="flash flash-error" role="alert">
          {error}
        </div>
      ) : null}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-fg-muted">Try one</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {SAMPLE_QUESTIONS.map((sample) => (
            <button
              key={sample}
              type="button"
              title={sample}
              onClick={() => {
                setQuestion(sample);
                input.current?.focus();
              }}
              className="rounded-md border border-line bg-canvas px-3 py-2 text-left text-sm transition-colors hover:border-line-emphasis hover:bg-canvas-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span className="line-clamp-2">{sample}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** What asking starts, and where it can read: one line, with the details a hover away. */
function Capacity() {
  const platform = useStore((state) => state.app?.platform);
  const swarm = useStore((state) => state.app?.swarm);
  if (!platform || platform.state === "connecting" || platform.state === "reconnecting") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-fg-muted">
        <Spinner size={14} /> Connecting to Managed Copilot…
      </span>
    );
  }
  if (platform.state !== "connected" || !swarm) {
    return (
      <span className="min-w-0 flex-1 text-sm text-fg-danger" title={platform.message}>
        <span className="line-clamp-2">{platform.message ?? "Managed Copilot isn't available."}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
      <Tooltip content={`Each researcher gets its own ${swarm.researchers.size ?? "small"} sandbox, deleted when the report is done.`}>
        <span className="inline-flex items-center gap-1.5" tabIndex={0}>
          <ContainerIcon size={16} />
          Up to {plural(swarm.researchers.max, "researcher")}
        </span>
      </Tooltip>
      <Tooltip content={swarm.researchers.hosts.join(", ")}>
        <span className="inline-flex items-center gap-1.5" tabIndex={0}>
          <GlobeIcon size={16} />
          {plural(swarm.researchers.hosts.length, "site")}
        </span>
      </Tooltip>
    </span>
  );
}

function Recent() {
  const runs = useStore((state) => state.app?.runs);
  if (!runs || runs.length === 0) return null;
  return (
    <section aria-labelledby="recent">
      <h2 id="recent" className="mb-2 text-sm font-semibold text-fg-muted">
        Recent
      </h2>
      <ul className="Box divide-y divide-line-muted overflow-hidden">
        {runs.slice(0, 8).map((run) => (
          <li key={run.id}>
            <a href={runHref(run.id)} className="flex items-center gap-3 px-4 py-3 text-fg no-underline hover:bg-canvas-muted hover:no-underline focus-visible:bg-canvas-muted">
              <RunStatusBadge status={run.status} label={false} />
              <span className="min-w-0 flex-1 truncate font-medium" title={run.question}>
                {run.title ?? run.question}
              </span>
              <span className="shrink-0 text-sm text-fg-muted">{[run.sources > 0 ? plural(run.sources, "source") : undefined, ago(run.finishedAt ?? run.createdAt)].filter(Boolean).join(" · ")}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
