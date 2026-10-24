import { ArrowDown, ChevronDown, CircleCheck, Inbox, SquareTerminal, X } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AttachResponse, ReviewFinding, ReviewRecord, Station, WorkOrder } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import {
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatFullDateTime,
  formatRelative,
  formatSandboxSize,
  shortId,
  shortImage,
  summarizeNetwork,
} from "../lib/format.js";
import { isStationActive, KIND_ICONS, stationElapsed, stationStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { TONE_TILE } from "../lib/tone.js";
import { ActivityStream } from "./ActivityStream.js";
import { NetworkChip, useEnvironment } from "./StationCard.js";
import { Button, IconButton } from "./ui/Button.js";
import { Chip, StatusBadge } from "./ui/Chip.js";
import { CopyButton } from "./ui/CopyButton.js";
import { Callout, SectionLabel } from "./ui/Feedback.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

/** Keeps a scroll container pinned to the bottom while new content arrives, unless the user scrolls up. */
function useStickToBottom(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  startAtBottom: boolean,
): { readonly showJump: boolean; readonly hasNew: boolean; readonly jump: () => void } {
  const pinned = useRef(startAtBottom);
  const [away, setAway] = useState(false);
  const [hasNew, setHasNew] = useState(false);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const distance = (): number => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (startAtBottom) scroller.scrollTop = scroller.scrollHeight;
    let lastTop = scroller.scrollTop;
    let lastHeight = content.offsetHeight;
    const onScroll = (): void => {
      const top = scroller.scrollTop;
      const remaining = distance();
      if (remaining < 40) {
        pinned.current = true;
        setHasNew(false);
      } else if (top < lastTop - 1) {
        // Only an upward scroll unpins; content growing below must not.
        pinned.current = false;
      }
      lastTop = top;
      setAway(!pinned.current && remaining > 160);
    };
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      if (pinned.current) {
        scroller.scrollTop = scroller.scrollHeight;
        lastTop = scroller.scrollTop;
      } else if (height > lastHeight && distance() > 40) {
        setHasNew(true);
      }
      lastHeight = height;
      setAway(!pinned.current && distance() > 160);
    });
    observer.observe(content);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
    // The panel is keyed by station, so this runs once per station.
  }, [scrollRef, contentRef, startAtBottom]);

  const jump = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    pinned.current = true;
    setHasNew(false);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  return { showJump: away || (hasNew && !pinned.current), hasNew, jump };
}

const PANEL_CLASS =
  "relative flex min-w-0 flex-col overflow-clip rounded-2xl border border-zinc-800/80 bg-zinc-900/40 shadow-xl shadow-black/20 xl:h-full";
const SCROLL_CLASS = "min-h-0 flex-1 overflow-y-auto overscroll-contain max-xl:max-h-[80vh]";

export function StationPanel({ workOrder, station }: { readonly workOrder: WorkOrder; readonly station: Station }) {
  // Follow live output for stations that are running (or about to); start the others at the top (details, reviews).
  const [follow] = useState(() => isStationActive(station.status) || station.status === "waiting");
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { showJump, hasNew, jump } = useStickToBottom(scroller, content, follow);

  return (
    <section aria-label={`${station.title} station`} className={PANEL_CLASS}>
      <PanelHeader station={station} />
      <div ref={scroller} className={SCROLL_CLASS}>
        <div ref={content} className="space-y-6 p-4">
          <Details workOrder={workOrder} station={station} />
          {station.kind === "review" ? <ReviewHistory station={station} /> : null}
          {station.acceptedWithFindings ? (
            <Callout tone="warning" title="Accepted with open findings">
              The reviewer still had findings after the last allowed round, so the factory accepted the work and moved on.
            </Callout>
          ) : null}
          {station.error ? (
            <Callout tone="danger" role="alert" title="This station failed">
              <span>{station.error.message}</span>{" "}
              <code className="ml-1 rounded bg-black/30 px-1.5 py-px font-mono text-[11px] text-rose-200">{station.error.code}</code>
            </Callout>
          ) : null}
          <section aria-label="Activity">
            <SectionLabel>Activity</SectionLabel>
            <div className="mt-3">
              <ActivityStream workOrder={workOrder} station={station} />
            </div>
          </section>
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 animate-rise-in items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 shadow-lg shadow-black/40 hover:bg-white"
        >
          {hasNew && isStationActive(station.status) ? <span className="size-1.5 rounded-full bg-sky-500" aria-hidden /> : null}
          <ArrowDown className="size-3.5" aria-hidden />
          Jump to latest
        </button>
      ) : null}
    </section>
  );
}

type AttachState =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly result: AttachResponse; readonly failed: boolean };

function PanelHeader({ station }: { readonly station: Station }) {
  const meta = stationStatusMeta(station);
  const active = isStationActive(station.status);
  const now = useNow(1000, active);
  const elapsed = stationElapsed(station, now);
  const KindIcon = KIND_ICONS[station.kind];
  const attachAllowed = useStore((state) => state.platform?.features.attach ?? false);
  const attachTemplate = useStore((state) => state.attachCommand);
  const [attach, setAttach] = useState<AttachState>();
  const sessionId = station.sessionId;
  const sessionDeleted = station.sessionState === "deleted";

  const onAttach = async (): Promise<void> => {
    if (!sessionId) return;
    setAttach({ status: "pending" });
    try {
      const result = await api.attach(sessionId);
      setAttach({ status: "done", result, failed: false });
    } catch (error) {
      const command = attachTemplate ? attachTemplate.replace("{sessionId}", sessionId) : "";
      setAttach({
        status: "done",
        failed: true,
        result: { command, launched: false, message: `${errorMessage(error)} You can still attach from your own terminal.` },
      });
    }
  };

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-900/70 p-4">
      <div className="flex items-start gap-3">
        <span className={cx("grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset", TONE_TILE[meta.tone])}>
          <KindIcon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-zinc-50" title={station.title}>
            {station.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge meta={meta} />
            {station.round > 1 ? <Chip tone="warning">Round {station.round}</Chip> : null}
            {elapsed !== undefined ? (
              <span className="font-mono text-xs text-zinc-500 tabular" title={active ? "Elapsed" : "Duration"}>
                {active ? formatClock(elapsed) : formatDuration(elapsed)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {station.detail ? <p className="mt-2.5 text-[13px] leading-relaxed text-zinc-400">{station.detail}</p> : null}
      {sessionId && attachAllowed ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            icon={SquareTerminal}
            loading={attach?.status === "pending"}
            disabled={sessionDeleted}
            aria-describedby={sessionDeleted ? "attach-unavailable" : undefined}
            onClick={() => void onAttach()}
          >
            Open in Copilot CLI
          </Button>
          {sessionDeleted ? (
            <span id="attach-unavailable" className="text-xs text-zinc-500">
              This session was deleted on the platform.
            </span>
          ) : null}
        </div>
      ) : null}
      {attach?.status === "done" && !sessionDeleted ? <AttachResult state={attach} onDismiss={() => setAttach(undefined)} /> : null}
    </header>
  );
}

function AttachResult({
  state,
  onDismiss,
}: {
  readonly state: Extract<AttachState, { status: "done" }>;
  readonly onDismiss: () => void;
}) {
  const { result } = state;
  const launched = result.launched;
  return (
    <div
      role="status"
      className={cx(
        "mt-3 animate-rise-in rounded-xl border p-3",
        launched ? "border-emerald-400/25 bg-emerald-400/[0.06]" : "border-amber-400/25 bg-amber-400/[0.05]",
      )}
    >
      <div className="flex items-start gap-2">
        {launched ? (
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />
        ) : (
          <SquareTerminal className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        )}
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-zinc-200">
          {result.message || (launched ? "Opened Copilot CLI in a new terminal window." : "Run this command in a terminal to attach:")}
        </p>
        <IconButton icon={X} label="Dismiss" size="sm" onClick={onDismiss} />
      </div>
      {result.command ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-black/40 py-1.5 pr-1.5 pl-3 ring-1 ring-inset ring-white/10">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-100" title={result.command}>
            {result.command}
          </code>
          {launched ? (
            <CopyButton text={result.command} label="Copy attach command" size="sm" />
          ) : (
            <CopyButton text={result.command} label="Copy attach command" variant="primary" size="sm">
              Copy
            </CopyButton>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-zinc-200">{children}</dd>
    </>
  );
}

const TURN_LABELS: Readonly<Record<NonNullable<Station["turn"]>["kind"], string>> = {
  work: "Work",
  fix: "Fix review findings",
  nudge: "Nudge",
  review: "Review",
  retry: "Retry",
  continue: "Continue after restart",
};

function sessionStateTone(state: string): "active" | "danger" | "plain" {
  if (state === "deleted" || state === "failed" || state === "error") return "danger";
  if (state === "running" || state === "busy" || state === "active") return "active";
  return "plain";
}

function Mono({ children, title }: { readonly children: ReactNode; readonly title?: string }) {
  return (
    <code className="truncate font-mono text-[12px] text-zinc-200" title={title}>
      {children}
    </code>
  );
}

function Details({ workOrder, station }: { readonly workOrder: WorkOrder; readonly station: Station }) {
  const [open, setOpen] = useState(true);
  const environment = useEnvironment(station.environment);
  const active = isStationActive(station.status);
  const now = useNow(1000, active);
  const network = summarizeNetwork(station.sandbox?.network ?? environment?.network);
  const sandbox = station.sandbox;
  const elapsed = stationElapsed(station, now);
  const usage = station.usage;
  const model = station.model ?? environment?.model;

  return (
    <section aria-label="Details">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md text-left"
      >
        <SectionLabel>Details</SectionLabel>
        <ChevronDown className={cx("size-4 text-zinc-500 transition-transform", !open && "-rotate-90")} aria-hidden />
      </button>
      {open ? (
        <dl className="mt-3 grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5 text-[13px]">
          <Row label="Session">
            {station.sessionId ? (
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                <Mono title={station.sessionId}>{shortId(station.sessionId, 14)}</Mono>
                <CopyButton text={station.sessionId} label="Copy session id" />
                {station.sessionState ? (
                  <Chip tone={sessionStateTone(station.sessionState)} title="Session state on the platform">
                    {station.sessionState}
                  </Chip>
                ) : null}
              </span>
            ) : (
              <span className="text-zinc-500">Not started</span>
            )}
          </Row>
          {station.turn ? (
            <Row label="Turn">
              <span>
                {TURN_LABELS[station.turn.kind] ?? station.turn.kind}
                <span className="text-zinc-500">
                  {" "}
                  · round {station.turn.round} ·{" "}
                  {station.turn.completedAt
                    ? `finished ${formatRelative(station.turn.completedAt, now)}`
                    : `sent ${formatRelative(station.turn.sentAt, now)}`}
                </span>
              </span>
            </Row>
          ) : null}
          <Row label="Environment">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Mono>{station.environment || "—"}</Mono>
              {environment ? <Chip>{environment.type === "shared" ? "Shared" : "Isolated"}</Chip> : null}
            </span>
          </Row>
          <Row label="Placement">{station.placement === "sandbox" ? "Fresh isolated sandbox" : "Shared environment (no sandbox)"}</Row>
          <Row label="Agent">
            <span>
              @{station.agent} <span className="text-zinc-500">· {station.role}</span>
            </span>
          </Row>
          {model ? (
            <Row label="Model">
              <Mono title={model}>{model}</Mono>
            </Row>
          ) : null}
          {sandbox ? (
            <>
              <Row label="Sandbox">
                <span className="flex min-w-0 items-center gap-1">
                  <Mono title={sandbox.id}>{shortId(sandbox.id, 14)}</Mono>
                  <CopyButton text={sandbox.id} label="Copy sandbox id" />
                </span>
              </Row>
              <Row label="Size">{formatSandboxSize(sandbox.size)}</Row>
              <Row label="Sandbox state">
                <Chip tone={sandbox.state === "running" || sandbox.state === "ready" ? "active" : "plain"}>{sandbox.state}</Chip>
              </Row>
              {sandbox.image ? (
                <Row label="Image">
                  <span className="block truncate">
                    <Mono title={sandbox.image}>{shortImage(sandbox.image)}</Mono>
                  </span>
                </Row>
              ) : null}
            </>
          ) : station.placement === "sandbox" && environment?.size ? (
            <Row label="Size">{formatSandboxSize(environment.size)}</Row>
          ) : null}
          {network ? (
            <Row label="Network">
              <div className="space-y-1.5">
                <NetworkChip network={network} />
                {network.hosts.length > 0 ? (
                  <ul className="flex flex-wrap gap-1">
                    {network.hosts.map((host) => (
                      <li key={host}>
                        <Chip mono>{host}</Chip>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Row>
          ) : null}
          {station.startedAt ? (
            <Row label="Started">
              <span title={formatFullDateTime(station.startedAt)}>
                {formatDateTime(station.startedAt)} <span className="text-zinc-500">· {formatRelative(station.startedAt, now)}</span>
              </span>
            </Row>
          ) : null}
          {station.finishedAt ? (
            <Row label="Finished">
              <span title={formatFullDateTime(station.finishedAt)}>
                {formatDateTime(station.finishedAt)}
                {elapsed !== undefined ? <span className="text-zinc-500"> · took {formatDuration(elapsed)}</span> : null}
              </span>
            </Row>
          ) : active && elapsed !== undefined ? (
            <Row label="Elapsed">
              <span className="font-mono text-[12px] tabular">{formatClock(elapsed)}</span>
            </Row>
          ) : null}
          {station.kind === "build" || station.kind === "review" ? (
            <Row label="Round">
              {Math.max(station.round, 1)} <span className="text-zinc-500">of up to {workOrder.maxReviewRounds}</span>
            </Row>
          ) : null}
          {station.tests ? (
            <Row label="Tests">
              <span>
                <span className="text-emerald-300">{station.tests.passed} passed</span>
                <span className="text-zinc-500"> · </span>
                <span className={station.tests.failed > 0 ? "text-rose-300" : "text-zinc-400"}>{station.tests.failed} failed</span>
                {station.tests.skipped > 0 ? <span className="text-zinc-500"> · {station.tests.skipped} skipped</span> : null}
                {station.tests.durationMs !== undefined ? (
                  <span className="text-zinc-500"> · {formatDuration(station.tests.durationMs)}</span>
                ) : null}
              </span>
            </Row>
          ) : null}
          {usage ? (
            <Row label="Tokens">
              <span>
                {formatCount(usage.inputTokens)} in <span className="text-zinc-500">·</span> {formatCount(usage.outputTokens)} out
                {usage.cacheReadTokens > 0 ? (
                  <span className="text-zinc-500"> · {formatCount(usage.cacheReadTokens)} cached</span>
                ) : null}
                <span className="text-zinc-500"> · </span>
                {usage.requests} {usage.requests === 1 ? "request" : "requests"}
              </span>
            </Row>
          ) : null}
          {station.previousSessionIds && station.previousSessionIds.length > 0 ? (
            <Row label="Earlier">
              <ul className="space-y-1">
                {station.previousSessionIds.map((id) => (
                  <li key={id} className="flex min-w-0 items-center gap-1">
                    <Mono title={id}>{shortId(id, 14)}</Mono>
                    <CopyButton text={id} label="Copy earlier session id" />
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

const SEVERITY: Readonly<Record<ReviewFinding["severity"], { readonly label: string; readonly className: string }>> = {
  blocker: { label: "Blocker", className: "bg-rose-400/10 text-rose-300 ring-rose-400/30" },
  major: { label: "Major", className: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
  minor: { label: "Minor", className: "bg-zinc-400/10 text-zinc-300 ring-zinc-400/20" },
};

export function VerdictBadge({ verdict }: { readonly verdict: ReviewRecord["verdict"] }) {
  return verdict === "approve" ? <Chip tone="success">Approved</Chip> : <Chip tone="warning">Changes requested</Chip>;
}

function ReviewHistory({ station }: { readonly station: Station }) {
  const reviews = [...(station.reviews ?? [])].sort((a, b) => a.round - b.round);
  return (
    <section aria-label="Review history">
      <SectionLabel>Review history</SectionLabel>
      {reviews.length === 0 ? (
        <p className="mt-2 text-[13px] text-zinc-500">No reviews yet. The reviewer starts when the build is ready.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {reviews.map((review) => (
            <li key={review.round} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-zinc-200">Round {review.round}</span>
                <VerdictBadge verdict={review.verdict} />
                <span className="ml-auto text-[11px] text-zinc-500" title={formatFullDateTime(review.at)}>
                  {formatDateTime(review.at)}
                </span>
              </div>
              {review.summary ? <MarkdownView source={review.summary} className="mt-2 text-[13px]" /> : null}
              {review.findings.length > 0 ? (
                <ul className="mt-3 space-y-2 border-t border-zinc-800/80 pt-3">
                  {review.findings.map((finding, index) => {
                    const severity = SEVERITY[finding.severity] ?? SEVERITY.minor;
                    const location = finding.file ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}` : undefined;
                    return (
                      <li key={index} className="flex items-start gap-2">
                        <span
                          className={cx(
                            "mt-px inline-flex w-[3.75rem] shrink-0 justify-center rounded-md px-1.5 py-px text-[10.5px] leading-4 font-semibold ring-1 ring-inset",
                            severity.className,
                          )}
                        >
                          {severity.label}
                        </span>
                        <div className="min-w-0 flex-1">
                          {location ? <code className="block truncate font-mono text-[11.5px] text-zinc-400">{location}</code> : null}
                          <p className="text-[13px] leading-relaxed text-zinc-300">{finding.message}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-zinc-500">No findings.</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function IntakePanel({ workOrder }: { readonly workOrder: WorkOrder }) {
  const template = useStore((state) =>
    workOrder.source.templateId ? state.templates.find((candidate) => candidate.id === workOrder.source.templateId) : undefined,
  );
  return (
    <section aria-label="Work order brief" className={PANEL_CLASS}>
      <header className="border-b border-zinc-800/80 bg-zinc-900/70 p-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
            <Inbox className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-50">Intake</h2>
            <p className="mt-0.5 text-[13px] text-zinc-400">The brief the factory is working from.</p>
          </div>
        </div>
      </header>
      <div className={SCROLL_CLASS}>
        <div className="space-y-5 p-4">
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
            <Row label="Source">
              {workOrder.source.kind === "template" ? `Template · ${template?.title ?? workOrder.source.templateId ?? "unknown"}` : "Custom brief"}
            </Row>
            <Row label="Review rounds">Up to {workOrder.maxReviewRounds}</Row>
            <Row label="Created">
              <span title={formatFullDateTime(workOrder.createdAt)}>{formatDateTime(workOrder.createdAt)}</span>
            </Row>
            {workOrder.owner ? <Row label="Requested by">@{workOrder.owner.login}</Row> : null}
          </dl>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
            <MarkdownView source={workOrder.brief} />
          </div>
        </div>
      </div>
    </section>
  );
}
