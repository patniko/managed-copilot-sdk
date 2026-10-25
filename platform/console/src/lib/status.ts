import type { HealthStatus, OperatorAuditAction, OperatorLogLevel, OperatorWebhookDeliveryState } from "@managed-copilot/protocol/operator";
import type { ActionKind, ActionState, EgressBlockReason, PlatformEventType, SandboxSetupState, SandboxState, ScheduleRunStatus, SessionState } from "@managed-copilot/protocol";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  Ban,
  Bug,
  CalendarCheck,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleOff,
  CirclePause,
  CirclePlay,
  CirclePlus,
  CircleQuestionMark,
  CircleX,
  Clock,
  FileUp,
  Hand,
  Hourglass,
  Info,
  LoaderCircle,
  ShieldAlert,
  Square,
  TimerOff,
  Trash,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import { humanize } from "./format.js";
import type { Tone } from "./tone.js";

/** How a state is shown: always an icon and a label, never color alone. */
export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly spin?: boolean;
  readonly description?: string;
}

function meta(label: string, tone: Tone, icon: LucideIcon, extra: { readonly spin?: boolean; readonly description?: string } = {}): StatusMeta {
  return { label, tone, icon, ...extra };
}

/** Unknown values (a newer gateway) still render readably. */
export function unknownMeta(value: string | undefined): StatusMeta {
  return meta(value ? humanize(value) : "Unknown", "neutral", CircleDashed);
}

function lookup<K extends string>(table: Readonly<Record<K, StatusMeta>>, value: string | undefined): StatusMeta {
  return (value !== undefined && Object.hasOwn(table, value) ? table[value as K] : undefined) ?? unknownMeta(value);
}

const HEALTH: Readonly<Record<HealthStatus, StatusMeta>> = {
  healthy: meta("Healthy", "success", CircleCheck),
  degraded: meta("Degraded", "warning", TriangleAlert),
  unavailable: meta("Unavailable", "danger", CircleX),
  disabled: meta("Disabled", "neutral", CircleOff),
  unknown: meta("Unknown", "neutral", CircleQuestionMark),
};

export const healthMeta = (status: string | undefined): StatusMeta => lookup(HEALTH, status);

const SESSION: Readonly<Record<SessionState, StatusMeta>> = {
  creating: meta("Creating", "active", LoaderCircle, { spin: true }),
  ready: meta("Ready", "success", CircleCheck),
  running: meta("Running", "active", LoaderCircle, { spin: true }),
  waiting: meta("Waiting", "warning", Hourglass, { description: "Waiting on an action, input, or permission." }),
  idle: meta("Idle", "neutral", CirclePause),
  stopped: meta("Stopped", "neutral", Square),
  promoting: meta("Promoting", "active", ArrowUpRight),
  deleting: meta("Deleting", "neutral", LoaderCircle, { spin: true }),
  deleted: meta("Deleted", "neutral", Trash),
  failed: meta("Failed", "danger", CircleX),
};

export const SESSION_STATES = Object.keys(SESSION) as SessionState[];
export const sessionStateMeta = (state: string | undefined): StatusMeta => lookup(SESSION, state);

const SANDBOX: Readonly<Record<SandboxState, StatusMeta>> = {
  provisioning: meta("Provisioning", "active", LoaderCircle, { spin: true }),
  setting_up: meta("Setting up", "active", LoaderCircle, { spin: true }),
  running: meta("Running", "success", CirclePlay),
  stopping: meta("Stopping", "neutral", LoaderCircle, { spin: true }),
  stopped: meta("Stopped", "neutral", Square),
  deleting: meta("Deleting", "neutral", LoaderCircle, { spin: true }),
  deleted: meta("Deleted", "neutral", Trash),
  failed: meta("Failed", "danger", CircleX),
};

export const SANDBOX_STATES = Object.keys(SANDBOX) as SandboxState[];
export const sandboxStateMeta = (state: string | undefined): StatusMeta => lookup(SANDBOX, state);

const ACTION: Readonly<Record<ActionState, StatusMeta>> = {
  pending: meta("Pending", "warning", Hourglass),
  claimed: meta("Claimed", "active", UserCheck),
  executing: meta("Executing", "active", LoaderCircle, { spin: true }),
  completed: meta("Completed", "success", CircleCheck),
  failed: meta("Failed", "danger", CircleX),
  needs_reconciliation: meta("Needs reconciliation", "danger", TriangleAlert, {
    description: "A crash left it unknown whether the work happened; a responder must check and reconcile it.",
  }),
  expired: meta("Expired", "neutral", TimerOff),
  cancelled: meta("Cancelled", "neutral", Ban),
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
  active: meta("Active", "success", CirclePlay),
  paused: meta("Paused", "warning", CirclePause),
};

export const scheduleStateMeta = (state: string | undefined): StatusMeta => lookup(SCHEDULE, state);

const RUN: Readonly<Record<ScheduleRunStatus, StatusMeta>> = {
  queued: meta("Queued", "neutral", Clock),
  running: meta("Running", "active", LoaderCircle, { spin: true }),
  waiting: meta("Waiting", "warning", Hourglass),
  completed: meta("Completed", "success", CircleCheck),
  failed: meta("Failed", "danger", CircleX),
  skipped: meta("Skipped", "neutral", CircleOff),
  needs_reconciliation: meta("Needs reconciliation", "danger", TriangleAlert),
};

export const runStatusMeta = (status: string | undefined): StatusMeta => lookup(RUN, status);

const DELIVERY: Readonly<Record<OperatorWebhookDeliveryState, StatusMeta>> = {
  pending: meta("Pending", "warning", Clock),
  delivering: meta("Delivering", "active", LoaderCircle, { spin: true }),
  delivered: meta("Delivered", "success", CircleCheck),
  failed: meta("Failed", "danger", CircleX),
};

export const DELIVERY_STATES = Object.keys(DELIVERY) as OperatorWebhookDeliveryState[];
export const deliveryStateMeta = (state: string | undefined): StatusMeta => lookup(DELIVERY, state);

const TURN: Readonly<Record<"running" | "completed" | "failed" | "cancelled", StatusMeta>> = {
  running: meta("Running", "active", LoaderCircle, { spin: true }),
  completed: meta("Completed", "success", CircleCheck),
  failed: meta("Failed", "danger", CircleX),
  cancelled: meta("Cancelled", "neutral", Ban),
};

export const turnStatusMeta = (status: string | undefined): StatusMeta => lookup(TURN, status);

const RUNTIME: Readonly<Record<"stopped" | "starting" | "running" | "restarting" | "failed" | "disabled", StatusMeta>> = {
  stopped: meta("Stopped", "neutral", Square),
  starting: meta("Starting", "active", LoaderCircle, { spin: true }),
  running: meta("Running", "success", CirclePlay),
  restarting: meta("Restarting", "warning", LoaderCircle, { spin: true }),
  failed: meta("Failed", "danger", CircleX),
  disabled: meta("Disabled", "neutral", CircleOff),
};

export const runtimeStateMeta = (state: string | undefined): StatusMeta => lookup(RUNTIME, state);

const BACKGROUND: Readonly<Record<"active" | "revoked" | "invalid" | "none", StatusMeta>> = {
  active: meta("Active", "success", CircleCheck),
  revoked: meta("Revoked", "warning", Ban),
  invalid: meta("Invalid", "danger", CircleX),
  none: meta("None", "neutral", CircleDashed),
};

export const backgroundMeta = (state: string | undefined): StatusMeta => lookup(BACKGROUND, state);

const SETUP: Readonly<Record<SandboxSetupState, StatusMeta>> = {
  pending: meta("Pending", "neutral", Clock),
  running: meta("Running", "active", LoaderCircle, { spin: true }),
  succeeded: meta("Succeeded", "success", CircleCheck),
  failed: meta("Failed", "danger", CircleX),
};

export const setupStateMeta = (state: string | undefined): StatusMeta => lookup(SETUP, state);

const OUTCOME: Readonly<Record<"succeeded" | "failed", StatusMeta>> = {
  succeeded: meta("Succeeded", "success", CircleCheck),
  failed: meta("Failed", "danger", CircleX),
};

export const outcomeMeta = (outcome: string | undefined): StatusMeta => lookup(OUTCOME, outcome);

const LOG_LEVEL: Readonly<Record<OperatorLogLevel, StatusMeta>> = {
  debug: meta("Debug", "neutral", Bug),
  info: meta("Info", "active", Info),
  warn: meta("Warn", "warning", TriangleAlert),
  error: meta("Error", "danger", CircleAlert),
};

export const logLevelMeta = (level: string | undefined): StatusMeta => lookup(LOG_LEVEL, level);

const SEVERITY: Readonly<Record<"error" | "warning" | "info", StatusMeta>> = {
  error: meta("Error", "danger", CircleAlert),
  warning: meta("Warning", "warning", TriangleAlert),
  info: meta("Info", "active", Info),
};

export const severityMeta = (severity: string | undefined): StatusMeta => lookup(SEVERITY, severity);

/** Promotion and artifact states are free-form strings: map the common words. */
export function freeformStateMeta(state: string | undefined): StatusMeta {
  const value = (state ?? "").toLowerCase();
  if (/(fail|error|abort)/.test(value)) return meta(humanize(state), "danger", CircleX);
  if (/(commit|complet|publish|succe|done|ready)/.test(value)) return meta(humanize(state), "success", CircleCheck);
  if (/(pend|queue|wait)/.test(value)) return meta(humanize(state), "warning", Clock);
  if (/(run|progress|copy|copying|start|export|import|cutover|prepar)/.test(value)) return meta(humanize(state), "active", LoaderCircle, { spin: true });
  if (/(cancel|rollback|rolled)/.test(value)) return meta(humanize(state), "neutral", Ban);
  return unknownMeta(state);
}

export const EVENT_TYPES: Readonly<Record<PlatformEventType, StatusMeta>> = {
  "session.created": meta("Session created", "active", CirclePlus),
  "session.idle": meta("Session idle", "neutral", CirclePause),
  "session.failed": meta("Session failed", "danger", CircleX),
  "session.deleted": meta("Session deleted", "neutral", Trash),
  "session.promoted": meta("Session promoted", "active", ArrowUpRight),
  "session.action_required": meta("Action required", "warning", Hand),
  "artifact.published": meta("Artifact published", "success", FileUp),
  "schedule.run_started": meta("Schedule run started", "active", CalendarClock),
  "schedule.run_completed": meta("Schedule run completed", "success", CalendarCheck),
  "network.blocked": meta("Network blocked", "warning", ShieldAlert),
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
