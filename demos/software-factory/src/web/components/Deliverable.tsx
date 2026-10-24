import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleX, Clock, Download, FileDiff, Files, FlaskConical, HardDrive, PackageOpen, ScrollText } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkOrder } from "../../shared/types.js";
import { bundleUrl } from "../lib/api.js";
import { pickReleaseArtifact } from "../lib/artifacts.js";
import { cx } from "../lib/cx.js";
import { elapsedBetween, formatBytes, formatDuration, pluralize } from "../lib/format.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { isWorkOrderActive, stationStatusMeta, taskRows, type TaskRow } from "../lib/stations.js";
import { useArtifactIndex } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { TestBar } from "./TestBar.js";
import { Button, buttonClass } from "./ui/Button.js";
import { Chip } from "./ui/Chip.js";
import { EmptyState, SectionLabel } from "./ui/Feedback.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

export function DeliverableView({ workOrder }: { readonly workOrder: WorkOrder }) {
  const release = workOrder.release;
  const releaseStation = workOrder.stations.find((station) => station.kind === "release");
  const index = useArtifactIndex(workOrder.id, Boolean(release))?.data;
  const now = useNow(1000, isWorkOrderActive(workOrder.status));

  if (!release) {
    return (
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30">
        <EmptyState icon={PackageOpen} title="No deliverable yet">
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

  const open = (file: { readonly stationId: string; readonly path: string } | undefined): void => {
    if (file) navigate(workOrderHref(workOrder.id, "artifacts", { station: file.stationId, path: file.path }));
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section
        className={cx(
          "relative overflow-hidden rounded-2xl border p-6 sm:p-7",
          failed ? "border-rose-400/30 bg-rose-400/[0.05]" : "border-emerald-400/30 bg-emerald-400/[0.05]",
        )}
      >
        <div
          className={cx(
            "pointer-events-none absolute -top-24 -right-16 size-72 rounded-full blur-3xl",
            failed ? "bg-rose-500/10" : "bg-emerald-500/10",
          )}
          aria-hidden
        />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <span
            className={cx(
              "grid size-14 shrink-0 place-items-center rounded-2xl ring-1 ring-inset",
              failed ? "bg-rose-400/15 text-rose-300 ring-rose-400/30" : "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
            )}
          >
            {failed ? <CircleX className="size-7" aria-hidden /> : <CircleCheck className="size-7" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className={cx("text-xl font-semibold", failed ? "text-rose-50" : "text-emerald-50")}>
              {failed ? "Release failed" : "Release ready"}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">
              {failed
                ? (failure?.message ?? "The release station couldn't finish. Its activity has the details.")
                : `${workOrder.plan?.projectName ?? workOrder.title} is integrated, tested, and packaged.`}
            </p>
          </div>
        </div>
        <div className="relative mt-6 flex flex-wrap gap-2">
          {downloadable ? (
            <a href={bundleUrl(workOrder.id)} download className={buttonClass("primary", "lg")}>
              <Download className="size-4" aria-hidden />
              Download release (.zip)
            </a>
          ) : (
            <Button variant="primary" size="lg" icon={Download} disabled title="Available when the work order completes">
              Download release (.zip)
            </Button>
          )}
          <Button size="lg" icon={FileDiff} disabled={!patch} onClick={() => open(patch)} title={patch ? undefined : "No patch was published"}>
            View patch
          </Button>
          <Button
            size="lg"
            icon={FlaskConical}
            disabled={!report}
            onClick={() => open(report)}
            title={report ? undefined : "No test report was published"}
          >
            View test report
          </Button>
        </div>
      </section>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Tile icon={FlaskConical} label="Tests" tone={tests && tests.failed > 0 ? "danger" : "success"}>
          {tests ? (
            <>
              <span>
                {tests.passed}
                <span className="text-zinc-500">/{tests.total}</span>
              </span>
              <TestBar counts={tests} className="mt-2" />
              {tests.failed > 0 || tests.skipped > 0 ? (
                <span className="mt-1.5 block text-[11px] font-normal text-zinc-500">
                  {[tests.failed > 0 ? `${tests.failed} failed` : "", tests.skipped > 0 ? `${tests.skipped} skipped` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-zinc-500">—</span>
          )}
        </Tile>
        <Tile icon={Files} label="Files">
          {release.files}
        </Tile>
        <Tile icon={HardDrive} label="Bundle size">
          {formatBytes(release.bytes)}
        </Tile>
        <Tile icon={FileDiff} label="Patch size">
          {release.patchBytes !== undefined ? formatBytes(release.patchBytes) : <span className="text-zinc-500">—</span>}
        </Tile>
        <Tile icon={Clock} label="Total time">
          {duration !== undefined ? formatDuration(duration) : <span className="text-zinc-500">—</span>}
        </Tile>
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-2">
            <ScrollText className="size-4 text-zinc-500" aria-hidden />
            <SectionLabel>Release notes</SectionLabel>
          </div>
          {release.notes ? (
            <MarkdownView source={release.notes} className="mt-4" />
          ) : (
            <p className="mt-3 text-[13px] text-zinc-500">The release station didn't write release notes.</p>
          )}
        </section>
        <TaskOutcomes workOrder={workOrder} />
      </div>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  tone,
  children,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone?: "success" | "danger";
  readonly children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
      <dt className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </dt>
      <dd
        className={cx(
          "mt-1.5 text-xl font-semibold tabular",
          tone === "success" ? "text-emerald-200" : tone === "danger" ? "text-rose-200" : "text-zinc-50",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function outcome(row: TaskRow): { readonly label: string; readonly tone: "success" | "warning" | "danger" | "plain" } {
  const review = row.review;
  if (!review) return { label: "Not reviewed", tone: "plain" };
  if (review.status === "done") return review.acceptedWithFindings ? { label: "Accepted with findings", tone: "warning" } : { label: "Approved", tone: "success" };
  if (review.status === "failed" || row.build?.status === "failed") return { label: "Failed", tone: "danger" };
  return { label: stationStatusMeta(review).label, tone: "plain" };
}

function TaskOutcomes({ workOrder }: { readonly workOrder: WorkOrder }) {
  const rows = taskRows(workOrder);
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5">
      <SectionLabel>Tasks</SectionLabel>
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-zinc-500">No tasks.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => {
            const result = outcome(row);
            const rounds = row.review?.reviews?.length ?? row.review?.round ?? 0;
            const openFindings = row.review?.acceptedWithFindings
              ? (row.review.reviews?.[row.review.reviews.length - 1]?.findings.length ?? 0)
              : 0;
            return (
              <li key={row.id} className="rounded-xl bg-zinc-950/50 p-3 ring-1 ring-inset ring-white/5">
                <div className="flex items-start justify-between gap-2">
                  <a
                    href={workOrderHref(workOrder.id, "floor", { station: row.review?.id ?? row.build?.id })}
                    className="min-w-0 truncate text-[13px] font-medium text-zinc-100 hover:text-amber-200"
                  >
                    {row.title}
                  </a>
                  <Chip tone={result.tone}>{result.label}</Chip>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {rounds > 0 ? `${pluralize(rounds, "review round")} of ${workOrder.maxReviewRounds}` : "No review rounds"}
                  {row.build?.tests ? ` · ${row.build.tests.passed} tests passed` : ""}
                  {openFindings > 0 ? ` · ${pluralize(openFindings, "open finding")}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
