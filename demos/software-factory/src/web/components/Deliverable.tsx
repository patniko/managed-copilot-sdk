import { BeakerIcon, CopilotIcon, DownloadIcon, FileDiffIcon, PackageIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { WorkOrder } from "../../shared/types.js";
import { bundleUrl } from "../lib/api.js";
import { basename, pickReleaseArtifact } from "../lib/artifacts.js";
import { elapsedBetween, formatBytes, formatDuration, formatFullDateTime, formatRelative, pluralize } from "../lib/format.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { isWorkOrderActive, latestReview, stationStatusMeta, taskRows, type TaskRow } from "../lib/stations.js";
import { useArtifactIndex } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { RoundDots } from "./StationCard.js";
import { ChecksSummary } from "./TestBar.js";
import { Button, buttonClass } from "./ui/Button.js";
import { StatusIcon } from "./ui/Chip.js";
import { Callout, EmptyState } from "./ui/Feedback.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

/** The release like a GitHub Release: the download first, then the notes and assets; checks and tasks beside it. */
export function DeliverableView({ workOrder }: { readonly workOrder: WorkOrder }) {
  const release = workOrder.release;
  const releaseStation = workOrder.stations.find((station) => station.kind === "release");
  const index = useArtifactIndex(workOrder.id, Boolean(release))?.data;
  const now = useNow(1000, isWorkOrderActive(workOrder.status));

  if (!release) {
    return (
      <div className="Box">
        <EmptyState icon={PackageIcon} title="No deliverable yet" size="lg">
          It appears once every task is approved and the release is packaged.
        </EmptyState>
      </div>
    );
  }

  const failed = releaseStation?.status === "failed" || workOrder.status === "failed";
  const downloadable = workOrder.status === "completed";
  const tests = release.tests ?? workOrder.tests;
  const duration = elapsedBetween(workOrder.startedAt ?? workOrder.createdAt, workOrder.completedAt, now);
  const patch = index ? pickReleaseArtifact(index, workOrder, "patch") : undefined;
  const report = index ? pickReleaseArtifact(index, workOrder, "test-report") : undefined;
  const failure = releaseStation?.error ?? workOrder.error;
  const project = workOrder.plan?.projectName ?? workOrder.title;
  const releasedAt = releaseStation?.finishedAt ?? workOrder.completedAt;
  const bundle = `${project}.zip`;

  const open = (file: { readonly stationId: string; readonly path: string } | undefined): void => {
    if (file) navigate(workOrderHref(workOrder.id, "artifacts", { station: file.stationId, path: file.path }));
  };

  return (
    <div className="mx-auto grid max-w-[1280px] gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-labelledby="release-title" className="Box min-w-0">
        <div className="p-4 md:p-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 id="release-title" className="text-xl font-semibold break-words">
              {project}
            </h2>
            {failed ? (
              <span className="Label Label--danger Label--large">Release failed</span>
            ) : (
              <span className="Label Label--success Label--large">Release ready</span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-muted">
            <span className="avatar avatar--square grid size-5 place-items-center text-fg" aria-hidden>
              <CopilotIcon size={12} />
            </span>
            <span className="font-semibold text-fg">@{releaseStation?.agent ?? "release"}</span>
            {releasedAt ? <span title={formatFullDateTime(releasedAt)}>· {formatRelative(releasedAt, now)}</span> : null}
            {duration !== undefined ? <span>· took {formatDuration(duration)}</span> : null}
          </p>
          {failed ? (
            <Callout tone="danger" compact className="mt-4">
              {failure?.message ?? "The release station couldn't finish. Its activity on the floor has the details."}
            </Callout>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            {downloadable ? (
              <a href={bundleUrl(workOrder.id)} download className={buttonClass("primary", "lg")}>
                <DownloadIcon size={16} />
                Download release
              </a>
            ) : (
              <Button variant="primary" size="lg" icon={DownloadIcon} disabled title="Available when the work order completes">
                Download release
              </Button>
            )}
            <span className="text-xs text-fg-muted tabular-nums">
              {bundle} · {formatBytes(release.bytes)} · {pluralize(release.files, "file")}
            </span>
          </div>
        </div>

        <div className="border-t border-line-muted p-4 md:p-6">
          <h3 className="sr-only">Release notes</h3>
          {release.notes ? (
            <MarkdownView source={release.notes} size="md" />
          ) : (
            <p className="text-fg-muted">No release notes were written.</p>
          )}
        </div>

        <div className="border-t border-line-muted">
          <h3 className="flex items-center gap-2 px-4 pt-4 pb-2 text-base font-semibold md:px-6">
            Assets <span className="Counter">3</span>
          </h3>
          <ul className="mx-4 mb-4 rounded-md border border-line md:mx-6 md:mb-6">
            <Asset icon={PackageIcon} name={bundle} size={formatBytes(release.bytes)}>
              {downloadable ? (
                <a href={bundleUrl(workOrder.id)} download className={buttonClass("default", "sm")}>
                  <DownloadIcon size={16} />
                  Download
                </a>
              ) : (
                <Button size="sm" icon={DownloadIcon} disabled title="Available when the work order completes">
                  Download
                </Button>
              )}
            </Asset>
            <Asset
              icon={FileDiffIcon}
              name={patch ? basename(patch.path) : "Patch"}
              size={release.patchBytes !== undefined ? formatBytes(release.patchBytes) : undefined}
              missing={patch ? undefined : "Not published"}
            >
              <Button size="sm" disabled={!patch} onClick={() => open(patch)}>
                View patch
              </Button>
            </Asset>
            <Asset icon={BeakerIcon} name={report ? basename(report.path) : "Test report"} missing={report ? undefined : "Not published"}>
              <Button size="sm" disabled={!report} onClick={() => open(report)}>
                View report
              </Button>
            </Asset>
          </ul>
        </div>
      </section>

      <aside className="min-w-0 space-y-4" aria-label="Release summary">
        <section className="Box">
          <div className="Box-header px-4 py-2">
            <h3 className="Box-title">Checks</h3>
          </div>
          <div className="p-4">
            {tests ? (
              <ChecksSummary counts={tests} meta={tests.durationMs !== undefined ? formatDuration(tests.durationMs) : undefined} />
            ) : (
              <p className="text-fg-muted">No test results were reported.</p>
            )}
          </div>
        </section>
        <TaskOutcomes workOrder={workOrder} />
      </aside>
    </div>
  );
}

function Asset({
  icon: Glyph,
  name,
  size,
  missing,
  children,
}: {
  readonly icon: Icon;
  readonly name: string;
  readonly size?: string;
  readonly missing?: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-t border-line-muted px-3 py-2 first:border-t-0">
      <Glyph size={16} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate font-semibold" title={name}>
        {name}
        {missing ? <span className="font-normal text-fg-muted"> · {missing}</span> : null}
      </span>
      {size ? <span className="shrink-0 text-xs text-fg-muted tabular-nums">{size}</span> : null}
      {children}
    </li>
  );
}

/** "Approved · 22 tests" or "Accepted with 1 finding · 12 tests". */
function outcomeText(row: TaskRow): string {
  const review = row.review;
  const parts: string[] = [];
  if (!review) parts.push("Not reviewed");
  else if (review.status === "done" && review.acceptedWithFindings) {
    parts.push(`Accepted with ${pluralize(latestReview(review)?.findings.length ?? 0, "finding")}`);
  } else parts.push(stationStatusMeta(review).label);
  if (row.build?.tests) parts.push(pluralize(row.build.tests.passed, "test"));
  return parts.join(" · ");
}

function TaskOutcomes({ workOrder }: { readonly workOrder: WorkOrder }) {
  const rows = taskRows(workOrder);
  return (
    <section className="Box">
      <div className="Box-header px-4 py-2">
        <h3 className="Box-title">Tasks</h3>
        <span className="Counter">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="p-4 text-fg-muted">No tasks.</p>
      ) : (
        <ul>
          {rows.map((row) => {
            const station = row.review ?? row.build;
            const rounds = row.review?.reviews?.length ?? row.review?.round ?? 0;
            return (
              <li key={row.id} className="Box-row flex items-start gap-2 px-4 py-3">
                {station ? <StatusIcon meta={stationStatusMeta(station)} className="mt-0.5 shrink-0" /> : null}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <a
                      href={workOrderHref(workOrder.id, "floor", { station: row.review?.id ?? row.build?.id })}
                      className="Link--primary min-w-0 truncate font-semibold"
                      title={row.title}
                    >
                      {row.title}
                    </a>
                    {rounds > 0 ? <RoundDots round={rounds} max={workOrder.maxReviewRounds} className="ml-auto" /> : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">{outcomeText(row)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
