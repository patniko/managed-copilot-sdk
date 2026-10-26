import type { HealthStatus, OperatorAuditAction, OperatorLogLevel, OperatorWebhookDeliveryState } from "@managed-copilot/protocol/operator";
import type { ActionKind, ActionState, EgressBlockReason, PlatformEventType, SandboxSetupState, SandboxState, ScheduleRunStatus, SessionState } from "@managed-copilot/protocol";
import {
  AlertFillIcon,
  AlertIcon,
  ArrowUpRightIcon,
  BellIcon,
  BugIcon,
  CalendarIcon,
  CheckCircleFillIcon,
  CircleIcon,
  CircleSlashIcon,
  ClockIcon,
  DotFillIcon,
  HourglassIcon,
  InfoIcon,
  PackageIcon,
  PauseIcon,
  PersonIcon,
  PlayIcon,
  PlusCircleIcon,
  QuestionIcon,
  ShieldXIcon,
  SkipIcon,
  StopIcon,
  TrashIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import { humanize } from "./format.js";
import type { Tone } from "./tone.js";

/**
 * How a state is shown, the GitHub way: always an Octicon and a label, never color alone. In-progress states (`spin`)
 * show Primer's spinner in attention yellow, like a running GitHub Actions job.
 */
export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: Icon;
  readonly spin?: boolean;
  readonly description?: string;
}

function meta(label: string, tone: Tone, icon: Icon, extra: { readonly spin?: boolean; readonly description?: string } = {}): StatusMeta {
  return { label, tone, icon, ...extra };
}

/** Unknown values (a newer gateway) still render readably. */
export function unknownMeta(value: string | undefined): StatusMeta {
  return meta(value ? humanize(value) : "Unknown", "neutral", QuestionIcon);
}

function lookup<K extends string>(table: Readonly<Record<K, StatusMeta>>, value: string | undefined): StatusMeta {
  return (value !== undefined && Object.hasOwn(table, value) ? table[value as K] : undefined) ?? unknownMeta(value);
}

const HEALTH: Readonly<Record<HealthStatus, StatusMeta>> = {
  healthy: meta("Healthy", "success", CheckCircleFillIcon),
  degraded: meta("Degraded", "attention", AlertIcon),
  unavailable: meta("Unavailable", "danger", XCircleFillIcon),
  disabled: meta("Disabled", "neutral", CircleSlashIcon),
  unknown: meta("Unknown", "neutral", QuestionIcon),
};

export const healthMeta = (status: string | undefined): StatusMeta => lookup(HEALTH, status);

const SESSION: Readonly<Record<SessionState, StatusMeta>> = {
  creating: meta("Creating", "attention", DotFillIcon, { spin: true }),
  ready: meta("Ready", "success", CheckCircleFillIcon),
  running: meta("Running", "attention", DotFillIcon, { spin: true }),
  waiting: meta("Waiting", "attention", HourglassIcon, { description: "Waiting on an action, input, or permission." }),
  idle: meta("Idle", "neutral", DotFillIcon),
  stopped: meta("Stopped", "neutral", StopIcon),
  promoting: meta("Promoting", "attention", ArrowUpRightIcon, { spin: true }),
  deleting: meta("Deleting", "neutral", TrashIcon, { spin: true }),
  deleted: meta("Deleted", "neutral", TrashIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
};

export const SESSION_STATES = Object.keys(SESSION) as SessionState[];
export const sessionStateMeta = (state: string | undefined): StatusMeta => lookup(SESSION, state);

/** A whole entity's lifecycle, shown like a pull request's state: open (alive), closed (failed), or draft (ended). */
export type Lifecycle = "open" | "closed" | "draft" | "merged";

const SESSION_LIFECYCLE: Readonly<Record<SessionState, Lifecycle>> = {
  creating: "open",
  ready: "open",
  running: "open",
  waiting: "open",
  idle: "open",
  promoting: "open",
  stopped: "draft",
  deleting: "draft",
  deleted: "draft",
  failed: "closed",
};

export function sessionLifecycle(state: string | undefined): Lifecycle {
  return state !== undefined && Object.hasOwn(SESSION_LIFECYCLE, state) ? SESSION_LIFECYCLE[state as SessionState] : "draft";
}

const SANDBOX: Readonly<Record<SandboxState, StatusMeta>> = {
  provisioning: meta("Provisioning", "attention", DotFillIcon, { spin: true }),
  setting_up: meta("Setting up", "attention", DotFillIcon, { spin: true }),
  running: meta("Running", "success", PlayIcon),
  stopping: meta("Stopping", "neutral", StopIcon, { spin: true }),
  stopped: meta("Stopped", "neutral", StopIcon),
  deleting: meta("Deleting", "neutral", TrashIcon, { spin: true }),
  deleted: meta("Deleted", "neutral", TrashIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
};

export const SANDBOX_STATES = Object.keys(SANDBOX) as SandboxState[];
export const sandboxStateMeta = (state: string | undefined): StatusMeta => lookup(SANDBOX, state);

const ACTION: Readonly<Record<ActionState, StatusMeta>> = {
  pending: meta("Pending", "attention", HourglassIcon),
  claimed: meta("Claimed", "accent", PersonIcon),
  executing: meta("Executing", "attention", DotFillIcon, { spin: true }),
  completed: meta("Completed", "success", CheckCircleFillIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
  needs_reconciliation: meta("Needs reconciliation", "danger", AlertFillIcon, {
    description: "A crash left it unknown whether the work happened; a responder must check and reconcile it.",
  }),
  expired: meta("Expired", "neutral", ClockIcon),
  cancelled: meta("Cancelled", "neutral", StopIcon),
};

export const actionStateMeta = (state: string | undefined): StatusMeta => lookup(ACTION, state);

export const ACTION_KIND_LABELS: Readonly<Record<ActionKind, string>> = {
  tool: "Tool call",
  permission: "Permission",
  user_input: "User input",
  elicitation: "Elicitation",
  hook: "Hook",
};

const SCHEDULE: Readonly<Record<"active" | "paused", StatusMeta>> = {
  active: meta("Active", "success", PlayIcon),
  paused: meta("Paused", "attention", PauseIcon),
};

export const scheduleStateMeta = (state: string | undefined): StatusMeta => lookup(SCHEDULE, state);

const RUN: Readonly<Record<ScheduleRunStatus, StatusMeta>> = {
  queued: meta("Queued", "attention", DotFillIcon),
  running: meta("Running", "attention", DotFillIcon, { spin: true }),
  waiting: meta("Waiting", "attention", HourglassIcon),
  completed: meta("Completed", "success", CheckCircleFillIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
  skipped: meta("Skipped", "neutral", SkipIcon),
  needs_reconciliation: meta("Needs reconciliation", "danger", AlertFillIcon),
};

export const runStatusMeta = (status: string | undefined): StatusMeta => lookup(RUN, status);

const DELIVERY: Readonly<Record<OperatorWebhookDeliveryState, StatusMeta>> = {
  pending: meta("Pending", "attention", ClockIcon),
  delivering: meta("Delivering", "attention", DotFillIcon, { spin: true }),
  delivered: meta("Delivered", "success", CheckCircleFillIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
};

export const DELIVERY_STATES = Object.keys(DELIVERY) as OperatorWebhookDeliveryState[];
export const deliveryStateMeta = (state: string | undefined): StatusMeta => lookup(DELIVERY, state);

const TURN: Readonly<Record<"running" | "completed" | "failed" | "cancelled", StatusMeta>> = {
  running: meta("Running", "attention", DotFillIcon, { spin: true }),
  completed: meta("Completed", "success", CheckCircleFillIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
  cancelled: meta("Cancelled", "neutral", StopIcon),
};

export const turnStatusMeta = (status: string | undefined): StatusMeta => lookup(TURN, status);

const RUNTIME: Readonly<Record<"stopped" | "starting" | "running" | "restarting" | "failed" | "disabled", StatusMeta>> = {
  stopped: meta("Stopped", "neutral", StopIcon),
  starting: meta("Starting", "attention", DotFillIcon, { spin: true }),
  running: meta("Running", "success", PlayIcon),
  restarting: meta("Restarting", "attention", DotFillIcon, { spin: true }),
  failed: meta("Failed", "danger", XCircleFillIcon),
  disabled: meta("Disabled", "neutral", CircleSlashIcon),
};

export const runtimeStateMeta = (state: string | undefined): StatusMeta => lookup(RUNTIME, state);

const BACKGROUND: Readonly<Record<"active" | "revoked" | "invalid" | "none", StatusMeta>> = {
  active: meta("Active", "success", CheckCircleFillIcon),
  revoked: meta("Revoked", "attention", CircleSlashIcon),
  invalid: meta("Invalid", "danger", XCircleFillIcon),
  none: meta("None", "neutral", CircleIcon),
};

export const backgroundMeta = (state: string | undefined): StatusMeta => lookup(BACKGROUND, state);

const SETUP: Readonly<Record<SandboxSetupState, StatusMeta>> = {
  pending: meta("Pending", "neutral", ClockIcon),
  running: meta("Running", "attention", DotFillIcon, { spin: true }),
  succeeded: meta("Succeeded", "success", CheckCircleFillIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
};

export const setupStateMeta = (state: string | undefined): StatusMeta => lookup(SETUP, state);

const OUTCOME: Readonly<Record<"succeeded" | "failed", StatusMeta>> = {
  succeeded: meta("Succeeded", "success", CheckCircleFillIcon),
  failed: meta("Failed", "danger", XCircleFillIcon),
};

export const outcomeMeta = (outcome: string | undefined): StatusMeta => lookup(OUTCOME, outcome);

const LOG_LEVEL: Readonly<Record<OperatorLogLevel, StatusMeta>> = {
  debug: meta("Debug", "neutral", BugIcon),
  info: meta("Info", "accent", InfoIcon),
  warn: meta("Warn", "attention", AlertIcon),
  error: meta("Error", "danger", XCircleFillIcon),
};

export const logLevelMeta = (level: string | undefined): StatusMeta => lookup(LOG_LEVEL, level);

const SEVERITY: Readonly<Record<"error" | "warning" | "info", StatusMeta>> = {
  error: meta("Error", "danger", XCircleFillIcon),
  warning: meta("Warning", "attention", AlertIcon),
  info: meta("Info", "accent", InfoIcon),
};

export const severityMeta = (severity: string | undefined): StatusMeta => lookup(SEVERITY, severity);

/** Promotion and artifact states are free-form strings: map the common words. */
export function freeformStateMeta(state: string | undefined): StatusMeta {
  const value = (state ?? "").toLowerCase();
  if (/(fail|error|abort)/.test(value)) return meta(humanize(state), "danger", XCircleFillIcon);
  if (/(commit|complet|publish|succe|done|ready)/.test(value)) return meta(humanize(state), "success", CheckCircleFillIcon);
  if (/(pend|queue|wait)/.test(value)) return meta(humanize(state), "attention", ClockIcon);
  if (/(run|progress|copy|copying|start|export|import|cutover|prepar)/.test(value)) return meta(humanize(state), "attention", DotFillIcon, { spin: true });
  if (/(cancel|rollback|rolled)/.test(value)) return meta(humanize(state), "neutral", StopIcon);
  return unknownMeta(state);
}

export const EVENT_TYPES: Readonly<Record<PlatformEventType, StatusMeta>> = {
  "session.created": meta("Session created", "accent", PlusCircleIcon),
  "session.idle": meta("Session idle", "neutral", DotFillIcon),
  "session.failed": meta("Session failed", "danger", XCircleFillIcon),
  "session.deleted": meta("Session deleted", "neutral", TrashIcon),
  "session.promoted": meta("Session promoted", "done", ArrowUpRightIcon),
  "session.action_required": meta("Action required", "attention", BellIcon),
  "artifact.published": meta("Artifact published", "success", PackageIcon),
  "schedule.run_started": meta("Schedule run started", "accent", CalendarIcon),
  "schedule.run_completed": meta("Schedule run completed", "success", CalendarIcon),
  "network.blocked": meta("Network blocked", "attention", ShieldXIcon),
};

export const PLATFORM_EVENT_TYPES = Object.keys(EVENT_TYPES) as PlatformEventType[];
export const eventTypeMeta = (type: string | undefined): StatusMeta => lookup(EVENT_TYPES, type);

export const EGRESS_REASONS: Readonly<Record<EgressBlockReason, string>> = {
  network_disabled: "Network disabled",
  host_not_allowed: "Host not allowed",
  ip_literal_not_allowed: "IP address not allowed",
  port_not_allowed: "Port not allowed",
  address_not_allowed: "Address not allowed",
  invalid_destination: "Invalid destination",
  sni_mismatch: "SNI mismatch",
  non_tls_tunnel: "Non-TLS tunnel",
  authority_mismatch: "Authority mismatch",
  credential_misuse: "Credential misuse",
  credential_revoked: "Credential revoked",
  tls_client_untrusted: "Client rejected the proxy CA",
  upstream_tls_failed: "Upstream TLS failed",
  unsupported_request: "Unsupported request",
  policy_unavailable: "Policy unavailable",
};

export function egressReasonLabel(reason: string): string {
  return Object.hasOwn(EGRESS_REASONS, reason) ? EGRESS_REASONS[reason as EgressBlockReason] : humanize(reason);
}

export const AUDIT_ACTIONS: Readonly<Record<OperatorAuditAction, string>> = {
  "console.signin": "Signed in to the console",
  "console.signout": "Signed out of the console",
  "sandbox.stop": "Stopped a sandbox",
  "sandboxes.probe": "Checked the sandbox backend",
  "schedule.pause": "Paused a schedule",
  "schedule.resume": "Resumed a schedule",
  "webhook.retry": "Retried a webhook delivery",
};

export function auditActionLabel(action: string): string {
  return Object.hasOwn(AUDIT_ACTIONS, action) ? AUDIT_ACTIONS[action as OperatorAuditAction] : humanize(action);
}
