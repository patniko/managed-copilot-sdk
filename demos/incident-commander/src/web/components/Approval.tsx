import { CheckCircleFillIcon, FileDiffIcon, InfoIcon, LinkExternalIcon, RocketIcon, ServerIcon, ShieldIcon, WorkflowIcon, XCircleFillIcon } from "@primer/octicons-react";
import { useState } from "react";
import type { ApprovalView, FileChange, IncidentView } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { between, clock, cx, duration, nextVersion, workOrderLabel } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { useStore } from "../lib/store.js";
import { Spinner, Tooltip } from "./ui.js";

function FileDiff({ file }: { readonly file: FileChange }) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="file-header flex items-center gap-2 border-b border-line bg-canvas-muted px-3 py-1.5 text-xs">
        <FileDiffIcon size={14} className="text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        {file.status === "added" ? <span className="Label Label--success">New</span> : null}
        <span className="shrink-0 font-mono text-fg-success">+{file.added}</span>
        <span className="shrink-0 font-mono text-fg-danger">−{file.removed}</span>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {file.lines.map((line, index) =>
              line.kind === "gap" ? (
                <tr key={index}>
                  <td colSpan={3} className="blob-code-hunk px-3 text-fg-muted">
                    {line.text}
                  </td>
                </tr>
              ) : (
                <tr key={index}>
                  <td className={cx("blob-num w-10 px-2 text-right select-none", line.kind === "add" && "blob-num-addition", line.kind === "del" && "blob-num-deletion")}>{line.oldLine ?? ""}</td>
                  <td className={cx("blob-num w-10 px-2 text-right select-none", line.kind === "add" && "blob-num-addition", line.kind === "del" && "blob-num-deletion")}>{line.newLine ?? ""}</td>
                  <td className={cx("blob-code px-2 whitespace-pre", line.kind === "add" && "blob-code-addition", line.kind === "del" && "blob-code-deletion")}>
                    <span className="select-none">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                    {line.text}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Where an approved fix goes: the demo service's simulated production, or your deploy pipeline (as the next version). */
function Destination({ incident }: { readonly incident: IncidentView }) {
  const next = nextVersion(incident.serviceVersion);
  const release = (
    <span className="font-mono">
      {incident.service}
      {next ? ` v${next}` : ""}
    </span>
  );
  return incident.demo ? (
    <span className="inline-flex items-center gap-1.5">
      <ServerIcon size={16} />
      Releases {release} to the demo's simulated production
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5">
      <RocketIcon size={16} />
      Goes to your deploy pipeline as {release}
    </span>
  );
}

/** Where the request is decided when Software Factory built the fix: on its work order, or here and why. */
function GateNote({ approval }: { readonly approval: ApprovalView }) {
  const gate = approval.gate;
  if (!gate) return null;
  const label = gate.number !== undefined ? workOrderLabel(gate.number) : undefined;
  const link =
    gate.url && label ? (
      <a href={gate.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold">
        Open {label} in Software Factory
        <LinkExternalIcon size={12} />
      </a>
    ) : null;
  if (gate.problem) return <div className="flash flash-warn flash-sm">{gate.problem}</div>;
  if (gate.state === "unavailable") return gate.reason ? <div className="flash flash-warn flash-sm">{gate.reason}</div> : null;
  if (gate.state !== "opening" && gate.state !== "open") return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-attention-muted bg-attention-muted px-3 py-2 sm:flex-row sm:items-center">
      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
        {gate.state === "opening" ? <Spinner size={16} className="shrink-0 text-fg-attention" /> : <WorkflowIcon size={16} className="shrink-0 text-display-indigo" />}
        <span>
          {gate.state === "opening"
            ? `Putting the request on ${label ?? "the work order"} in Software Factory…`
            : `Deploy or Decline on ${label ?? "the work order"}'s deploy gate. Incident Commander deploys as soon as it's approved there.`}
        </span>
      </span>
      {link}
    </div>
  );
}

/** What waits for a person: deploy the verified fix, or decline it with a reason. */
function Waiting({ incident, approval }: { readonly incident: IncidentView; readonly approval: ApprovalView }) {
  const now = useNow();
  const pipeline = useStore((state) => state.integrations?.deployConfigured);
  const [busy, setBusy] = useState<"approve" | "decline">();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const added = approval.files.reduce((sum, file) => sum + file.added, 0);
  const removed = approval.files.reduce((sum, file) => sum + file.removed, 0);
  // Decided on the work order's deploy gate, unless Software Factory can't take it (or can't be reached right now).
  const inFactory = (approval.gate?.state === "opening" || approval.gate?.state === "open") && !approval.gate.problem;
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "decline");
    setError(undefined);
    try {
      await api.decide(incident.id, { approve, ...(!approve && reason.trim() ? { reason: reason.trim() } : {}) });
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(undefined);
    }
  };
  return (
    <section id="approval" aria-label="Deploy approval" className="Box needs-you scroll-mt-4 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line-attention-muted bg-attention-muted px-4 py-3">
        <ShieldIcon size={20} className="shrink-0 text-fg-attention" />
        <h2 className="min-w-0 flex-1 text-base font-semibold">{inFactory ? "Waiting for approval in Software Factory" : "Deploy the fix to production?"}</h2>
        <span className="shrink-0 font-mono text-xs text-fg-muted tabular-nums">Waiting {duration(between(approval.requestedAt, now))}</span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-base">{approval.summary}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          <Destination incident={incident} />
          {approval.tests ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircleFillIcon size={16} className="text-fg-success" />
              {approval.tests}
            </span>
          ) : null}
          {approval.files.length ? (
            <span className="inline-flex items-center gap-1.5">
              <FileDiffIcon size={16} />
              {approval.files.length} {approval.files.length === 1 ? "file" : "files"}
              <span className="font-mono text-fg-success">+{added}</span>
              <span className="font-mono text-fg-danger">−{removed}</span>
            </span>
          ) : null}
          {approval.factory ? (
            <span className="inline-flex items-center gap-1.5">
              <WorkflowIcon size={16} className="text-display-indigo" />
              Built by Software Factory
              <a href={approval.factory.url} target="_blank" rel="noreferrer" className="font-mono">
                {workOrderLabel(approval.factory.number)}
              </a>
            </span>
          ) : null}
        </div>
        {approval.problem ? <div className="flash flash-warn flash-sm">{approval.problem}</div> : null}
        <GateNote approval={approval} />
        {!incident.demo && pipeline === false ? (
          <div className="flash flash-warn flash-sm">No deploy pipeline is configured, so this deploy can't go out. Set INCIDENT_DEPLOY_URL to send approved fixes to yours.</div>
        ) : null}
        {approval.files.length ? (
          <details>
            <summary className="text-sm font-semibold text-fg-accent">Review the change</summary>
            <div className="mt-2 flex flex-col gap-3">
              {approval.files.map((file) => (
                <FileDiff key={file.path} file={file} />
              ))}
            </div>
          </details>
        ) : null}
        {error ? <div className="flash flash-error flash-sm">{error}</div> : null}
        {inFactory ? null : declining ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void decide(false);
            }}
          >
            <input
              className="form-control min-w-0 flex-1"
              placeholder="Why not? Copilot reads this (optional)"
              aria-label="Why you're declining (optional)"
              value={reason}
              maxLength={500}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex gap-2">
              <button type="submit" className="btn btn-danger" disabled={busy !== undefined}>
                {busy === "decline" ? <Spinner size={16} /> : null}
                Decline
              </button>
              <button type="button" className="btn" onClick={() => setDeclining(false)} disabled={busy !== undefined}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={busy !== undefined} onClick={() => void decide(true)}>
              {busy === "approve" ? <Spinner size={16} /> : <RocketIcon size={16} />}
              Deploy
            </button>
            <button type="button" className="btn" disabled={busy !== undefined} onClick={() => setDeclining(true)}>
              Decline
            </button>
          </div>
        )}
        <Tooltip
          content={`The app let go of Copilot's session. The platform holds this request for up to 24 hours${approval.announcedAt ? ` and told the app through its webhook at ${clock(approval.announcedAt)}` : ""}. ${inFactory ? "A decision in Software Factory delivers it: Incident Commander follows the work order and deploys." : "Approving here delivers it."}`}
        >
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <InfoIcon size={12} />
            Waits on the platform, not in this tab. Safe to close it.
          </span>
        </Tooltip>
      </div>
    </section>
  );
}

/** The request after a decision: compact, one line, with where it was decided. */
function Decided({ approval }: { readonly approval: ApprovalView }) {
  const who = approval.decidedBy ? `@${approval.decidedBy}` : "You";
  const waited = approval.decidedAt ? ` after ${duration(between(approval.requestedAt, approval.decidedAt))}` : "";
  const inFactory = approval.decidedIn === "software-factory";
  const where = inFactory ? " in Software Factory" : "";
  const line =
    approval.state === "approved"
      ? { icon: <Spinner size={16} className="text-fg-accent" />, text: `${who} approved the deploy${where}${waited}. Deploying…` }
      : approval.state === "deployed"
        ? { icon: <CheckCircleFillIcon size={16} className="text-fg-success" />, text: `${who} approved the deploy${where}${waited}. Deployed.` }
        : approval.state === "declined"
          ? { icon: <XCircleFillIcon size={16} className="text-fg-danger" />, text: `${who} declined the deploy${where}${waited}${approval.reason ? `: ${approval.reason}` : "."}` }
          : approval.state === "failed"
            ? { icon: <XCircleFillIcon size={16} className="text-fg-danger" />, text: "The deploy failed. The timeline has the details." }
            : { icon: <InfoIcon size={16} className="text-fg-muted" />, text: "The deploy request ended before anyone answered it." };
  return (
    <div className="Box flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
      {line.icon}
      <span className="min-w-0 flex-1">{line.text}</span>
      {inFactory && approval.gate?.url && approval.gate.number !== undefined ? (
        <a href={approval.gate.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold">
          {workOrderLabel(approval.gate.number)}
          <LinkExternalIcon size={12} />
        </a>
      ) : null}
    </div>
  );
}

export function Approval({ incident }: { readonly incident: IncidentView }) {
  const approval = incident.approval;
  // A deployed fix shows in the deploy card; one decided in Software Factory also says who approved it there.
  if (!approval || (approval.state === "deployed" && approval.decidedIn !== "software-factory")) return null;
  return approval.state === "waiting" ? <Waiting incident={incident} approval={approval} /> : <Decided approval={approval} />;
}
