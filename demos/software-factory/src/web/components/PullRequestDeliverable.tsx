import {
  CheckCircleFillIcon,
  CodeReviewIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LinkExternalIcon,
  QuestionIcon,
  SyncIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { formatWorkOrderNumber, type ChangeRevision, type MediaItem, type PullRequestView, type WorkOrder } from "../../shared/types.js";
import { errorMessage, mediaUrl } from "../lib/api.js";
import { confirmAction } from "../lib/confirm.js";
import { cx } from "../lib/cx.js";
import { formatDuration, formatFullDateTime, formatRelative, pluralize } from "../lib/format.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { isWorkOrderActive, latestReview } from "../lib/stations.js";
import { mergePullRequest, refreshPullRequest, reviseWorkOrder } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { toast } from "../lib/toast.js";
import { Button, buttonClass, IconButton } from "./ui/Button.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

const STATE_META: Readonly<Record<PullRequestView["state"], { readonly label: string; readonly className: string; readonly icon: typeof GitPullRequestIcon }>> = {
  open: { label: "Open", className: "State--open", icon: GitPullRequestIcon },
  merged: { label: "Merged", className: "State--merged", icon: GitMergeIcon },
  closed: { label: "Closed", className: "State--closed", icon: GitPullRequestClosedIcon },
};

/** A GitHub work order's deliverable, like a pull request page: the media first, the description, and what's next. */
export function PullRequestDeliverable({ workOrder }: { readonly workOrder: WorkOrder }) {
  const work = workOrder.github!;
  const pull = work.pullRequest;
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const active = isWorkOrderActive(workOrder.status);
  const revisions = work.revisions;
  const first = revisions[0]!;
  const latest = revisions.at(-1)!;
  const shown = [...revisions].reverse().find((revision) => revision.completedAt) ?? latest;

  const refresh = async (quiet: boolean): Promise<void> => {
    if (!pull) return;
    setRefreshing(true);
    try {
      await refreshPullRequest(workOrder.id);
    } catch (error) {
      if (!quiet) toast.error("Couldn't refresh the pull request", errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh(true);
    // Once per work order: GitHub is the source of truth for the pull request's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workOrder.id]);

  return (
    <div className="mx-auto grid max-w-[1280px] gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-labelledby="pr-title" className="min-w-0 space-y-6">
        <div className="Box">
          <div className="p-4 md:p-6">
            {pull ? (
              <>
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <h2 id="pr-title" className="min-w-0 flex-1 basis-64 text-xl font-semibold break-words">
                    {pull.title} <span className="font-normal text-fg-muted">#{pull.number}</span>
                  </h2>
                  <IconButton icon={SyncIcon} label="Refresh from GitHub" size="sm" disabled={refreshing} onClick={() => void refresh(false)} className={refreshing ? "animate-spin" : undefined} />
                  <a href={pull.htmlUrl} target="_blank" rel="noreferrer" className={buttonClass("default", "sm")}>
                    <LinkExternalIcon size={16} />
                    Open on GitHub
                  </a>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
                  <PullState pull={pull} />
                  <span>
                    <span className="font-semibold text-fg">@{workOrder.owner?.login ?? "you"}</span> {pull.state === "merged" ? "merged" : "wants to merge"}{" "}
                    {pull.commits !== undefined ? pluralize(pull.commits, "commit") : "the change"} into{" "}
                    <code className="inline-code">{pull.baseRef}</code> from <code className="inline-code">{pull.headRef}</code>
                  </span>
                </div>
              </>
            ) : (
              <>
                <h2 id="pr-title" className="flex items-center gap-2 text-xl font-semibold">
                  <QuestionIcon size={20} className="text-fg-muted" />
                  {shown.title ?? workOrder.title}
                </h2>
                <p className="mt-1 text-sm text-fg-muted">The developer didn't change any files, so there's no pull request.</p>
              </>
            )}
          </div>

          <MediaGallery workOrder={workOrder} media={shown.media ?? []} />

          <div className="border-t border-line-muted p-4 md:p-6">
            <h3 className="sr-only">Description</h3>
            {shown.answer ? (
              <MarkdownView source={shown.answer} size="md" />
            ) : first.summary ? (
              <MarkdownView source={first.summary} size="md" />
            ) : (
              <p className="text-fg-muted">No description was written.</p>
            )}
          </div>
        </div>

        {revisions.length > 1 ? <RevisionTimeline workOrder={workOrder} now={now} /> : null}

        <RequestChanges workOrder={workOrder} active={active} />
      </section>

      <aside className="min-w-0 space-y-4" aria-label="Pull request summary">
        {pull ? <MergeBox workOrder={workOrder} pull={pull} active={active} /> : null}
        <ChecksBox revision={shown} />
        <ReviewBox workOrder={workOrder} />
        <FilesBox workOrder={workOrder} revision={shown} />
      </aside>
    </div>
  );
}

function PullState({ pull }: { readonly pull: PullRequestView }) {
  const meta = STATE_META[pull.state];
  return (
    <span className={cx("State", meta.className)}>
      <meta.icon size={16} />
      {pull.draft && pull.state === "open" ? "Draft" : meta.label}
    </span>
  );
}

function MediaGallery({ workOrder, media }: { readonly workOrder: WorkOrder; readonly media: readonly MediaItem[] }) {
  if (media.length === 0) return null;
  return (
    <div className="border-t border-line-muted p-4 md:p-6">
      <h3 className="mb-3 text-base font-semibold">
        Screenshots and recordings <span className="Counter">{media.length}</span>
      </h3>
      <ul className={cx("grid gap-4", media.length > 1 && "md:grid-cols-2")}>
        {media.map((item) => {
          const url = mediaUrl(workOrder.id, item.stationId, item.path, item.version);
          return (
            <li key={`${item.path}@${item.version}`} className="min-w-0 overflow-hidden rounded-md border border-line bg-canvas-inset">
              {item.kind === "video" ? (
                <video src={url} controls muted playsInline preload="metadata" className="block max-h-[28rem] w-full bg-black" aria-label={item.caption} />
              ) : (
                <a href={url} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={url} alt={item.caption} loading="lazy" className="block max-h-[28rem] w-full object-contain" />
                </a>
              )}
              <p className="border-t border-line-muted bg-canvas px-3 py-2 text-xs">
                <span className="font-semibold">{item.caption}</span> <span className="text-fg-muted">· {item.path.replace(/^media\//, "")}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RevisionTimeline({ workOrder, now }: { readonly workOrder: WorkOrder; readonly now: number }) {
  const revisions = workOrder.github!.revisions.slice(1);
  return (
    <section className="Box" aria-label="Follow-up requests">
      <div className="Box-header px-4 py-2">
        <h3 className="Box-title">Follow-up requests</h3>
        <span className="Counter">{revisions.length}</span>
      </div>
      <ol>
        {[...revisions].reverse().map((revision) => (
          <li key={revision.number} className="Box-row px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
              <CommentDiscussionIcon size={16} />
              <span className="font-semibold text-fg">Revision {revision.number}</span>
              {revision.requestedBy ? <span>@{revision.requestedBy}</span> : null}
              <span title={formatFullDateTime(revision.requestedAt)}>{formatRelative(revision.requestedAt, now)}</span>
              <RevisionOutcome revision={revision} active={isWorkOrderActive(workOrder.status) && revision === workOrder.github!.revisions.at(-1)} />
              {revision.commentUrl ? (
                <a href={revision.commentUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1">
                  Comment on GitHub <LinkExternalIcon size={12} />
                </a>
              ) : null}
            </div>
            <blockquote className="mt-2 border-l-4 border-line pl-3 text-sm text-fg-muted">{revision.request}</blockquote>
            {revision.summary || revision.answer ? (
              <div className="mt-2">
                <MarkdownView source={revision.answer ?? revision.summary ?? ""} size="sm" />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function RevisionOutcome({ revision, active }: { readonly revision: ChangeRevision; readonly active: boolean }) {
  if (active) return <span className="Label Label--accent">In progress</span>;
  if (revision.outcome === "pushed") return <span className="Label Label--success">Pushed {revision.commitSha?.slice(0, 7)}</span>;
  if (revision.outcome === "no_changes") return <span className="Label Label--secondary">No changes</span>;
  if (!revision.completedAt) return <span className="Label Label--attention">Not finished</span>;
  return null;
}

function RequestChanges({ workOrder, active }: { readonly workOrder: WorkOrder; readonly active: boolean }) {
  const pull = workOrder.github!.pullRequest;
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 240)}px`;
  }, [text]);

  const closed = pull && pull.state !== "open";
  const blocked = active
    ? "The factory is working on the last request. Ask for more once it finishes."
    : closed
      ? `Pull request #${pull.number} is ${pull.state}. Start a new work order for more changes.`
      : workOrder.status === "failed" || workOrder.status === "cancelled"
        ? "This work order stopped. Retry it from the menu above before asking for more."
        : undefined;
  const number = formatWorkOrderNumber(workOrder.number);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (blocked || text.trim().length < 3) return;
    setSubmitting(true);
    try {
      await reviseWorkOrder(workOrder.id, text.trim());
      setText("");
      toast.success(`${number}: changes requested`, pull ? `The developer is updating #${pull.number} in the same sandbox.` : "The developer is on it in the same sandbox.");
      navigate(workOrderHref(workOrder.id, "floor"));
    } catch (error) {
      toast.error("Couldn't request changes", errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="Box" onSubmit={(event) => void submit(event)} aria-label="Request changes">
      <div className="Box-header px-4 py-2">
        <h3 className="Box-title">{pull ? "Request changes" : "Ask a follow-up"}</h3>
      </div>
      <div className="p-4">
        <textarea
          ref={input}
          rows={3}
          value={text}
          disabled={Boolean(blocked) || submitting}
          onChange={(event) => setText(event.target.value)}
          placeholder={pull ? "What should change? e.g. “Use the brand blue for the button, and show the error under the field.”" : "What should the factory do next?"}
          className="form-control input-block resize-y"
          aria-describedby="revise-help"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <p id="revise-help" className="text-xs text-fg-muted sm:mr-auto">
            {blocked ?? (pull ? `The developer changes the same working tree, the reviewer checks it, and the factory pushes a new commit to #${pull.number} with fresh screenshots.` : "The developer picks up where it left off.")}
          </p>
          <Button type="submit" variant="primary" loading={submitting} disabled={Boolean(blocked) || text.trim().length < 3}>
            {pull ? "Request changes" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function MergeBox({ workOrder, pull, active }: { readonly workOrder: WorkOrder; readonly pull: PullRequestView; readonly active: boolean }) {
  const [merging, setMerging] = useState(false);
  const now = useNow(30_000);
  if (pull.state === "merged") {
    return (
      <section className="Box">
        <div className="flex items-start gap-2 p-4">
          <GitMergeIcon size={16} className="mt-0.5 shrink-0 text-fg-done" />
          <p className="text-sm">
            <span className="font-semibold">Merged</span>
            {pull.mergedBy ? ` by @${pull.mergedBy}` : ""} {pull.mergedAt ? formatRelative(pull.mergedAt, now) : ""}.
          </p>
        </div>
      </section>
    );
  }
  if (pull.state === "closed") {
    return (
      <section className="Box">
        <div className="flex items-start gap-2 p-4">
          <GitPullRequestClosedIcon size={16} className="mt-0.5 shrink-0 text-fg-closed" />
          <p className="text-sm">Closed without merging.</p>
        </div>
      </section>
    );
  }
  const conflicted = pull.mergeable === false || pull.mergeableState === "dirty";
  const blockedByRules = pull.mergeableState === "blocked";
  const merge = async (): Promise<void> => {
    const ok = await confirmAction({
      title: `Squash and merge #${pull.number}?`,
      message: `This merges “${pull.title}” into ${pull.baseRef} on GitHub as one commit.`,
      confirmLabel: "Squash and merge",
    });
    if (!ok) return;
    setMerging(true);
    try {
      await mergePullRequest(workOrder.id, "squash");
      toast.success(`Merged #${pull.number}`, `The change is on ${pull.baseRef}.`);
    } catch (error) {
      toast.error(`Couldn't merge #${pull.number}`, errorMessage(error));
    } finally {
      setMerging(false);
    }
  };
  return (
    <section className="Box">
      <div className="Box-header px-4 py-2">
        <h3 className="Box-title">Merge</h3>
      </div>
      <div className="space-y-3 p-4">
        <p className="flex items-start gap-2 text-xs">
          {conflicted ? (
            <XCircleFillIcon size={16} className="shrink-0 text-fg-danger" />
          ) : (
            <CheckCircleFillIcon size={16} className={cx("shrink-0", blockedByRules ? "text-fg-attention" : "text-fg-success")} />
          )}
          <span>
            {conflicted
              ? `This branch has conflicts with ${pull.baseRef}. Resolve them on GitHub.`
              : blockedByRules
                ? "GitHub's branch rules still block merging (required reviews or checks)."
                : pull.mergeable === undefined || pull.mergeable === null
                  ? "GitHub is still checking whether it merges cleanly."
                  : `No conflicts with ${pull.baseRef}.`}
          </span>
        </p>
        <Button variant="primary" icon={GitMergeIcon} className="w-full justify-center" loading={merging} disabled={active || conflicted || merging} onClick={() => void merge()} title={active ? "Wait for the current request to finish" : undefined}>
          Squash and merge
        </Button>
        <a href={`${pull.htmlUrl}/files`} target="_blank" rel="noreferrer" className={cx(buttonClass("default", "sm"), "w-full justify-center")}>
          <FileDiffIcon size={16} />
          Review the diff on GitHub
        </a>
      </div>
    </section>
  );
}

function ChecksBox({ revision }: { readonly revision: ChangeRevision }) {
  const check = revision.check;
  return (
    <section className="Box">
      <div className="Box-header px-4 py-2">
        <h3 className="Box-title">Checks</h3>
      </div>
      <div className="p-4 text-xs">
        {check ? (
          <>
            <p className="flex items-start gap-2">
              {check.passed ? <CheckCircleFillIcon size={16} className="shrink-0 text-fg-success" /> : <XCircleFillIcon size={16} className="shrink-0 text-fg-danger" />}
              <span>
                <code className="inline-code break-all">{check.command}</code> {check.passed ? "passed" : check.exitCode === undefined ? "didn't finish" : `failed (exit ${check.exitCode})`} in the sandbox · {formatDuration(check.durationMs)}
              </span>
            </p>
            {check.output ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-fg-muted">Output</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-canvas-inset p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">{check.output}</pre>
              </details>
            ) : null}
          </>
        ) : (
          <p className="text-fg-muted">{revision.testCommand ? "Not run yet." : "The developer gave no test command."}</p>
        )}
      </div>
    </section>
  );
}

function ReviewBox({ workOrder }: { readonly workOrder: WorkOrder }) {
  const review = workOrder.stations.find((station) => station.kind === "review");
  const last = latestReview(review);
  return (
    <section className="Box">
      <div className="Box-header px-4 py-2">
        <h3 className="Box-title">Review</h3>
      </div>
      <div className="p-4 text-xs">
        {last ? (
          <>
            <p className="flex items-start gap-2">
              {last.verdict === "approve" && !review?.acceptedWithFindings ? (
                <CheckCircleFillIcon size={16} className="shrink-0 text-fg-success" />
              ) : (
                <CodeReviewIcon size={16} className="shrink-0 text-fg-attention" />
              )}
              <span>
                <span className="font-semibold">{last.verdict === "approve" ? "Approved" : review?.acceptedWithFindings ? "Accepted with findings" : "Changes requested"}</span>
                {review?.model ? ` by ${review.model}` : ""}
                {last.findings.length > 0 ? ` · ${pluralize(last.findings.length, "finding")}` : ""}
              </span>
            </p>
            <p className="mt-2 text-fg-muted">{last.summary}</p>
            <a href={workOrderHref(workOrder.id, "floor", { station: review?.id })} className="mt-2 inline-block font-semibold">
              Every round on the floor
            </a>
          </>
        ) : (
          <p className="text-fg-muted">{review?.status === "skipped" ? "Nothing to review." : "Not reviewed yet."}</p>
        )}
      </div>
    </section>
  );
}

function FilesBox({ workOrder, revision }: { readonly workOrder: WorkOrder; readonly revision: ChangeRevision }) {
  const files = revision.files ?? [];
  const build = workOrder.stations.find((station) => station.kind === "build");
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <section className="Box">
      <div className="Box-header flex items-center gap-2 px-4 py-2">
        <h3 className="Box-title">Files changed</h3>
        <span className="Counter">{files.length}</span>
        {files.length > 0 ? (
          <span className="ml-auto font-mono text-xs">
            <span className="text-fg-success">+{additions}</span> <span className="text-fg-danger">−{deletions}</span>
          </span>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="p-4 text-xs text-fg-muted">No files changed.</p>
      ) : (
        <>
          <ul className="max-h-72 overflow-auto">
            {files.map((file) => (
              <li key={file.path} className="Box-row flex items-center gap-2 px-4 py-1.5 text-xs">
                <span className={cx("w-3 shrink-0 font-mono font-semibold", file.status === "added" ? "text-fg-success" : file.status === "deleted" ? "text-fg-danger" : "text-fg-attention")} title={file.status}>
                  {file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                  {file.path}
                </span>
                {file.additions !== undefined ? (
                  <span className="shrink-0 font-mono">
                    <span className="text-fg-success">+{file.additions}</span> <span className="text-fg-danger">−{file.deletions}</span>
                  </span>
                ) : (
                  <span className="shrink-0 text-fg-muted">binary</span>
                )}
              </li>
            ))}
          </ul>
          {build ? (
            <div className="border-t border-line-muted px-4 py-2">
              <a href={workOrderHref(workOrder.id, "artifacts", { station: build.id, path: "change.patch" })} className="inline-flex items-center gap-1 text-xs font-semibold">
                <GitBranchIcon size={12} />
                View the diff
              </a>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
