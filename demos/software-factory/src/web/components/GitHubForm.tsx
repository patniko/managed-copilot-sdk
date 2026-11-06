import {
  ChevronRightIcon,
  CommentIcon,
  GitBranchIcon,
  InfoIcon,
  IssueClosedIcon,
  IssueOpenedIcon,
  LockIcon,
  MarkGithubIcon,
  RepoIcon,
  SearchIcon,
  XIcon,
} from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatWorkOrderNumber, type IssueDetail, type IssueLabel, type IssueSummary, type RepositorySummary } from "../../shared/types.js";
import { api, toErrorInfo, type ErrorInfo } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { formatRelative, pluralize } from "../lib/format.js";
import { runsBlockedReason } from "../lib/platform.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { createWorkOrder, useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { toast } from "../lib/toast.js";
import { Button, IconButton } from "./ui/Button.js";
import { Callout } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

interface GitHubDraft {
  readonly repository?: RepositorySummary;
  readonly issue?: IssueDetail;
  readonly request: string;
  readonly title: string;
  readonly rounds: number;
}

const EMPTY_DRAFT: GitHubDraft = { request: "", title: "", rounds: 2 };
/** Survives navigating away and back within the session. */
let savedDraft: GitHubDraft = EMPTY_DRAFT;

const SUGGESTIONS: readonly { readonly label: string; readonly text: (issue: IssueDetail | undefined) => string }[] = [
  { label: "Fix the issue", text: (issue) => `Fix #${issue?.number ?? ""} and add a test that covers it.` },
  { label: "Implement it", text: (issue) => `Implement #${issue?.number ?? ""} as described, with tests. Show the result in screenshots.` },
  { label: "Investigate", text: (issue) => `Investigate #${issue?.number ?? ""}: find the root cause and fix it if the fix is small. Explain what you found.` },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

interface Search<T> {
  readonly items: readonly T[];
  readonly loading: boolean;
  readonly error?: ErrorInfo;
}

/** Runs `load(query)` as the query settles, dropping answers to queries that were replaced. */
function useSearch<T>(query: string, load: (query: string, signal: AbortSignal) => Promise<T[]>, enabled: boolean, key: string): Search<T> {
  const debounced = useDebounced(query, 250);
  const [state, setState] = useState<Search<T>>({ items: [], loading: enabled });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((current) => ({ items: current.items, loading: true }));
    load(debounced, controller.signal).then(
      (items) => !controller.signal.aborted && setState({ items, loading: false }),
      (error: unknown) => !controller.signal.aborted && setState({ items: [], loading: false, error: toErrorInfo(error) }),
    );
    return () => controller.abort();
    // `load` is stable per `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, enabled, key]);
  return state;
}

/** Text that reads on a GitHub label's background color. */
function labelStyle(color: string): { backgroundColor: string; color: string; borderColor: string } {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : "8b949e";
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;
  return { backgroundColor: `#${hex}`, color: luminance > 0.6 ? "#1f2328" : "#ffffff", borderColor: "transparent" };
}

export function IssueLabels({ labels, className }: { readonly labels: readonly IssueLabel[]; readonly className?: string }) {
  if (labels.length === 0) return null;
  return (
    <span className={cx("inline-flex flex-wrap gap-1", className)}>
      {labels.slice(0, 6).map((label) => (
        <span key={label.name} className="IssueLabel" style={labelStyle(label.color)}>
          {label.name}
        </span>
      ))}
    </span>
  );
}

/** The GitHub path of the new-work-order form: pick a repository, optionally an issue, and say what to do. */
export function GitHubWorkOrderForm() {
  const platform = useStore((state) => state.platform);
  const github = useStore((state) => state.github);
  const [draft, setDraftState] = useState<GitHubDraft>(savedDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const requestInput = useRef<HTMLTextAreaElement>(null);

  const setDraft = (next: GitHubDraft): void => {
    savedDraft = next;
    setDraftState(next);
  };

  const signedOut = github && !github.available ? (github.message ?? "The factory isn't signed in to GitHub.") : undefined;
  const blocked = runsBlockedReason(platform, "github") ?? signedOut;
  const readOnly = draft.repository && !draft.repository.canPush ? `You can't push to ${draft.repository.fullName}, so the factory can't open a pull request there.` : undefined;
  const missing = !draft.repository ? "Pick a repository." : draft.request.trim().length < 3 ? "Say what the factory should do." : undefined;
  const canSubmit = !blocked && !readOnly && !missing && !submitting;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || !draft.repository) {
      if (draft.repository && draft.request.trim().length < 3) requestInput.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const workOrder = await createWorkOrder({
        title: draft.title.trim(),
        brief: draft.request.trim(),
        maxReviewRounds: draft.rounds,
        github: { repository: draft.repository.fullName, ...(draft.issue ? { issue: draft.issue.number } : {}) },
      });
      savedDraft = EMPTY_DRAFT;
      toast.success(`${formatWorkOrderNumber(workOrder.number)} is on the floor`, `Checking out ${draft.repository.fullName} in a sandbox now.`);
      navigate(workOrderHref(workOrder.id));
    } catch (caught) {
      setError(toErrorInfo(caught));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="New GitHub work order" className="Box mt-6">
      <div className="space-y-5 p-4 md:p-6">
        <AccountLine />
        <RepositoryField
          value={draft.repository}
          onChange={(repository) => setDraft({ ...draft, repository, issue: repository?.fullName === draft.repository?.fullName ? draft.issue : undefined })}
          disabled={Boolean(signedOut)}
        />
        {draft.repository ? (
          <IssueField repository={draft.repository} value={draft.issue} onChange={(issue) => setDraft({ ...draft, issue })} />
        ) : null}
        <div className="FormControl">
          <label htmlFor="gh-request" className="FormControl-label">
            What should the factory do?
          </label>
          <RequestInput
            inputRef={requestInput}
            value={draft.request}
            placeholder={
              draft.issue
                ? `Fix #${draft.issue.number} and add a test for it.\n\nAnything else the developer should know: where to look, how it should look, what not to change.`
                : "Add a dark mode toggle to the settings page, remembered across visits.\n\nThe developer works on a copy of the default branch, shows the result in screenshots, and opens a pull request."
            }
            onChange={(request) => setDraft({ ...draft, request })}
          />
          {draft.issue ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-fg-muted">Start from</span>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setDraft({ ...draft, request: suggestion.text(draft.issue) });
                    requestInput.current?.focus();
                  }}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon size={16} className="text-fg-muted transition-transform duration-100 group-open:rotate-90" />
            Advanced
            <span className="font-normal text-fg-muted">· {draft.rounds} review {draft.rounds === 1 ? "round" : "rounds"}</span>
          </summary>
          <div className="mt-3 space-y-4 pl-5">
            <div className="FormControl">
              <label htmlFor="gh-title" className="FormControl-label">
                Title <span className="font-normal text-fg-muted">(optional)</span>
              </label>
              <input
                id="gh-title"
                value={draft.title}
                maxLength={120}
                autoComplete="off"
                placeholder={draft.issue?.title ?? "From the issue or the first line of the request"}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                className="form-control input-block"
              />
            </div>
            <fieldset>
              <legend className="FormControl-label">Review rounds</legend>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="SegmentedControl SegmentedControl--sm">
                  {[1, 2, 3].map((rounds) => (
                    <label key={rounds} className="SegmentedControl-item w-10">
                      <input type="radio" name="gh-review-rounds" value={rounds} checked={draft.rounds === rounds} onChange={() => setDraft({ ...draft, rounds })} className="sr-only" />
                      {rounds}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-fg-muted">Times the reviewer can send the change back before the pull request opens.</p>
              </div>
            </fieldset>
          </div>
        </details>
      </div>

      <div className="flex flex-col gap-3 border-t border-line-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-end md:px-6">
        {blocked || readOnly || missing ? (
          <p id="gh-submit-help" className="flex items-start gap-1.5 text-xs text-fg-muted sm:mr-auto">
            <InfoIcon size={16} className="shrink-0" />
            {blocked ?? readOnly ?? missing}
          </p>
        ) : (
          <p className="flex items-start gap-1.5 text-xs text-fg-muted sm:mr-auto">
            <GitBranchIcon size={16} className="shrink-0" />
            Changes go to a new branch; the factory opens a pull request for you to review and merge.
          </p>
        )}
        <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit} aria-describedby={blocked || readOnly || missing ? "gh-submit-help" : undefined}>
          {submitting ? "Starting…" : "Start work order"}
        </Button>
      </div>

      {error ? (
        <Callout tone="danger" role="alert" title="The factory couldn't start this work order" className="mx-4 mb-4 md:mx-6">
          {error.message}
        </Callout>
      ) : null}
    </form>
  );
}

function AccountLine() {
  const github = useStore((state) => state.github);
  if (!github) {
    return (
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <Spinner size={16} /> Checking the factory's GitHub sign-in…
      </p>
    );
  }
  if (!github.available) {
    return (
      <Callout tone="warning" compact title={github.message ?? "The factory isn't signed in to GitHub."}>
        {github.hint ?? "Sign in with `gh auth login`, then reload."}
      </Callout>
    );
  }
  return (
    <p className="flex items-center gap-2 text-xs text-fg-muted">
      {github.avatarUrl ? <img src={github.avatarUrl} alt="" className="avatar size-5 rounded-full" /> : <MarkGithubIcon size={16} />}
      <span>
        Working on GitHub as <span className="font-semibold text-fg">@{github.login}</span>. The token stays in the factory: sandboxes get a copy of the code, never your credentials.
      </span>
    </p>
  );
}

function FieldLabel({ id, children, hint }: { readonly id: string; readonly children: ReactNode; readonly hint?: ReactNode }) {
  return (
    <label htmlFor={id} className="FormControl-label flex items-baseline gap-2">
      {children}
      {hint ? <span className="text-xs font-normal text-fg-muted">{hint}</span> : null}
    </label>
  );
}

function ResultsBox({ loading, error, empty, children }: { readonly loading: boolean; readonly error?: ErrorInfo; readonly empty: string; readonly children: ReactNode[] }) {
  return (
    <div className="Box mt-2 max-h-80 overflow-auto" aria-busy={loading}>
      {error ? (
        <p className="p-3 text-sm text-fg-danger" role="alert">
          {error.message}
        </p>
      ) : children.length === 0 ? (
        <p className="flex items-center gap-2 p-3 text-sm text-fg-muted">
          {loading ? <Spinner size={16} /> : null}
          {loading ? "Loading…" : empty}
        </p>
      ) : (
        <ul role="listbox">{children}</ul>
      )}
    </div>
  );
}

function RepositoryField({ value, onChange, disabled }: { readonly value?: RepositorySummary; readonly onChange: (value?: RepositorySummary) => void; readonly disabled: boolean }) {
  const [query, setQuery] = useState("");
  const now = useNow(60_000);
  const search = useSearch<RepositorySummary>(query, (q, signal) => api.repositories(q, signal), !value && !disabled, "repos");

  if (value) {
    return (
      <div>
        <span className="FormControl-label">Repository</span>
        <div className="Box mt-1 flex items-center gap-3 px-3 py-2">
          {value.private ? <LockIcon size={16} className="shrink-0 text-fg-muted" /> : <RepoIcon size={16} className="shrink-0 text-fg-muted" />}
          <div className="min-w-0 flex-1">
            <a href={value.htmlUrl} target="_blank" rel="noreferrer" className="font-semibold break-all">
              {value.fullName}
            </a>
            <p className="truncate text-xs text-fg-muted">
              <GitBranchIcon size={12} /> {value.defaultBranch}
              {value.description ? ` · ${value.description}` : ""}
            </p>
          </div>
          {!value.canPush ? <span className="Label Label--attention shrink-0">Read only</span> : null}
          <Button size="sm" onClick={() => onChange(undefined)}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <FieldLabel id="gh-repo" hint="Yours, your organizations', or any owner/name you can push to">
        Repository
      </FieldLabel>
      <div className="relative mt-1">
        <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted" />
        <input
          id="gh-repo"
          value={query}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search your repositories, or type owner/name"
          onChange={(event) => setQuery(event.target.value)}
          className="form-control input-block pl-8"
        />
      </div>
      {disabled ? null : (
        <ResultsBox loading={search.loading} error={search.error} empty={query.trim() ? "No repositories match." : "No repositories yet."}>
          {search.items.map((repo) => (
            <li key={repo.fullName} role="option" aria-selected="false" aria-disabled={!repo.canPush} className="Box-row p-0">
              <button
                type="button"
                disabled={!repo.canPush}
                onClick={() => onChange(repo)}
                title={repo.canPush ? undefined : "You can't push to this repository"}
                className={cx("flex w-full items-center gap-3 px-3 py-2 text-left", repo.canPush ? "hover:bg-canvas-muted" : "cursor-not-allowed opacity-60")}
              >
                {repo.private ? <LockIcon size={16} className="shrink-0 text-fg-muted" /> : <RepoIcon size={16} className="shrink-0 text-fg-muted" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{repo.fullName}</span>
                  {repo.description ? <span className="block truncate text-xs text-fg-muted">{repo.description}</span> : null}
                </span>
                <span className="hidden shrink-0 text-xs text-fg-muted sm:block">
                  {[repo.language, repo.pushedAt ? `Updated ${formatRelative(repo.pushedAt, now)}` : undefined].filter(Boolean).join(" · ")}
                </span>
                {!repo.canPush ? <span className="Label Label--secondary shrink-0">Read only</span> : null}
              </button>
            </li>
          ))}
        </ResultsBox>
      )}
    </div>
  );
}

function IssueField({ repository, value, onChange }: { readonly repository: RepositorySummary; readonly value?: IssueDetail; readonly onChange: (value?: IssueDetail) => void }) {
  const [query, setQuery] = useState("");
  const [loadingIssue, setLoadingIssue] = useState<number>();
  const [error, setError] = useState<ErrorInfo>();
  const now = useNow(60_000);
  const search = useSearch<IssueSummary>(query, (q, signal) => api.issues(repository.fullName, q, signal), !value, repository.fullName);

  const pick = async (issue: IssueSummary): Promise<void> => {
    setLoadingIssue(issue.number);
    setError(undefined);
    try {
      onChange(await api.issue(repository.fullName, issue.number));
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setLoadingIssue(undefined);
    }
  };

  if (value) {
    return (
      <div>
        <span className="FormControl-label">Issue</span>
        <div className="Box mt-1">
          <div className="flex items-start gap-2 px-3 py-2">
            {value.state === "open" ? <IssueOpenedIcon size={16} className="mt-0.5 shrink-0 text-fg-open" /> : <IssueClosedIcon size={16} className="mt-0.5 shrink-0 text-fg-done" />}
            <div className="min-w-0 flex-1">
              <a href={value.htmlUrl} target="_blank" rel="noreferrer" className="Link--primary font-semibold break-words">
                {value.title} <span className="font-normal text-fg-muted">#{value.number}</span>
              </a>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                <span>
                  {value.author ? `@${value.author} opened ` : "Opened "}
                  {formatRelative(value.createdAt, now)}
                </span>
                {value.comments > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <CommentIcon size={12} />
                    {pluralize(value.comments, "comment")}
                  </span>
                ) : null}
                <IssueLabels labels={value.labels} />
              </p>
            </div>
            <IconButton icon={XIcon} label="Remove the issue" size="sm" onClick={() => onChange(undefined)} />
          </div>
          {value.body.trim() ? (
            <div className="relative max-h-48 overflow-hidden border-t border-line-muted px-3 py-2">
              <MarkdownView source={value.body} size="sm" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-canvas" aria-hidden />
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-fg-muted">The developer reads the issue and its latest comments; the pull request closes it when merged.</p>
      </div>
    );
  }

  return (
    <div>
      <FieldLabel id="gh-issue" hint="Optional: sets the context, and the pull request closes it">
        Issue
      </FieldLabel>
      <div className="relative mt-1">
        <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted" />
        <input
          id="gh-issue"
          value={query}
          autoComplete="off"
          spellCheck={false}
          placeholder={`Search issues in ${repository.fullName}, or type #123`}
          onChange={(event) => setQuery(event.target.value)}
          className="form-control input-block pl-8"
        />
      </div>
      {error ? (
        <Callout tone="danger" compact className="mt-2">
          {error.message}
        </Callout>
      ) : null}
      <ResultsBox loading={search.loading} error={search.error} empty={query.trim() ? "No issues match." : "No open issues."}>
        {search.items.map((issue) => (
          <li key={issue.number} role="option" aria-selected="false" className="Box-row p-0">
            <button type="button" onClick={() => void pick(issue)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-canvas-muted">
              {loadingIssue === issue.number ? (
                <Spinner size={16} className="mt-0.5 shrink-0" />
              ) : issue.state === "open" ? (
                <IssueOpenedIcon size={16} className="mt-0.5 shrink-0 text-fg-open" />
              ) : (
                <IssueClosedIcon size={16} className="mt-0.5 shrink-0 text-fg-done" />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-semibold break-words">{issue.title}</span> <IssueLabels labels={issue.labels} className="align-middle" />
                <span className="block text-xs text-fg-muted">
                  #{issue.number} {issue.author ? `opened by @${issue.author}` : ""} · updated {formatRelative(issue.updatedAt, now)}
                  {issue.comments > 0 ? ` · ${pluralize(issue.comments, "comment")}` : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ResultsBox>
    </div>
  );
}

function RequestInput({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 280)}px`;
  }, [value, inputRef]);
  return (
    <textarea
      id="gh-request"
      ref={inputRef}
      rows={5}
      value={value}
      spellCheck
      aria-required="true"
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="form-control input-block resize-y"
    />
  );
}
