import { CheckCircleFillIcon, FileDiffIcon, InfoIcon, RocketIcon, ShieldIcon, XCircleFillIcon } from "@primer/octicons-react";
import { useState } from "react";
import type { ApprovalView, FileChange, IncidentView } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { between, clock, cx, duration } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
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

/** What waits for a person: deploy the verified fix, or decline it with a reason. */
function Waiting({ incident, approval }: { readonly incident: IncidentView; readonly approval: ApprovalView }) {
  const now = useNow();
  const [busy, setBusy] = useState<"approve" | "decline">();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const added = approval.files.reduce((sum, file) => sum + file.added, 0);
  const removed = approval.files.reduce((sum, file) => sum + file.removed, 0);
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
        <h2 className="min-w-0 flex-1 text-base font-semibold">Deploy the fix to production?</h2>
        <span className="shrink-0 font-mono text-xs text-fg-muted tabular-nums">Waiting {duration(between(approval.requestedAt, now))}</span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-base">{approval.summary}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
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
        </div>
        {approval.problem ? <div className="flash flash-warn flash-sm">{approval.problem}</div> : null}
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
          content={`The app let go of Copilot's session. The platform holds this request for up to 24 hours${approval.announcedAt ? ` and told the app through its webhook at ${clock(approval.announcedAt)}` : ""}. Approving here delivers it.`}
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

/** The request after a decision: compact, one line. */
function Decided({ approval }: { readonly approval: ApprovalView }) {
  const who = approval.decidedBy ? `@${approval.decidedBy}` : "You";
  const waited = approval.decidedAt ? ` after ${duration(between(approval.requestedAt, approval.decidedAt))}` : "";
  const line =
    approval.state === "approved"
      ? { icon: <Spinner size={16} className="text-fg-accent" />, text: `${who} approved the deploy${waited}. Deploying…` }
      : approval.state === "declined"
        ? { icon: <XCircleFillIcon size={16} className="text-fg-danger" />, text: `${who} declined the deploy${waited}${approval.reason ? `: ${approval.reason}` : "."}` }
        : approval.state === "failed"
          ? { icon: <XCircleFillIcon size={16} className="text-fg-danger" />, text: "The deploy failed. The timeline has the details." }
          : { icon: <InfoIcon size={16} className="text-fg-muted" />, text: "The deploy request ended before anyone answered it." };
  return (
    <div className="Box flex items-center gap-2 px-4 py-3 text-sm">
      {line.icon}
      <span className="min-w-0">{line.text}</span>
    </div>
  );
}

export function Approval({ incident }: { readonly incident: IncidentView }) {
  const approval = incident.approval;
  if (!approval || approval.state === "deployed") return null;
  return approval.state === "waiting" ? <Waiting incident={incident} approval={approval} /> : <Decided approval={approval} />;
}
