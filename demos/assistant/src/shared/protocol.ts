/**
 * Types shared by the assistant server and its web UI. The server turns stock Copilot SDK session events into these
 * timeline items and streams them over server-sent events (`GET /api/events`).
 */

export type TimelineItemKind = "user" | "trigger" | "assistant" | "tool" | "approval" | "notice";

interface BaseItem {
  readonly id: string;
  readonly kind: TimelineItemKind;
  /** ISO timestamp of the underlying session event. */
  readonly at: string;
}

/** A message the person typed. */
export interface UserItem extends BaseItem {
  readonly kind: "user";
  readonly text: string;
}

/** A prompt a schedule delivered into the conversation (a reminder or recurring job firing). */
export interface TriggerItem extends BaseItem {
  readonly kind: "trigger";
  readonly text: string;
  readonly scheduleName?: string;
}

export interface AssistantItem extends BaseItem {
  readonly kind: "assistant";
  readonly text: string;
  readonly streaming: boolean;
  /** True when the turn was started by a schedule rather than by the person. */
  readonly proactive: boolean;
}

export type ToolStatus = "running" | "succeeded" | "failed";

export interface ToolItem extends BaseItem {
  readonly kind: "tool";
  readonly name: string;
  readonly icon: ToolIcon;
  readonly title: string;
  readonly detail?: string;
  readonly status: ToolStatus;
  readonly error?: string;
  /** Answered by the assistant server's webhook or poller while no client was attached. */
  readonly handledOffline?: boolean;
  /** Set for scheduling tools so the UI can offer pause/cancel inline. */
  readonly scheduleId?: string;
  /** A scheduling tool failed because background work is off; the UI offers to turn it on. */
  readonly needsBackgroundWork?: boolean;
  readonly endedAt?: string;
}

export type ToolIcon = "mail" | "send" | "draft" | "calendar" | "calendar-plus" | "calendar-edit" | "calendar-x" | "clock" | "repeat" | "bell" | "tool";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalPreview =
  | {
      readonly type: "email";
      readonly to: readonly string[];
      readonly cc: readonly string[];
      readonly subject: string;
      readonly body: string;
      /** Subject of the message being replied to, when this is a reply. */
      readonly inReplyTo?: string;
    }
  | {
      readonly type: "event";
      readonly action: "create" | "update" | "delete";
      readonly title?: string;
      readonly start?: string;
      readonly end?: string;
      readonly attendees?: readonly string[];
      readonly location?: string;
      readonly description?: string;
      /** For updates and deletes: the event as it is today. */
      readonly current?: { readonly title: string; readonly start: string; readonly end: string };
      readonly timeZone: string;
    }
  | { readonly type: "generic"; readonly summary: string };

export interface ApprovalItem extends BaseItem {
  readonly kind: "approval";
  readonly tool: string;
  readonly title: string;
  readonly preview: ApprovalPreview;
  readonly status: ApprovalStatus;
  /** Whether this server can take the decision right now (a live client holds the request). */
  readonly actionable: boolean;
  readonly decidedAt?: string;
  readonly feedback?: string;
}

export interface NoticeItem extends BaseItem {
  readonly kind: "notice";
  readonly level: "info" | "warning" | "error";
  readonly text: string;
}

export type TimelineItem = UserItem | TriggerItem | AssistantItem | ToolItem | ApprovalItem | NoticeItem;

export type PlatformState = "connecting" | "ready" | "unavailable" | "unauthenticated" | "misconfigured";

export interface PlatformStatus {
  readonly state: PlatformState;
  readonly message?: string;
  /** Next automatic retry, for unavailable/unauthenticated states. */
  readonly retryAt?: string;
  readonly url?: string;
  readonly deployment?: { readonly name: string; readonly mode: string; readonly version: string };
  readonly environment: string;
}

export interface AccountView {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export type AttachState = "detached" | "attaching" | "live" | "reconnecting" | "error";

export interface ConversationStatus {
  readonly attach: AttachState;
  /** A turn is running. */
  readonly busy: boolean;
  readonly sessionId?: string;
  readonly model: string;
  readonly error?: string;
}

export interface ConnectionsView {
  readonly provider: "google" | "demo";
  readonly google: {
    /** Client ID and secret are configured on the server. */
    readonly configured: boolean;
    readonly connected: boolean;
    readonly email?: string;
    readonly status?: "ok" | "needs_reconnect";
    readonly scopes?: readonly string[];
    readonly connectedAt?: string;
    readonly redirectUri: string;
  };
  readonly demo: { readonly seededAt?: string; readonly address: string };
}

export interface ScheduleView {
  readonly id: string;
  readonly name: string;
  /** Human-readable cadence, e.g. "Every weekday at 8:00 AM" or "Once, today at 4:00 PM". */
  readonly cadence: string;
  readonly cron?: string;
  readonly runAt?: string;
  readonly timeZone: string;
  readonly prompt: string;
  readonly state: "active" | "paused";
  /** Why the platform paused it (for example, background work was turned off), in plain words. */
  readonly pausedReason?: string;
  readonly createdBy: "user" | "agent" | "apphost";
  readonly nextRunAt?: string;
  readonly lastRun?: { readonly status: string; readonly startedAt?: string; readonly completedAt?: string; readonly reason?: string };
  readonly oneShot: boolean;
}

export interface OfflineView {
  /** The webhook secret is configured, so the platform can reach this server while no client is attached. */
  readonly webhookConfigured: boolean;
  readonly lastWebhookAt?: string;
  /** Tool calls this server answered through the webhook or poller. */
  readonly handledOffline: number;
  /** Approvals waiting for a person while no client is attached. */
  readonly waitingApprovals: number;
}

export interface AgendaView {
  readonly date: string;
  readonly events: readonly { readonly id: string; readonly title: string; readonly start: string; readonly end: string; readonly allDay: boolean; readonly location?: string }[];
  readonly error?: string;
}

/**
 * Background work (spec section 2): whether the platform may run this person's scheduled work as them while no tab
 * is open. It needs a one-time background sign-in on the deployment.
 */
export interface BackgroundView {
  /**
   * `on`: scheduled work runs as you while you're away. `off`: it isn't turned on, or the platform turned it off.
   * `unknown`: not checked yet. `unavailable`: this deployment can't run background work. `error`: couldn't check.
   */
  readonly state: "unknown" | "on" | "off" | "unavailable" | "error";
  /** The GitHub account background work runs as. */
  readonly login?: string;
  /** When it was turned on. */
  readonly since?: string;
  /** Why it stopped, when the platform turned it off (a revoked sign-in, or turned off elsewhere). */
  readonly reason?: string;
  readonly error?: string;
  readonly checkedAt?: string;
}

export interface Snapshot {
  readonly account?: AccountView;
  readonly platform: PlatformStatus;
  readonly conversation: ConversationStatus;
  readonly timeline: readonly TimelineItem[];
  readonly lastReadAt?: string;
  readonly connections: ConnectionsView;
  readonly schedules: readonly ScheduleView[];
  readonly schedulesError?: string;
  readonly background: BackgroundView;
  readonly settings: { readonly timeZone: string };
  readonly offline: OfflineView;
  readonly agenda?: AgendaView;
}

export type ServerEvent =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "item"; readonly item: TimelineItem }
  | { readonly type: "delta"; readonly id: string; readonly text: string }
  | { readonly type: "status"; readonly platform: PlatformStatus; readonly conversation: ConversationStatus; readonly account?: AccountView }
  | { readonly type: "schedules"; readonly schedules: readonly ScheduleView[]; readonly error?: string }
  | { readonly type: "background"; readonly background: BackgroundView }
  | { readonly type: "connections"; readonly connections: ConnectionsView }
  | { readonly type: "offline"; readonly offline: OfflineView }
  | { readonly type: "agenda"; readonly agenda: AgendaView }
  | { readonly type: "settings"; readonly settings: { readonly timeZone: string } }
  | { readonly type: "read"; readonly lastReadAt: string }
  | { readonly type: "notify"; readonly title: string; readonly body: string; readonly itemId?: string };

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

export interface SendMessageRequest {
  readonly text: string;
}

export interface DecisionRequest {
  readonly decision: "approve" | "deny";
  readonly feedback?: string;
}
