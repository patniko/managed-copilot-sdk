import { BeakerIcon, CopilotIcon, DownloadIcon, FileDiffIcon, PackageIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { WorkOrder } from "../../shared/types.js";
import { bundleUrl } from "../lib/api.js";
import { basename, pickReleaseArtifact } from "../lib/artifacts.js";
import { elapsedBetween, formatBytes, formatDuration, formatFullDateTime, formatRelative, pluralize } from "../lib/format.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { isWorkOrderActive, stationStatusMeta, taskRows, type TaskRow } from "../lib/stations.js";
import { useArtifactIndex } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import type { Tone } from "../lib/tone.js";
import { ChecksSummary } from "./TestBar.js";
import { Button, buttonClass } from "./ui/Button.js";
import { Chip, StatusIcon } from "./ui/Chip.js";
import { Callout, EmptyState } from "./ui/Feedback.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

/** The release like a GitHub Release: title and marker, notes, assets, and a sidebar with checks and tasks. */
export function DeliverableView({ workOrder }: { readonly workOrder: WorkOrder }) {
  const release = workOrder.release;
  const releaseStation = workOrder.stations.find((station) => station.kind === "release");
  const index = useArtifactIndex(workOrder.id, Boolean(release))?.data;
  const now = useNow(1000, isWorkOrderActive(workOrder.status));

  if (!release) {
    return (
      <div className="Box">
        <EmptyState icon={PackageIcon} title="No deliverable yet" size="lg">
          The release station packages the deliverable once every task is approved: the bundle, a patch, a test report, and
          release notes.
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
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-fg-muted">
            <span className="avatar avatar--square grid size-5 place-items-center text-fg" aria-hidden>
              <CopilotIcon size={12} />
            </span>
            <span className="font-semibold text-fg">@{releaseStation?.agent ?? "release"}</span>
            {failed ? "couldn't finish this release" : "released this"}
            {releasedAt ? (
              <span title={formatFullDateTime(releasedAt)}>{formatRelative(releasedAt, now)}</span>
            ) : null}
            {duration !== undefined ? <span>· took {formatDuration(duration)}</span> : null}
          </p>
          {failed ? (
            <Callout tone="danger" compact className="mt-4">
              {failure?.message ?? "The release station couldn't finish. Its activity has the details."}
            </Callout>
          ) : (
            <p className="mt-3">{project} is integrated, tested, and packaged.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {downloadable ? (
              <a href={bundleUrl(workOrder.id)} download className={buttonClass("primary")}>
                <DownloadIcon size={16} />
                Download release (.zip)
              </a>
            ) : (
              <Button variant="primary" icon={DownloadIcon} disabled title="Available when the work order completes">
                Download release (.zip)
              </Button>
            )}
          </div>
        </div>

        <div className="border-t border-line-muted p-4 md:p-6">
          <h3 className="sr-only">Release notes</h3>
          {release.notes ? (
            <MarkdownView source={release.notes} size="md" />
          ) : (
            <p className="text-fg-muted">The release station didn't write release notes.</p>
          )}
        </div>

        <div className="border-t border-line-muted">
          <h3 className="flex items-center gap-2 px-4 pt-4 pb-2 text-base font-semibold md:px-6">
            Assets <span className="Counter">3</span>
          </h3>
          <ul className="mx-4 mb-4 rounded-md border border-line md:mx-6 md:mb-6">
            <Asset icon={PackageIcon} name={`${project}.zip`} size={formatBytes(release.bytes)} detail={pluralize(release.files, "file")}>
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
              detail={patch ? undefined : "No patch was published"}
            >
              <Button size="sm" disabled={!patch} onClick={() => open(patch)} title={patch ? undefined : "No patch was published"}>
                View patch
              </Button>
            </Asset>
            <Asset
              icon={BeakerIcon}
              name={report ? basename(report.path) : "Test report"}
              detail={report ? undefined : "No test report was published"}
            >
              <Button size="sm" disabled={!report} onClick={() => open(report)} title={report ? undefined : "No test report was published"}>
                View test report
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
        <section className="Box">
          <div className="Box-header px-4 py-2">
            <h3 className="Box-title">Summary</h3>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 p-4">
            <Fact label="Files">{release.files}</Fact>
            <Fact label="Bundle size">{formatBytes(release.bytes)}</Fact>
            <Fact label="Patch size">{release.patchBytes !== undefined ? formatBytes(release.patchBytes) : <span className="text-fg-muted">—</span>}</Fact>
            <Fact label="Total time">{duration !== undefined ? formatDuration(duration) : <span className="text-fg-muted">—</span>}</Fact>
          </dl>
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
  detail,
  children,
}: {
  readonly icon: Icon;
  readonly name: string;
  readonly size?: string;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-muted px-3 py-2 first:border-t-0">
      <Glyph size={16} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{name}</span>
        {detail ? <span className="block text-xs text-fg-muted">{detail}</span> : null}
      </span>
      {size ? <span className="text-xs text-fg-muted tabular-nums">{size}</span> : null}
      {children}
    </li>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-right font-semibold tabular-nums">{children}</dd>
    </>
  );
}

function outcome(row: TaskRow): { readonly label: string; readonly tone: Tone | "plain" } {
  const review = row.review;
  if (!review) return { label: "Not reviewed", tone: "plain" };
  if (review.status === "done") return review.acceptedWithFindings ? { label: "Accepted with findings", tone: "warning" } : { label: "Approved", tone: "success" };
  if (review.status === "failed" || row.build?.status === "failed") return { label: "Failed", tone: "danger" };
  return { label: stationStatusMeta(review).label, tone: "plain" };
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
            const result = outcome(row);
            const rounds = row.review?.reviews?.length ?? row.review?.round ?? 0;
            const openFindings = row.review?.acceptedWithFindings
              ? (row.review.reviews?.[row.review.reviews.length - 1]?.findings.length ?? 0)
              : 0;
            const station = row.review ?? row.build;
            return (
              <li key={row.id} className="Box-row px-4 py-3">
                <div className="flex items-start gap-2">
                  {station ? <StatusIcon meta={stationStatusMeta(station)} className="mt-0.5 shrink-0" /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <a
                        href={workOrderHref(workOrder.id, "floor", { station: row.review?.id ?? row.build?.id })}
                        className="Link--primary min-w-0 truncate font-semibold"
                      >
                        {row.title}
                      </a>
                      <Chip tone={result.tone} className="shrink-0">
                        {result.label}
                      </Chip>
                    </div>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {rounds > 0 ? `${pluralize(rounds, "review round")} of ${workOrder.maxReviewRounds}` : "No review rounds"}
                      {row.build?.tests ? ` · ${row.build.tests.passed} tests passed` : ""}
                      {openFindings > 0 ? ` · ${pluralize(openFindings, "open finding")}` : ""}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
