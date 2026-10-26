/**
 * Sample data for the development preview (`vite`, then `/?preview`). Every value follows the real contracts in
 * shared/protocol.ts. Nothing here ships: production builds never import the dev folder.
 */
import type {
  AccountView,
  AgendaView,
  ApprovalItem,
  BackgroundView,
  ConnectionsView,
  OfflineView,
  PlatformStatus,
  ScheduleView,
  Snapshot,
  TimelineItem,
} from "../../../shared/protocol";
import { dayLabel, timeOf } from "../format";

export const VARIANTS = [
  { id: "", label: "Conversation", description: "Markdown, tools, approvals, a reminder" },
  { id: "busy", label: "Working on a reply", description: "Thinking, then streaming" },
  { id: "welcome", label: "Welcome", description: "A new conversation" },
  { id: "empty", label: "Welcome, background work off", description: "Suggestions wait for consent" },
  { id: "background-off", label: "Background work stopped", description: "A reminder that couldn't be set" },
  { id: "google", label: "Google connected", description: "Changing an event" },
  { id: "google-expired", label: "Google access expired", description: "Reconnect banner and an error" },
  { id: "loading", label: "Loading", description: "Waiting for the first snapshot" },
  { id: "reconnecting", label: "Server connection lost", description: "The event stream dropped" },
  { id: "offline", label: "Platform unreachable", description: "No conversation yet" },
  { id: "unauthenticated", label: "Sign-in required", description: "The cached conversation" },
  { id: "limited", label: "Limited deployment", description: "No scheduled work here" },
  { id: "attach-error", label: "Conversation error", description: "Couldn't resume the session" },
] as const;

export type Variant = (typeof VARIANTS)[number]["id"];

export const PREVIEW_REPLY =
  "This is **preview data**, so nothing real happens here. In the running app I'd answer from your mail and calendar, and anything that sends mail or changes your calendar would ask you first.";

const MINUTE = 60_000;

export function createSnapshot(variant: Variant, now = Date.now()): Snapshot {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const ahead = (minutes: number) => new Date(now + minutes * MINUTE).toISOString();
  /** A clock time on a day relative to today, in the browser's time zone. */
  const on = (days: number, hour: number, minute = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  };
  const halfHour = 30 * MINUTE;
  const slot = (offsetMinutes: number) => new Date(Math.ceil((now + offsetMinutes * MINUTE) / halfHour) * halfHour).toISOString();
  const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MINUTE).toISOString();
  const nextWeekday = (hour: number) => {
    for (let days = 0; days < 8; days++) {
      const candidate = on(days, hour);
      const weekday = new Date(candidate).getDay();
      if (Date.parse(candidate) > now && weekday !== 0 && weekday !== 6) return candidate;
    }
    return on(1, hour);
  };
  const nextDaily = (hour: number) => (Date.parse(on(0, hour)) > now ? on(0, hour) : on(1, hour));

  const account: AccountView = { id: 583231, login: "mona", name: "Mona Lisa Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" };
  const readyPlatform: PlatformStatus = {
    state: "ready",
    url: "http://127.0.0.1:7400",
    environment: "assistant",
    deployment: { name: "local", mode: "local", version: "0.9.0" },
  };

  // ── The conversation ─────────────────────────────────────────────────────────────────────────────────────────
  const stretchAt = ahead(2);
  const reviewStart = on(1, 9);
  const triage = [
    "Here's your inbox, sorted:",
    "",
    "### Needs a reply",
    "1. **Taylor Kim**: *Board deck review*. Wants your comments on slides 8–14 by Thursday.",
    "2. **Sam Rivera**: *Q3 launch plan*. Asks for 30 minutes this week.",
    "",
    "### FYI",
    "- **Priya Shah** shared the onboarding research notes.",
    "- Your flight **NW 482** to Seattle is confirmed (seat 14C).",
    "",
    "### Can wait",
    "| From | Subject | Why it can wait |",
    "| --- | --- | --- |",
    "| The Weekly Byte | Issue 212 | No action needed |",
    "| Fabrikam billing | October invoice | Due in three weeks |",
    "",
    "Want me to draft a reply to Taylor, or find a time for Sam?",
  ].join("\n");
  const terminal = [
    "Run this in a terminal to open our conversation there:",
    "",
    "```powershell",
    "npx managed-copilot attach 8f3c2a1e-5b7d-4c9a-9e21-6d4f0b7a3c55",
    "```",
    "",
    "The session ID is also in **Settings → Conversation**. The [GitHub Copilot docs](https://docs.github.com/copilot) cover the CLI.",
  ].join("\n");
  const briefing = [
    "Good morning! Here's your day:",
    "",
    "- **9:30** Team standup (video call)",
    "- **11:00** 1:1 with Priya",
    "- **12:30** Lunch & learn: *background agents*, Room 4.2",
    "- **3:30** Focus block for the board deck",
    "",
    "Two important emails: Taylor is waiting on your deck comments, and Sam replied about the launch plan.",
  ].join("\n");

  const createApproval: ApprovalItem = {
    kind: "approval",
    id: "approval:t7",
    at: ago(58),
    tool: "create_event",
    title: "Add this event to your calendar?",
    preview: {
      type: "event",
      action: "create",
      title: "Q3 launch plan review",
      start: reviewStart,
      end: plus(reviewStart, 30),
      attendees: ["sam.rivera@contoso.example"],
      location: "Video call",
      description: "Review the Q3 launch plan: timeline, pricing, and the beta cohort.",
      timeZone,
    },
    status: "approved",
    actionable: false,
    decidedAt: ago(57),
  };
  const sendApproval: ApprovalItem = {
    kind: "approval",
    id: "approval:t12",
    at: ago(2),
    tool: "send_email",
    title: "Send this email to Taylor Kim?",
    preview: {
      type: "email",
      to: ["taylor.kim@contoso.example"],
      cc: ["priya.shah@contoso.example"],
      subject: "Re: Board deck review",
      body: "Hi Taylor,\n\nThanks for sending the deck over. I'll review slides 8–14 tomorrow morning and send you my comments by noon.\n\nBest,\nMona",
    },
    status: "pending",
    actionable: true,
  };
  const standupStart = on(1, 9, 30);
  const updateApproval: ApprovalItem = {
    kind: "approval",
    id: "approval:t20",
    at: ago(2),
    tool: "update_event",
    title: "Change “Team standup”?",
    preview: {
      type: "event",
      action: "update",
      start: plus(standupStart, 30),
      attendees: ["sam.rivera@contoso.example", "morgan.lee@contoso.example"],
      location: "Room 4.2",
      current: { title: "Team standup", start: standupStart, end: plus(standupStart, 15) },
      timeZone,
    },
    status: "pending",
    actionable: true,
  };

  const yesterday: TimelineItem[] = [
    { kind: "user", id: "u1", at: ago(1560), text: "Triage my unread email: what needs a reply, what's FYI, and what can wait?" },
    { kind: "tool", id: "t1", at: ago(1559.8), name: "search_email", icon: "mail", title: "Searched your inbox for “is:unread”", detail: "6 messages", status: "succeeded", endedAt: ago(1559.7) },
    { kind: "tool", id: "t2", at: ago(1559.6), name: "read_email", icon: "mail", title: "Read “Board deck review”", status: "succeeded", endedAt: ago(1559.5) },
    { kind: "assistant", id: "a1", at: ago(1559), text: triage, streaming: false, proactive: false },
    { kind: "user", id: "u2", at: ago(1500), text: "Cancel “Expense report” on Friday." },
    {
      kind: "approval",
      id: "approval:t3",
      at: ago(1499),
      tool: "delete_event",
      title: "Cancel “Expense report”?",
      preview: { type: "event", action: "delete", current: { title: "Expense report", start: on(3, 16), end: on(3, 16, 30) }, timeZone },
      status: "denied",
      actionable: false,
      decidedAt: ago(1498),
      feedback: "Keep it, I'll move it myself",
    },
    { kind: "assistant", id: "a2", at: ago(1497), text: "Okay, I left **Expense report** on your calendar.", streaming: false, proactive: false },
    { kind: "user", id: "u3", at: ago(1440), text: "How do I open this conversation in a terminal?" },
    { kind: "assistant", id: "a3", at: ago(1439), text: terminal, streaming: false, proactive: false },
  ];

  const today: TimelineItem[] = [
    { kind: "trigger", id: "tr1", at: ago(170), text: "Brief me on my calendar for today and the important unread mail.", scheduleName: "Weekday morning briefing" },
    {
      kind: "tool",
      id: "t4",
      at: ago(169.9),
      name: "list_events",
      icon: "calendar",
      title: "Checked your calendar",
      detail: `from ${dayLabel(on(0, 0), timeZone)} ${timeOf(on(0, 0), timeZone)} · 4 events`,
      status: "succeeded",
      handledOffline: true,
      endedAt: ago(169.8),
    },
    {
      kind: "tool",
      id: "t5",
      at: ago(169.7),
      name: "search_email",
      icon: "mail",
      title: "Searched your inbox for “is:unread is:important”",
      detail: "2 messages",
      status: "succeeded",
      handledOffline: true,
      endedAt: ago(169.6),
    },
    { kind: "assistant", id: "a4", at: ago(169), text: briefing, streaming: false, proactive: true },
    { kind: "user", id: "u4", at: ago(60), text: "Sam asked for 30 minutes to go over the Q3 launch plan. Find a time in the next few days that works and send the invite." },
    { kind: "tool", id: "t6", at: ago(59.5), name: "find_free_time", icon: "clock", title: "Found 3 open 30-minute slots", status: "succeeded", endedAt: ago(59.4) },
    createApproval,
    { kind: "tool", id: "t7", at: ago(57), name: "create_event", icon: "calendar-plus", title: "Added “Q3 launch plan review” to your calendar", status: "succeeded", endedAt: ago(56.9) },
    {
      kind: "assistant",
      id: "a5",
      at: ago(56),
      text: `Booked **Q3 launch plan review** for ${dayLabel(reviewStart, timeZone).toLowerCase()} at ${timeOf(reviewStart, timeZone)} and invited Sam.`,
      streaming: false,
      proactive: false,
    },
    { kind: "user", id: "u5", at: ago(30), text: "Remind me in 2 minutes to stretch and grab some water." },
    {
      kind: "tool",
      id: "t8",
      at: ago(29.8),
      name: "schedule_task",
      icon: "bell",
      title: "Set a reminder",
      detail: `“Stretch” · ${dayLabel(stretchAt, timeZone)} ${timeOf(stretchAt, timeZone)}`,
      status: "succeeded",
      scheduleId: "sch-stretch",
      endedAt: ago(29.7),
    },
    { kind: "assistant", id: "a6", at: ago(29.5), text: `Done. I'll remind you at ${timeOf(stretchAt, timeZone)}.`, streaming: false, proactive: false },
    { kind: "user", id: "u6", at: ago(20), text: "Summarize every thread with Fabrikam from this quarter." },
    { kind: "assistant", id: "a7", at: ago(19.5), text: "Here's what I found so far: three threads about the renewal, and one about", streaming: false, proactive: false },
    { kind: "notice", id: "n1", at: ago(19.4), level: "info", text: "Stopped." },
    { kind: "user", id: "u7", at: ago(4), text: "Reply to Taylor that I can review the deck tomorrow morning, and copy Priya." },
    {
      kind: "tool",
      id: "t9",
      at: ago(3.8),
      name: "search_email",
      icon: "mail",
      title: "Couldn't search your inbox for “from:taylor”",
      status: "failed",
      error: "The mail search timed out. Retrying with a narrower search.",
      endedAt: ago(3.7),
    },
    { kind: "tool", id: "t10", at: ago(3.6), name: "search_email", icon: "mail", title: "Searched your inbox for “from:taylor deck”", detail: "1 message", status: "succeeded", endedAt: ago(3.5) },
    { kind: "tool", id: "t11", at: ago(3.4), name: "read_email", icon: "mail", title: "Read “Board deck review”", status: "succeeded", endedAt: ago(3.3) },
    sendApproval,
  ];

  // ── Side panel ───────────────────────────────────────────────────────────────────────────────────────────────
  const liveStart = new Date(Math.floor(now / halfHour) * halfHour).toISOString();
  const nextStart = slot(60);
  const agenda: AgendaView = {
    date: on(0, 0).slice(0, 10),
    events: [
      { id: "e1", title: "Design sync", start: liveStart, end: plus(liveStart, 60), allDay: false, location: "Room 2.1" },
      { id: "e2", title: "1:1 with Priya", start: nextStart, end: plus(nextStart, 30), allDay: false },
      { id: "e3", title: "Focus: board deck review", start: plus(nextStart, 120), end: plus(nextStart, 180), allDay: false },
      { id: "e4", title: "Q3 launch plan review", start: reviewStart, end: plus(reviewStart, 30), allDay: false, location: "Video call" },
      { id: "e5", title: "Team standup", start: standupStart, end: plus(standupStart, 15), allDay: false, location: "Video call" },
      { id: "e6", title: "Design review: onboarding", start: on(1, 10), end: on(1, 11), allDay: false, location: "Room 2.1" },
      { id: "e7", title: "Company offsite", start: on(3, 0), end: on(4, 0), allDay: true, location: "Pier 27, San Francisco" },
    ],
  };
  const schedules: ScheduleView[] = [
    {
      id: "sch-briefing",
      name: "Weekday morning briefing",
      cadence: "Every weekday at 8:00 AM",
      cron: "0 8 * * 1-5",
      timeZone,
      prompt: "Brief me on my calendar for today and the important unread mail.",
      state: "active",
      createdBy: "user",
      nextRunAt: nextWeekday(8),
      lastRun: { status: "succeeded", startedAt: ago(170), completedAt: ago(168) },
      oneShot: false,
    },
    {
      id: "sch-stretch",
      name: "Stretch",
      cadence: `Once, ${dayLabel(stretchAt, timeZone).toLowerCase()} at ${timeOf(stretchAt, timeZone)}`,
      runAt: stretchAt,
      timeZone,
      prompt: "Remind me to stretch and grab some water.",
      state: "active",
      createdBy: "agent",
      nextRunAt: stretchAt,
      oneShot: true,
    },
    {
      id: "sch-inbox",
      name: "Inbox zero nudge",
      cadence: "Every day at 5:00 PM",
      cron: "0 17 * * *",
      timeZone,
      prompt: "If I have more than 10 unread emails, nudge me to triage them.",
      state: "active",
      createdBy: "user",
      nextRunAt: nextDaily(17),
      lastRun: { status: "failed", startedAt: ago(1060), completedAt: ago(1059), reason: "Couldn't reach Gmail" },
      oneShot: false,
    },
    {
      id: "sch-wrapup",
      name: "Friday wrap-up",
      cadence: "Every Friday at 4:00 PM",
      cron: "0 16 * * 5",
      timeZone,
      prompt: "Summarize my week: meetings, sent mail, and anything still waiting on me.",
      state: "paused",
      pausedReason: "Paused while background work was off",
      createdBy: "user",
      oneShot: false,
    },
  ];
  const demoConnections: ConnectionsView = {
    provider: "demo",
    google: { configured: true, connected: false, redirectUri: "http://localhost:7490/api/google/callback" },
    demo: { seededAt: ago(1600), address: "mona@example.com" },
  };
  const googleConnections = (status: "ok" | "needs_reconnect"): ConnectionsView => ({
    provider: "google",
    google: {
      configured: true,
      connected: true,
      email: "mona.octocat@gmail.com",
      status,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/calendar.events"],
      connectedAt: ago(3000),
      redirectUri: "http://localhost:7490/api/google/callback",
    },
    demo: { seededAt: ago(1600), address: "mona@example.com" },
  });
  const offline: OfflineView = { webhookConfigured: true, lastWebhookAt: ago(169), handledOffline: 2, waitingApprovals: 0 };
  const backgroundOn: BackgroundView = { state: "on", login: "mona", since: ago(5000), checkedAt: ago(1) };

  const snapshot: Snapshot = {
    account,
    platform: readyPlatform,
    conversation: { attach: "live", busy: false, sessionId: "8f3c2a1e-5b7d-4c9a-9e21-6d4f0b7a3c55", model: "claude-sonnet-5" },
    timeline: [...yesterday, ...today],
    lastReadAt: ago(171),
    connections: demoConnections,
    schedules,
    background: backgroundOn,
    settings: { timeZone },
    offline,
    agenda,
  };

  switch (variant) {
    case "":
    case "loading":
      return snapshot;
    case "busy":
      return {
        ...snapshot,
        conversation: { ...snapshot.conversation, busy: true },
        lastReadAt: ago(0.5),
        timeline: [
          ...yesterday,
          ...today.slice(0, 12),
          { kind: "user", id: "u9", at: ago(0.4), text: "What should I prepare for tomorrow's launch review?" },
          { kind: "tool", id: "t13", at: ago(0.3), name: "list_events", icon: "calendar", title: "Checking your calendar…", status: "running" },
        ],
      };
    case "welcome":
      return { ...snapshot, timeline: [], lastReadAt: undefined, conversation: { ...snapshot.conversation, sessionId: undefined } };
    case "empty":
      return {
        ...snapshot,
        timeline: [],
        lastReadAt: undefined,
        conversation: { ...snapshot.conversation, sessionId: undefined },
        background: { state: "off", login: "mona", checkedAt: ago(1) },
        schedules: [],
        connections: { ...demoConnections, google: { ...demoConnections.google, configured: false } },
      };
    case "background-off":
      return {
        ...snapshot,
        lastReadAt: ago(0.5),
        background: { state: "off", login: "mona", reason: "Your GitHub sign-in for background work was revoked.", checkedAt: ago(1) },
        schedules: schedules
          .filter((schedule) => schedule.id !== "sch-stretch")
          .map((schedule) => ({ ...schedule, state: "paused" as const, pausedReason: "Paused while background work was off", nextRunAt: undefined })),
        timeline: [
          { kind: "user", id: "u1", at: ago(3), text: "Remind me in 2 minutes to stretch and grab some water." },
          {
            kind: "tool",
            id: "t1",
            at: ago(2.9),
            name: "schedule_task",
            icon: "bell",
            title: "Couldn't schedule that",
            detail: `“Stretch” · ${dayLabel(ahead(-1), timeZone)} ${timeOf(ahead(-1), timeZone)}`,
            status: "failed",
            error: "Background work is off, so reminders can't run while you're away.",
            needsBackgroundWork: true,
            endedAt: ago(2.8),
          },
          {
            kind: "assistant",
            id: "a1",
            at: ago(2.7),
            text: "I couldn't set that reminder yet: **background work is off**. Turn it on in the side panel, then ask me again.",
            streaming: false,
            proactive: false,
          },
        ],
      };
    case "google":
      return {
        ...snapshot,
        connections: googleConnections("ok"),
        lastReadAt: ago(0.5),
        timeline: [
          ...yesterday.slice(0, 4),
          {
            kind: "approval",
            id: "approval:t21",
            at: ago(1450),
            tool: "send_email",
            title: "Send this email to Jordan Lee?",
            preview: { type: "email", to: ["jordan.lee@contoso.example"], cc: [], subject: "Quick question", body: "Hi Jordan,\n\nDo you have the Fabrikam contract handy?\n\nThanks,\nMona" },
            status: "expired",
            actionable: false,
          },
          { kind: "user", id: "u20", at: ago(3), text: "Move tomorrow's standup 30 minutes later, in Room 4.2, with Sam and Morgan." },
          {
            kind: "tool",
            id: "t19",
            at: ago(2.8),
            name: "list_events",
            icon: "calendar",
            title: "Checked your calendar",
            detail: `from ${dayLabel(on(1, 0), timeZone)} ${timeOf(on(1, 0), timeZone)} · 3 events`,
            status: "succeeded",
            endedAt: ago(2.7),
          },
          updateApproval,
        ],
      };
    case "google-expired":
      return {
        ...snapshot,
        connections: googleConnections("needs_reconnect"),
        lastReadAt: ago(0.5),
        timeline: [
          ...today.slice(0, 4),
          { kind: "user", id: "u30", at: ago(2), text: "Any new mail from Sam?" },
          { kind: "tool", id: "t30", at: ago(1.9), name: "search_email", icon: "mail", title: "Couldn't search your inbox for “from:sam”", status: "failed", error: "Google access expired.", endedAt: ago(1.8) },
          { kind: "notice", id: "n30", at: ago(1.7), level: "error", text: "Google returned an error: the access token expired. Reconnect Google to keep using your mail and calendar." },
        ],
      };
    case "reconnecting":
      return { ...snapshot, lastReadAt: ago(0.5) };
    case "offline":
      return {
        ...snapshot,
        platform: { state: "unavailable", message: "The gateway at http://127.0.0.1:7400 isn't responding.", retryAt: ahead(0.5), url: readyPlatform.url, environment: "assistant" },
        conversation: { attach: "detached", busy: false, model: "claude-sonnet-5" },
        timeline: [],
        lastReadAt: undefined,
        background: { state: "unknown" },
        schedules: [],
        schedulesError: "Managed Copilot isn't reachable, so your schedules can't be listed right now.",
      };
    case "unauthenticated":
      return {
        ...snapshot,
        lastReadAt: ago(0.5),
        platform: { state: "unauthenticated", message: "GitHub rejected the saved sign-in.", retryAt: ahead(1), url: readyPlatform.url, environment: "assistant" },
        conversation: { ...snapshot.conversation, attach: "detached" },
        background: { state: "unknown" },
      };
    case "limited":
      return {
        ...snapshot,
        platform: { ...readyPlatform, message: "This deployment doesn't allow scheduled work, so reminders and automations are off." },
        background: { state: "unavailable" },
        schedules: [],
        schedulesError: "Schedules aren't enabled for the assistant environment.",
        lastReadAt: ago(0.5),
        timeline: [
          { kind: "user", id: "u40", at: ago(3), text: "Remind me at 5pm to call Mom." },
          { kind: "tool", id: "t40", at: ago(2.9), name: "schedule_task", icon: "bell", title: "Couldn't schedule that", status: "failed", error: "Scheduling isn't enabled on this deployment.", endedAt: ago(2.8) },
          {
            kind: "notice",
            id: "n40",
            at: ago(2.7),
            level: "warning",
            text: "Reminders aren't available on this deployment. Ask an operator to enable scheduling for the assistant environment.",
          },
          {
            kind: "assistant",
            id: "a40",
            at: ago(2.6),
            text: "I can't set reminders on this deployment. I can add **Call Mom** to your calendar at 5:00 PM instead, if you'd like.",
            streaming: false,
            proactive: false,
          },
        ],
      };
    case "attach-error":
      return {
        ...snapshot,
        conversation: { attach: "error", busy: false, model: "claude-sonnet-5", error: "The session couldn't be resumed: it was deleted on the platform. Try again to start a new one." },
        timeline: [],
        lastReadAt: undefined,
      };
  }
}
