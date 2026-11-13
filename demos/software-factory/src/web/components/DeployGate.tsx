import {
  CheckCircleFillIcon,
  ClockIcon,
  FileDiffIcon,
  InfoIcon,
  LinkExternalIcon,
  RocketIcon,
  ShieldIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import { useState, type ReactNode } from "react";
import type { WorkOrder, WorkOrderGate } from "../../shared/types.js";
import { errorMessage } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { elapsedBetween, formatDuration, formatTimeOfDay, pluralize } from "../lib/format.js";
import { originHref } from "../lib/origin.js";
import { isWorkOrderActive } from "../lib/stations.js";
import { decideGate } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { toast } from "../lib/toast.js";
import { Button } from "./ui/Button.js";
import { Callout } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";

/** `downhill-shop v2.3.1`. */
function release(target: string, version?: string): string {
  return `${target}${version ? ` v${version}` : ""}`;
}

const who = (login: string | undefined): string => (login ? `@${login}` : "someone");

/** The routing app's name for people. */
function originName(workOrder: WorkOrder): string {
  return workOrder.origin?.name ?? "The routing app";
}

/** A gate's state as a Primer Label, for the floor and the header. */
export function GateLabel({ gate, className }: { readonly gate: Pick<WorkOrderGate, "state" | "label">; readonly className?: string }) {
  const meta: Record<WorkOrderGate["state"], { readonly text: string; readonly tone: string }> = {
    pending: { text: "Waiting", tone: "Label--secondary" },
    open: { text: "Needs you", tone: "Label--attention" },
    approved: { text: "Deploying", tone: "Label--accent" },
    declined: { text: "Declined", tone: "Label--danger" },
    deployed: { text: "Deployed", tone: "Label--success" },
    failed: { text: "Deploy failed", tone: "Label--danger" },
    closed: { text: "Answered elsewhere", tone: "Label--secondary" },
  };
  const { text, tone } = meta[gate.state];
  return (
    <span className={cx("Label shrink-0", tone, className)} title={gate.label}>
      {text}
    </span>
  );
}

/** One fact about the request: an icon and a value. */
function Fact({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return <span className="inline-flex min-w-0 items-center gap-1.5">{icon}{children}</span>;
}

/** The routing app's request, waiting for a person: Deploy, or Decline with a reason. */
function OpenGate({ workOrder, gate }: { readonly workOrder: WorkOrder; readonly gate: WorkOrderGate }) {
  const request = gate.request!;
  const now = useNow(1000);
  const [busy, setBusy] = useState<"approve" | "decline">();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const origin = originName(workOrder);
  const back = request.url ?? (workOrder.origin ? originHref(workOrder.origin) : undefined);
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(approve ? "approve" : "decline");
    setError(undefined);
    try {
      await decideGate(workOrder.id, gate.id, { approve, requestId: request.requestId, ...(!approve && reason.trim() ? { reason: reason.trim() } : {}) });
      toast.success(approve ? `Approved: ${origin} deploys ${release(request.target, request.version)}` : "Declined the deploy", approve ? undefined : `${origin} hears why.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };
  const waited = elapsedBetween(request.requestedAt, undefined, now);
  return (
    <section id={`gate-${gate.id}`} aria-label={`${gate.label}: needs you`} className="Box w-full min-w-0 scroll-mt-4 overflow-hidden border-line-attention">
      <div className="flex items-center gap-2 border-b border-line-attention-muted bg-attention-muted px-3 py-2">
        <ShieldIcon size={16} className="shrink-0 text-fg-attention" />
        <h3 className="min-w-0 flex-1 truncate font-semibold">{request.title}</h3>
        <GateLabel gate={gate} />
        {waited !== undefined ? <span className="shrink-0 font-mono text-xs text-fg-muted tabular-nums">{formatDuration(waited)}</span> : null}
      </div>
      <div className="flex flex-col gap-3 p-3">
        <p>{request.summary}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <Fact icon={<RocketIcon size={16} />}>
            <span className="font-mono text-fg">{release(request.target, request.version)}</span>
            {request.previousVersion ? <span>(v{request.previousVersion} runs now)</span> : null}
          </Fact>
          {request.tests ? <Fact icon={<CheckCircleFillIcon size={16} className="text-fg-success" />}>{request.tests}</Fact> : null}
          {request.files?.length ? (
            <Fact icon={<FileDiffIcon size={16} />}>
              <span title={request.files.join("\n")}>{pluralize(request.files.length, "file")}</span>
            </Fact>
          ) : null}
          {back ? (
            <a href={back} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
              Open in {origin}
              <LinkExternalIcon size={12} />
            </a>
          ) : null}
        </div>
        {error ? (
          <Callout tone="danger" compact role="alert">
            {error}
          </Callout>
        ) : null}
        {declining ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void decide(false);
            }}
          >
            <input
              className="form-control min-w-0 flex-1"
              placeholder={`Why not? ${origin} passes it on (optional)`}
              aria-label="Why you're declining (optional)"
              value={reason}
              maxLength={500}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={busy === "decline"} disabled={busy !== undefined}>
                Decline
              </Button>
              <Button onClick={() => setDeclining(false)} disabled={busy !== undefined}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={RocketIcon} loading={busy === "approve"} disabled={busy !== undefined} onClick={() => void decide(true)}>
              Deploy
            </Button>
            <Button disabled={busy !== undefined} onClick={() => setDeclining(true)}>
              Decline
            </Button>
          </div>
        )}
        <p className="inline-flex items-start gap-1.5 text-xs text-fg-muted">
          <InfoIcon size={12} className="mt-0.5 shrink-0" />
          {origin} deploys it once you approve: the factory never holds its deploy credentials.
        </p>
      </div>
    </section>
  );
}

/** Every other state, in one line (and the routing app's message, when it sent one). */
function GateLine({ workOrder, gate }: { readonly workOrder: WorkOrder; readonly gate: WorkOrderGate }) {
  const origin = originName(workOrder);
  const request = gate.request;
  const decision = gate.decision;
  const at = decision?.at ? ` at ${formatTimeOfDay(decision.at)}` : "";
  const shipped = release(request?.target ?? gate.target, gate.outcome?.version ?? request?.version);
  let icon: ReactNode;
  let text: string;
  let detail: string | undefined;
  switch (gate.state) {
    case "approved":
      icon = <Spinner size={16} className="text-fg-accent" />;
      text = `Approved by ${who(decision?.by)}${at}. ${origin} is deploying ${shipped}…`;
      break;
    case "deployed":
      icon = <CheckCircleFillIcon size={16} className="text-fg-success" />;
      text = `Deployed ${shipped}${decision?.approve ? `, approved by ${who(decision.by)}` : ""}.`;
      detail = gate.outcome?.message;
      break;
    case "failed":
      icon = <XCircleFillIcon size={16} className="text-fg-danger" />;
      text = `${origin} couldn't deploy ${shipped}${decision?.approve ? ` (approved by ${who(decision.by)})` : ""}.`;
      detail = gate.outcome?.message ?? `${origin} didn't say why.`;
      break;
    case "declined":
      icon = <XCircleFillIcon size={16} className="text-fg-danger" />;
      text = `Declined by ${who(decision?.by)}${at}${decision?.reason ? `: ${decision.reason}` : "."}`;
      break;
    case "closed":
      icon = <InfoIcon size={16} className="text-fg-muted" />;
      text = `${origin} closed the deploy request.`;
      detail = gate.outcome?.message;
      break;
    default: {
      const active = isWorkOrderActive(workOrder.status);
      icon = <ClockIcon size={16} className="text-fg-muted" />;
      text = active
        ? `After the release: waits for ${origin}'s deploy request.`
        : workOrder.status === "completed"
          ? `Waiting for ${origin}'s deploy request. ${origin} verifies the release first.`
          : "Not reached: the work order didn't release.";
    }
  }
  return (
    <div
      id={`gate-${gate.id}`}
      className={cx("flex w-full min-w-0 scroll-mt-4 flex-col rounded-md border bg-canvas px-3 py-2", gate.state === "pending" ? "border-dashed border-line" : "border-line")}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <RocketIcon size={16} className={cx("shrink-0", gate.state === "deployed" ? "text-fg-success" : "text-fg-muted")} />
        <span className="min-w-0 truncate font-semibold">{gate.label}</span>
        <span className="ml-auto pl-1">
          <GateLabel gate={gate} />
        </span>
      </span>
      <span className="mt-1.5 flex w-full min-w-0 items-start gap-1.5 text-xs">
        <span className="mt-px shrink-0">{icon}</span>
        <span className="min-w-0">{text}</span>
      </span>
      {detail ? <span className="mt-1 pl-[22px] text-xs text-fg-muted">{detail}</span> : null}
    </div>
  );
}

/** A gate after the release: what it waits for, or the request with Deploy and Decline. */
export function GateNode({ workOrder, gate }: { readonly workOrder: WorkOrder; readonly gate: WorkOrderGate }) {
  return gate.state === "open" && gate.request ? <OpenGate workOrder={workOrder} gate={gate} /> : <GateLine workOrder={workOrder} gate={gate} />;
}

/** The header's pointer to an open gate, from any tab: on the floor it scrolls to the gate, elsewhere it links there. */
export function OpenGateCallout({ workOrder, href }: { readonly workOrder: WorkOrder; readonly href?: string }) {
  const gate = workOrder.gates?.find((candidate) => candidate.state === "open" && candidate.request);
  if (!gate?.request) return null;
  return (
    <Callout tone="warning" icon={ShieldIcon} compact className="mt-3" role="status">
      <span>
        {originName(workOrder)} asks to deploy <span className="font-mono">{release(gate.request.target, gate.request.version)}</span>.{" "}
        {href ? (
          <a href={href} className="font-semibold">
            Review it on the floor
          </a>
        ) : (
          <button
            type="button"
            className="btn-link font-semibold"
            onClick={() => document.getElementById(`gate-${gate.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
          >
            Review it below
          </button>
        )}
      </span>
    </Callout>
  );
}

