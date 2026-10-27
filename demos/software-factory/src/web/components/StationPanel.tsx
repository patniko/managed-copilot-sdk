import {
  ArrowDownIcon,
  CheckCircleFillIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  FileDiffIcon,
  InboxIcon,
  TerminalIcon,
  XIcon,
} from "@primer/octicons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { isStationActive, stationElapsed, stationStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import type { Tone } from "../lib/tone.js";
import { ActivityStream } from "./ActivityStream.js";
import { CoordinatorDecisions } from "./CoordinatorDecisions.js";
import { NetworkChip, useEnvironment } from "./StationCard.js";
import { Button, IconButton } from "./ui/Button.js";
import { Chip, StatusIcon } from "./ui/Chip.js";
import { CopyButton } from "./ui/CopyButton.js";
import { Callout } from "./ui/Feedback.js";
import { MarkdownView } from "./viewers/MarkdownView.js";
/** Keeps a scroll container pinned to the bottom while new content arrives, unless the user scrolls up. */
function useStickToBottom(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  startAtBottom: boolean,
): { readonly showJump: boolean; readonly hasNew: boolean; readonly jump: () => void; readonly pin: () => void } {
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

  /** Follows new output again, for example when a finished station is retried. */
  const pin = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    pinned.current = true;
    setHasNew(false);
    setAway(false);
    scroller.scrollTop = scroller.scrollHeight;
  }, [scrollRef]);

  return { showJump: away || (hasNew && !pinned.current), hasNew, jump, pin };
}

const PANEL_CLASS = "Box relative flex min-w-0 flex-col overflow-clip xl:h-full";
const SCROLL_CLASS = "min-h-0 flex-1 overflow-y-auto overscroll-contain max-xl:max-h-[80vh]";

/** The selected station, like a GitHub Actions job: header, details, review rounds, and the live activity log. */
export function StationPanel({ workOrder, station }: { readonly workOrder: WorkOrder; readonly station: Station }) {
  // Follow live output for stations that are running (or about to); start the others at the top (details, reviews).
  const live = isStationActive(station.status) || station.status === "waiting";
  const [startAtBottom] = useState(live);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { showJump, hasNew, jump, pin } = useStickToBottom(scroller, content, startAtBottom);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) pin();
    wasLive.current = live;
  }, [live, pin]);

  return (
    <section aria-label={`${station.title} station`} className={PANEL_CLASS}>
      <PanelHeader station={station} title={station.kind === "coordinate" ? "Coordinator decisions" : undefined} />
      <div ref={scroller} className={SCROLL_CLASS}>
        <div ref={content} className="space-y-6 p-4">
          {station.kind === "coordinate" ? <CoordinatorDecisions workOrder={workOrder} /> : null}
          <Details workOrder={workOrder} station={station} />
          {station.kind === "review" ? <ReviewHistory station={station} /> : null}
          {station.acceptedWithFindings ? (
            <Callout tone="warning" compact title="Accepted with open findings">
              The reviewer still had findings after the last allowed round, so the factory accepted the work and moved on.
            </Callout>
          ) : null}
          {station.error ? (
            <Callout tone="danger" compact role="alert" title="This station failed">
              <span>{station.error.message}</span> <code className="inline-code">{station.error.code}</code>
            </Callout>
          ) : null}
          {station.kind !== "coordinate" ? <section aria-label="Activity">
            <h3 className="text-sm font-semibold">{station.worker ? "Worker reports" : "Activity"}</h3>
            {station.worker ? <p className="mt-1 text-xs text-fg-muted">The factory observes this worker through the platform, without attaching a client that would take over its approvals.</p> : null}
            <div className="mt-2">
              <ActivityStream workOrder={workOrder} station={station} />
            </div>
          </section> : null}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={jump}
          className="btn btn-sm absolute bottom-4 left-1/2 z-10 -translate-x-1/2 animate-slide-up shadow-lg"
        >
          {hasNew && isStationActive(station.status) ? <span className="size-2 rounded-full bg-accent-emphasis" aria-hidden /> : null}
          <ArrowDownIcon size={16} />
          Jump to latest
        </button>
      ) : null}
    </section>
  );
}

type AttachState =
  | { readonly sessionId: string; readonly status: "pending" }
  | { readonly sessionId: string; readonly status: "done"; readonly result: AttachResponse; readonly failed: boolean };

function PanelHeader({ station, title }: { readonly station: Station; readonly title?: string }) {
  const meta = stationStatusMeta(station);
  const active = isStationActive(station.status);
  const now = useNow(1000, active);
  const elapsed = stationElapsed(station, now);
  const attachAllowed = useStore((state) => state.platform?.features.attach ?? false);
  const attachTemplate = useStore((state) => state.attachCommand);
  const [attachState, setAttach] = useState<AttachState>();
  const sessionId = station.sessionId;
  const sessionDeleted = station.sessionState === "deleted";
  // A retried or replaced station has a new session: an earlier attach result no longer applies.
  const attach = attachState?.sessionId === sessionId ? attachState : undefined;

  const onAttach = async (): Promise<void> => {
    if (!sessionId) return;
    setAttach({ sessionId, status: "pending" });
    try {
      const result = await api.attach(sessionId);
      setAttach({ sessionId, status: "done", result, failed: false });
    } catch (error) {
      const command = attachTemplate ? attachTemplate.replace("{sessionId}", sessionId) : "";
      setAttach({
        sessionId,
        status: "done",
        failed: true,
        result: { command, launched: false, message: `${errorMessage(error)} You can still attach from your own terminal.` },
      });
    }
  };

  return (
    <header className="border-b border-line bg-canvas-muted px-4 py-3">
      <div className="flex items-start gap-2">
        <StatusIcon meta={meta} className="mt-1" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold" title={station.title}>
            {title ?? station.title}
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            <span>{meta.label}</span>
            {station.round > 1 ? <Chip tone="warning">Round {station.round}</Chip> : null}
            {elapsed !== undefined ? (
              <span className="font-mono tabular-nums" title={active ? "Elapsed" : "Duration"}>
                {active ? formatClock(elapsed) : formatDuration(elapsed)}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      {station.detail && station.detail !== meta.label ? <p className="mt-2 text-fg-muted">{station.detail}</p> : null}
      {station.kind === "coordinate" ? <p className="mt-1 text-xs text-fg-muted">{station.environment} · {station.model}</p> : null}
      {sessionId && attachAllowed ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            icon={TerminalIcon}
            loading={attach?.status === "pending"}
            disabled={sessionDeleted}
            aria-describedby={sessionDeleted ? "attach-unavailable" : undefined}
            onClick={() => void onAttach()}
          >
            Open in Copilot CLI
          </Button>
          {sessionDeleted ? (
            <span id="attach-unavailable" className="text-xs text-fg-muted">
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
    <div role="status" className={cx("flash flash-sm mt-3 animate-fade-in", launched ? "flash-success" : "flash-warn")}>
      {launched ? <CheckCircleIcon size={16} /> : <TerminalIcon size={16} />}
      <div className="flash-content">
        <p>{result.message || (launched ? "Opened Copilot CLI in a new terminal window." : "Run this command in a terminal to attach:")}</p>
        {result.command ? (
          <div className="mt-2 flex items-center gap-1 rounded-md border border-line bg-canvas py-1 pr-1 pl-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={result.command}>
              {result.command}
            </code>
            {launched ? (
              <CopyButton text={result.command} label="Copy attach command" />
            ) : (
              <CopyButton text={result.command} label="Copy attach command" variant="primary" size="sm">
                Copy
              </CopyButton>
            )}
          </div>
        ) : null}
      </div>
      <div className="-my-1 -mr-1">
        <IconButton icon={XIcon} label="Dismiss" size="sm" onClick={onDismiss} />
      </div>
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
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

function sessionStateTone(state: string): Tone | "plain" {
  if (state === "deleted" || state === "failed" || state === "error") return "danger";
  if (state === "running" || state === "busy" || state === "active") return "accent";
  return "plain";
}

function Mono({ children, title }: { readonly children: ReactNode; readonly title?: string }) {
  return (
    <code className="truncate font-mono text-xs" title={title}>
      {children}
    </code>
  );
}

function Details({ workOrder, station }: { readonly workOrder: WorkOrder; readonly station: Station }) {
  const [open, setOpen] = useState(station.kind !== "coordinate");
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
        className="-mx-1 flex items-center gap-1 rounded-md px-1 text-left text-sm font-semibold hover:bg-control-transparent-hover"
      >
        <ChevronDownIcon size={16} className={cx("text-fg-muted transition-transform duration-100", !open && "-rotate-90")} />
        Details
      </button>
      {open ? (
        <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">
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
              <span className="text-fg-muted">Not started</span>
            )}
          </Row>
          {station.turn ? (
            <Row label="Turn">
              <span>
                {TURN_LABELS[station.turn.kind] ?? station.turn.kind}
                <span className="text-fg-muted">
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
              {environment ? <Chip>{environment.type === "orchestrator" ? "Orchestrator" : environment.type === "shared" ? "Shared" : "Isolated"}</Chip> : null}
            </span>
          </Row>
          <Row label="Placement">{station.placement === "sandbox" ? "Fresh isolated sandbox" : "Shared environment (no sandbox)"}</Row>
          {station.worker ? <Row label="Worker"><span className="font-mono text-xs">{station.worker.name}</span> <Chip tone="success">created by coordinator</Chip>{station.round > station.worker.createdRound ? <Chip tone="accent">reused for round {station.round}</Chip> : null}</Row> : null}
          <Row label="Agent">
            <span>
              @{station.agent} <span className="text-fg-muted">· {station.role}</span>
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
                <Chip tone={sandbox.state === "running" || sandbox.state === "ready" ? "accent" : "plain"}>{sandbox.state}</Chip>
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
                {formatDateTime(station.startedAt)} <span className="text-fg-muted">· {formatRelative(station.startedAt, now)}</span>
              </span>
            </Row>
          ) : null}
          {station.finishedAt ? (
            <Row label="Finished">
              <span title={formatFullDateTime(station.finishedAt)}>
                {formatDateTime(station.finishedAt)}
                {elapsed !== undefined ? <span className="text-fg-muted"> · took {formatDuration(elapsed)}</span> : null}
              </span>
            </Row>
          ) : active && elapsed !== undefined ? (
            <Row label="Elapsed">
              <span className="font-mono text-xs tabular-nums">{formatClock(elapsed)}</span>
            </Row>
          ) : null}
          {station.kind === "build" || station.kind === "review" ? (
            <Row label="Round">
              {Math.max(station.round, 1)} <span className="text-fg-muted">of up to {workOrder.maxReviewRounds}</span>
            </Row>
          ) : null}
          {station.tests ? (
            <Row label="Tests">
              <span>
                <span className="text-fg-success">{station.tests.passed} passed</span>
                <span className="text-fg-muted"> · </span>
                <span className={station.tests.failed > 0 ? "text-fg-danger" : "text-fg-muted"}>{station.tests.failed} failed</span>
                {station.tests.skipped > 0 ? <span className="text-fg-muted"> · {station.tests.skipped} skipped</span> : null}
                {station.tests.durationMs !== undefined ? (
                  <span className="text-fg-muted"> · {formatDuration(station.tests.durationMs)}</span>
                ) : null}
              </span>
            </Row>
          ) : null}
          {usage ? (
            <Row label="Tokens">
              <span>
                {formatCount(usage.inputTokens)} in <span className="text-fg-muted">·</span> {formatCount(usage.outputTokens)} out
                {usage.cacheReadTokens > 0 ? <span className="text-fg-muted"> · {formatCount(usage.cacheReadTokens)} cached</span> : null}
                <span className="text-fg-muted"> · </span>
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

const SEVERITY: Readonly<Record<ReviewFinding["severity"], { readonly label: string; readonly tone: Tone }>> = {
  blocker: { label: "Blocker", tone: "danger" },
  major: { label: "Major", tone: "warning" },
  minor: { label: "Minor", tone: "neutral" },
};

export function VerdictBadge({ verdict }: { readonly verdict: ReviewRecord["verdict"] }) {
  return verdict === "approve" ? <Chip tone="success">Approved</Chip> : <Chip tone="warning">Changes requested</Chip>;
}

/** Review rounds as pull request reviews: verdict, summary, and findings with file and line. */
function ReviewHistory({ station }: { readonly station: Station }) {
  const reviews = [...(station.reviews ?? [])].sort((a, b) => a.round - b.round);
  return (
    <section aria-label="Review history">
      <h3 className="text-sm font-semibold">Review history</h3>
      {reviews.length === 0 ? (
        <p className="mt-1 text-fg-muted">No reviews yet. The reviewer starts when the build is ready.</p>
      ) : (
        <ol className="mt-2 space-y-3">
          {reviews.map((review) => {
            const approved = review.verdict === "approve";
            return (
              <li key={review.round} className="timeline-comment">
                <div className="timeline-comment-header flex-wrap">
                  {approved ? (
                    <CheckCircleFillIcon size={16} className="text-fg-success" />
                  ) : (
                    <FileDiffIcon size={16} className="text-fg-attention" />
                  )}
                  <span className="font-semibold text-fg">Round {review.round}</span>
                  <VerdictBadge verdict={review.verdict} />
                  <span className="ml-auto text-xs" title={formatFullDateTime(review.at)}>
                    {formatDateTime(review.at)}
                  </span>
                </div>
                <div className="px-4 py-3">
                  {review.summary ? <MarkdownView source={review.summary} /> : null}
                  {review.findings.length > 0 ? (
                    <ul className={cx("space-y-2", review.summary && "mt-3 border-t border-line-muted pt-3")}>
                      {review.findings.map((finding, index) => {
                        const severity = SEVERITY[finding.severity] ?? SEVERITY.minor;
                        const location = finding.file ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}` : undefined;
                        return (
                          <li key={index} className="flex items-start gap-2">
                            <Chip tone={severity.tone} className="mt-0.5 w-16 shrink-0 justify-center">
                              {severity.label}
                            </Chip>
                            <div className="min-w-0 flex-1">
                              {location ? <code className="block truncate font-mono text-xs text-fg-muted">{location}</code> : null}
                              <p>{finding.message}</p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className={cx("text-xs text-fg-muted", review.summary && "mt-2")}>No findings.</p>
                  )}
                </div>
              </li>
            );
          })}
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
      <header className="border-b border-line bg-canvas-muted px-4 py-3">
        <div className="flex items-start gap-2">
          <InboxIcon size={16} className="mt-1 text-fg-muted" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Intake</h2>
            <p className="text-xs text-fg-muted">The brief the factory is working from.</p>
          </div>
        </div>
      </header>
      <div className={SCROLL_CLASS}>
        <div className="space-y-4 p-4">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
            <Row label="Source">
              {workOrder.source.kind === "template" ? `Template · ${template?.title ?? workOrder.source.templateId ?? "unknown"}` : "Custom brief"}
            </Row>
            <Row label="Review rounds">Up to {workOrder.maxReviewRounds}</Row>
            <Row label="Created">
              <span title={formatFullDateTime(workOrder.createdAt)}>{formatDateTime(workOrder.createdAt)}</span>
            </Row>
            {workOrder.owner ? <Row label="Requested by">@{workOrder.owner.login}</Row> : null}
          </dl>
          <div className="timeline-comment">
            <div className="timeline-comment-header">
              <span className="font-semibold text-fg">Brief</span>
            </div>
            <div className="comment-body">
              <MarkdownView source={workOrder.brief} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}