import { CheckCircleFillIcon, CircleIcon, SkipIcon, StopIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { RunStatus, StepStatus } from "../../shared/types.js";
import { Spinner } from "./ui/Spinner.js";

export const RUN_STATUS: Readonly<Record<RunStatus, { readonly label: string; readonly text: string }>> = {
  running: { label: "Running", text: "text-fg-attention" },
  fixed: { label: "Fixed", text: "text-fg-success" },
  healthy: { label: "Healthy", text: "text-fg-success" },
  not_fixed: { label: "Not fixed", text: "text-fg-danger" },
  failed: { label: "Failed", text: "text-fg-danger" },
  stopped: { label: "Stopped", text: "text-fg-muted" },
};

export function RunStatusIcon({ status, size = 16 }: { readonly status: RunStatus; readonly size?: number }) {
  switch (status) {
    case "running":
      return <Spinner size={size} className="text-fg-attention" />;
    case "fixed":
    case "healthy":
      return <CheckCircleFillIcon size={size} className="text-fg-success" />;
    case "not_fixed":
    case "failed":
      return <XCircleFillIcon size={size} className="text-fg-danger" />;
    case "stopped":
      return <StopIcon size={size} className="text-fg-muted" />;
  }
}

export const STEP_STATUS_LABEL: Readonly<Record<StepStatus, string>> = {
  pending: "Waiting",
  running: "Running",
  passed: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export function StepStatusIcon({ status, size = 16 }: { readonly status: StepStatus; readonly size?: number }) {
  switch (status) {
    case "running":
      return <Spinner size={size} className="text-fg-attention" />;
    case "passed":
      return <CheckCircleFillIcon size={size} className="text-fg-success" />;
    case "failed":
      return <XCircleFillIcon size={size} className="text-fg-danger" />;
    case "skipped":
      return <SkipIcon size={size} className="text-fg-muted" />;
    case "pending":
      return <CircleIcon size={size} className="text-fg-muted" />;
  }
}
