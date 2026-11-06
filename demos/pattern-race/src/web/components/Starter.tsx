import { CodeIcon, CommentIcon, CopilotIcon, PlayIcon, QuoteIcon, ShieldCheckIcon, SquareFillIcon, WorkflowIcon, type Icon } from "@primer/octicons-react";
import { JOBS, jobById, type JobId } from "../../shared/jobs.js";
import { cx } from "../lib/cx.js";
import { pickJob, startRace, stopRace, useStore } from "../lib/store.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

const JOB_ICONS: Readonly<Record<JobId, Icon>> = { answer: CommentIcon, code: CodeIcon, split: WorkflowIcon };

/** The page's one primary action: pick a job, start the race. */
export function Starter() {
  const app = useStore((current) => current.app);
  const job = useStore((current) => current.job);
  const pending = useStore((current) => current.pending);
  const error = useStore((current) => current.error);
  const running = app?.race?.state === "running";
  const ready = app?.platform.state === "connected" && app.lanes.some((lane) => lane.available);
  return (
    <section aria-label="Start a race" className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Pattern Race</h1>
          <p className="mt-1 text-base text-fg-muted">One job, six patterns. Only the environment name changes.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <div role="radiogroup" aria-label="Job" className="grid grid-cols-3 gap-2">
            {JOBS.map((candidate) => {
              const Glyph = JOB_ICONS[candidate.id];
              const selected = candidate.id === job;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={running}
                  onClick={() => pickJob(candidate.id)}
                  title={candidate.summary}
                  className={cx(
                    "flex min-w-0 flex-col items-center gap-1 rounded-md border px-2 py-2 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:w-44 sm:flex-row sm:gap-2 sm:px-3 sm:text-left",
                    selected ? "border-line-accent bg-accent-muted" : "border-line bg-canvas hover:bg-canvas-muted",
                    running && "cursor-not-allowed opacity-60",
                  )}
                >
                  <Glyph size={16} className={cx("shrink-0", selected ? "text-fg-accent" : "text-fg-muted")} />
                  <span className="min-w-0 max-sm:w-full">
                    <span className="block truncate text-sm font-semibold">{candidate.title}</span>
                    <span className="block truncate text-xs text-fg-muted max-sm:hidden">{candidate.summary}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary btn-lg flex-1 sm:w-40" disabled={!ready || running || pending} onClick={() => void startRace()}>
              {running ? <Spinner size={16} /> : <PlayIcon size={16} />}
              {running ? "Racing…" : app?.race ? "Race again" : "Start race"}
            </button>
            {running ? (
              <Tooltip content="Stop the race and delete its sandboxes">
                <button type="button" className="btn btn-lg btn-icon" aria-label="Stop the race" disabled={pending} onClick={() => void stopRace()}>
                  <SquareFillIcon size={16} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>
      {error ? (
        <div role="alert" className="flash flash-error py-3">
          {error}
        </div>
      ) : null}
      <PromptLine job={job} />
    </section>
  );
}

/** The prompt every lane gets, the model, and how approvals work: what makes the race fair. */
function PromptLine({ job }: { readonly job: JobId }) {
  const model = useStore((current) => current.app?.model);
  const prompt = jobById(job).prompt;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-muted bg-canvas-muted px-4 py-3 md:flex-row md:items-center md:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-2" title={prompt}>
        <QuoteIcon size={16} className="mt-0.5 shrink-0 text-fg-muted" />
        <p className="line-clamp-2 min-w-0 text-sm whitespace-pre-line">{prompt}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {model ? (
          <Tooltip content="Every lane uses the same model">
            <span className="inline-flex items-center gap-1">
              <CopilotIcon size={16} />
              {model.name}
            </span>
          </Tooltip>
        ) : null}
        <Tooltip content="Each lane's requests are approved automatically: they act only in that lane's own sandboxes, within its environment's network rules.">
          <span className="inline-flex items-center gap-1">
            <ShieldCheckIcon size={16} />
            Auto-approved
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
