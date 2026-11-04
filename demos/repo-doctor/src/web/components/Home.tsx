import { ArrowRightIcon, BeakerIcon, ContainerIcon, CopilotIcon, FileDiffIcon, PlayIcon, RepoIcon, ToolsIcon } from "@primer/octicons-react";
import { useState, type FormEvent } from "react";
import { parseRepoInput } from "../../shared/repo.js";
import type { CreateRunRequest, RunSummary } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { between, duration, relative } from "../lib/format.js";
import { navigate, runHref } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";
import { RUN_STATUS, RunStatusIcon } from "./Status.js";
import { Spinner } from "./ui/Spinner.js";

/** The whole product in one glance: a repository goes into one sandbox with Copilot; a patch comes out. */
function Flow() {
  const node = "grid size-12 place-items-center rounded-full border border-line bg-canvas text-fg-muted";
  return (
    <div className="flex items-start justify-center gap-3 text-xs text-fg-muted sm:gap-4" aria-hidden>
      <div className="flex flex-col items-center gap-1.5">
        <span className={node}>
          <RepoIcon size={20} />
        </span>
        Repo
      </div>
      <ArrowRightIcon size={16} className="mt-4 shrink-0" />
      <div className="flex flex-col items-center gap-1.5">
        <span className="rd-frame flex h-12 items-center gap-3 px-4 text-fg" data-state="ready">
          <ContainerIcon size={16} className="text-fg-accent" />
          <CopilotIcon size={20} />
          <ToolsIcon size={16} className="text-fg-muted" />
        </span>
        One sandbox
      </div>
      <ArrowRightIcon size={16} className="mt-4 shrink-0" />
      <div className="flex flex-col items-center gap-1.5">
        <span className={node}>
          <FileDiffIcon size={20} />
        </span>
        Patch
      </div>
    </div>
  );
}

function Launcher() {
  const platform = useStore((state) => state.platform);
  const sample = useStore((state) => state.sample);
  const [repo, setRepo] = useState("");
  const [invalid, setInvalid] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState<"repo" | "sample" | undefined>();
  const ready = platform?.state === "connected";

  const start = async (input: CreateRunRequest, kind: "repo" | "sample") => {
    setBusy(kind);
    setProblem(undefined);
    try {
      const run = await api.create(input);
      navigate(runHref(run.id));
    } catch (error) {
      setProblem(errorMessage(error));
      setBusy(undefined);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRepoInput(repo);
    if ("error" in parsed) return setInvalid(parsed.error);
    setInvalid(undefined);
    void start({ repo: repo.trim() }, "repo");
  };

  return (
    <div className="flex flex-col gap-3">
      {platform && !ready && platform.state !== "connecting" ? (
        <div className={cx("flash py-2 text-sm", platform.state === "unavailable" ? "flash-error" : "flash-warn")}>{platform.message ?? "Managed Copilot isn't connected."}</div>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row" noValidate>
        <label htmlFor="repo" className="sr-only">
          GitHub repository
        </label>
        <div className="relative min-w-0 flex-1">
          <RepoIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted" />
          <input
            id="repo"
            className="form-control input-lg w-full pl-9"
            placeholder="github.com/owner/repo"
            autoComplete="off"
            spellCheck={false}
            value={repo}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? "repo-error" : undefined}
            onChange={(event) => {
              setRepo(event.target.value);
              setInvalid(undefined);
            }}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={!ready || busy !== undefined}>
          {busy === "repo" ? <Spinner size={16} /> : <PlayIcon size={16} />}
          Run
        </button>
      </form>
      {invalid ? (
        <p id="repo-error" className="FormControl-inlineValidation">
          {invalid}
        </p>
      ) : null}
      {problem ? <div className="flash flash-error py-2 text-sm">{problem}</div> : null}
      <div className="flex justify-center">
        <button type="button" className="btn btn-invisible" disabled={!ready || busy !== undefined} onClick={() => void start({ sample: true }, "sample")} title={sample?.description}>
          {busy === "sample" ? <Spinner size={16} /> : <BeakerIcon size={16} />}
          Try the sample{sample ? `: ${sample.name}` : ""}
        </button>
      </div>
    </div>
  );
}

function outcome(run: RunSummary): string | undefined {
  if (run.failingBefore !== undefined && run.failingAfter !== undefined) return `${run.failingBefore} → ${run.failingAfter} failing`;
  if (run.failingBefore !== undefined) return `${run.failingBefore} failing`;
  return undefined;
}

function RunRow({ run, now }: { readonly run: RunSummary; readonly now: number }) {
  const status = RUN_STATUS[run.status];
  const metric = outcome(run);
  const elapsed = between(run.createdAt, run.finishedAt, now);
  return (
    <li>
      <a href={runHref(run.id)} className="Box-row flex min-w-0 items-center gap-3 text-fg no-underline hover:bg-canvas-muted focus-visible:outline-2">
        <RunStatusIcon status={run.status} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{run.title}</span> <span className="text-fg-muted">#{run.number}</span>
        </span>
        <span className={cx("hidden shrink-0 text-sm sm:inline", status.text)}>{status.label}</span>
        {metric ? <span className="hidden shrink-0 text-sm text-fg-muted md:inline">{metric}</span> : null}
        <span className="w-28 shrink-0 text-right text-xs text-fg-muted tabular-nums" title={new Date(run.createdAt).toLocaleString()}>
          {run.status === "running" ? (elapsed !== undefined ? duration(elapsed) : "") : relative(run.createdAt, now)}
        </span>
      </a>
    </li>
  );
}

export function Home() {
  const runs = useStore((state) => state.runs);
  const now = useNow(true, 15_000);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-10 sm:py-16">
      <div className="flex flex-col gap-6">
        <Flow />
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Repo Doctor</h1>
          <p className="mt-1 text-fg-muted">Paste a repo with a failing test. Get back a verified patch.</p>
        </div>
        <Launcher />
      </div>
      {runs.length ? (
        <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
          <h2 id="runs-heading" className="text-sm font-semibold">
            Runs
          </h2>
          <ul className="Box overflow-hidden">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
