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
  SandboxEnvironmentView,
  SandboxesView,
  SandboxOutputView,
  ScheduleView,
  Snapshot,
  TimelineItem,
} from "../../../shared/protocol";
import { dayLabel, timeOf } from "../format";

export const VARIANTS = [
  { id: "", label: "Conversation", description: "Markdown, tools, approvals, a reminder" },
  { id: "busy", label: "Working on a reply", description: "Thinking, then streaming" },
  { id: "sandboxes", label: "Sandboxes", description: "A chart, a reused sandbox, and a new one to approve" },
  { id: "sandbox-working", label: "Sandbox at work", description: "A sandbox running its task" },
  { id: "sandboxes-legacy", label: "Sandboxes unavailable", description: "A conversation from before sandboxes" },
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

export const SANDBOX_ENVIRONMENTS: readonly SandboxEnvironmentView[] = [
  {
    name: "assistant-python",
    kind: "python",
    label: "Python sandbox",
    description: "Python sandbox: calculations, data analysis, and SVG charts from data passed in its task. Python standard library only, no network.",
    size: "medium",
    network: "network off",
    default: true,
  },
  {
    name: "assistant-web",
    kind: "web",
    label: "web research sandbox",
    description: "Web research sandbox: reads public pages and APIs on github.com and api.github.com only.",
    size: "small",
    network: "can reach github.com and api.github.com only",
    default: false,
  },
];

/** A stacked bar chart as an SVG data URL, like the charts a Python sandbox draws (the preview has no server to serve files). */
export function chartDataUrl(title: string, labels: readonly string[], series: readonly { name: string; color: string; values: readonly number[] }[]): string {
  const width = 560;
  const height = 300;
  const left = 48;
  const bottom = 250;
  const top = 56;
  const totals = labels.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const scale = (bottom - top) / (Math.ceil(max / 5) * 5);
  const slot = (width - left - 24) / labels.length;
  const bars: string[] = [];
  labels.forEach((label, index) => {
    let y = bottom;
    const x = left + index * slot + slot * 0.2;
    for (const entry of series) {
      const value = entry.values[index] ?? 0;
      const h = value * scale;
      y -= h;
      bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(slot * 0.6).toFixed(1)}" height="${h.toFixed(1)}" fill="${entry.color}"/>`);
    }
    bars.push(`<text x="${(x + slot * 0.3).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="12" fill="#1f2328">${totals[index]!.toFixed(1)} h</text>`);
    bars.push(`<text x="${(x + slot * 0.3).toFixed(1)}" y="${bottom + 18}" text-anchor="middle" font-size="12" fill="#59636e">${label}</text>`);
  });
  const legend = series.length > 1 ? series.map((entry, index) => `<rect x="${left + index * 150}" y="30" width="10" height="10" fill="${entry.color}"/><text x="${left + index * 150 + 16}" y="39" font-size="12" fill="#59636e">${entry.name}</text>`).join("") : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><rect width="100%" height="100%" fill="#fff"/><text x="${left}" y="20" font-size="14" font-weight="600" fill="#1f2328">${title}</text>${legend}<line x1="${left}" y1="${bottom}" x2="${width - 16}" y2="${bottom}" stroke="#d1d9e0"/>${bars.join("")}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The preview's sandbox outputs: images as data URLs instead of this server's output route. */
function chartOutput(id: string, path: string, publishedAt: string, url: string): SandboxOutputView {
  return { id, path, version: 1, size: 2048, contentType: "image/svg+xml", publishedAt, image: true, url };
}

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

  // ── Sandboxes ────────────────────────────────────────────────────────────────────────────────────────────────
  const noSandboxes: SandboxesView = { enabled: true, environments: SANDBOX_ENVIRONMENTS, maxWorkers: 3, workers: [], runs: {} };
  const weeks = [4, 3, 2, 1].map((weeksAgo) => new Date(now - weeksAgo * 7 * 24 * 60 * MINUTE).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const loadChart = chartDataUrl("Meeting hours per week", weeks, [{ name: "Meetings", color: "#0969da", values: [9, 10, 12, 15] }]);
  const typeChart = chartDataUrl("Meeting hours per week, by type", weeks, [
    { name: "Recurring meetings", color: "#0969da", values: [9, 9, 9, 9] },
    { name: "Interviews, debriefs", color: "#bf8700", values: [0, 1, 3, 5] },
    { name: "Hiring sync", color: "#8250df", values: [0, 0, 0, 1] },
  ]);
  const statsTask = [
    "Here are my 47 calendar events from the last four weeks as CSV (date, start, end, title). Add up the meeting hours for each week (the 7 days ending yesterday, and the 3 weeks before), find what drives any change, and save a bar chart of hours per week as outputs/meetings.svg (plain SVG, Python standard library only).",
    "",
    "date,start,end,title",
    "2026-09-29,09:30,09:45,Team standup",
    "2026-09-29,10:00,11:00,Weekly planning",
    "2026-09-30,11:00,11:30,1:1 with Priya",
    "…",
  ].join("\n");
  const researchTask =
    "Summarize the public repositories and recent activity of the GitHub user octocat (the 2:00 PM interview candidate, Robin Okafor): main languages, notable projects, and what they've worked on lately. Use only github.com and api.github.com, and report back.";
  const sandboxPreview = (worker: string, environment: SandboxEnvironmentView, task: string) => ({
    type: "sandbox" as const,
    worker,
    environment: environment.name,
    kind: environment.kind,
    label: environment.label,
    size: environment.size,
    network: environment.network,
    task,
  });
  const [python, web] = SANDBOX_ENVIRONMENTS as [SandboxEnvironmentView, SandboxEnvironmentView];
  const sandboxConversation: TimelineItem[] = [
    { kind: "user", id: "u60", at: ago(14), text: "How did my meeting load change over the last four weeks? A chart would help." },
    { kind: "tool", id: "t60", at: ago(13.95), name: "list_events", icon: "calendar", title: "Checked your calendar", detail: "47 events in the last four weeks", status: "succeeded", endedAt: ago(13.9) },
    { kind: "worker", id: "w61", at: ago(13.85), action: "start", worker: "meeting-stats", environment: python.name, text: statsTask, status: "succeeded", workerId: "wk-stats", endedAt: ago(13.6) },
    {
      kind: "approval",
      id: "approval:w61",
      at: ago(13.84),
      tool: "start_worker",
      title: "Start a Python sandbox?",
      preview: sandboxPreview("meeting-stats", python, statsTask),
      status: "approved",
      actionable: false,
      decidedAt: ago(13.62),
    },
    {
      kind: "assistant",
      id: "a61",
      at: ago(13.2),
      text: "You spent **15 h** in meetings last week, up from **9 h** four weeks ago. Most of the increase is **interviews**: five last week, with debriefs, and none four weeks ago.\n\nThe chart is in **meetings.svg**.",
      streaming: false,
      proactive: false,
    },
    { kind: "user", id: "u62", at: ago(9), text: "Split it by meeting type too." },
    {
      kind: "worker",
      id: "w62",
      at: ago(8.95),
      action: "message",
      worker: "meeting-stats",
      environment: python.name,
      text: "Using the same events you already have, split each week's hours into recurring meetings, interviews with their debriefs, and the hiring sync. Save a stacked bar chart as outputs/meetings-by-type.svg.",
      status: "succeeded",
      workerId: "wk-stats",
      endedAt: ago(8.9),
    },
    {
      kind: "assistant",
      id: "a62",
      at: ago(8.7),
      text: "Recurring meetings held steady at **9 h** a week. The growth is hiring: interviews and debriefs went from **0 h** to **5 h**, and last week's hiring sync added **1 h**. The split is in **meetings-by-type.svg**.",
      streaming: false,
      proactive: false,
    },
    { kind: "user", id: "u63", at: ago(1), text: "Also check what the 2 PM candidate works on in open source." },
    { kind: "tool", id: "t63", at: ago(0.95), name: "list_events", icon: "calendar", title: "Checked your calendar", detail: "1 event", status: "succeeded", endedAt: ago(0.9) },
    { kind: "worker", id: "w64", at: ago(0.85), action: "start", worker: "candidate-research", environment: web.name, text: researchTask, status: "running" },
    {
      kind: "approval",
      id: "approval:w64",
      at: ago(0.84),
      tool: "start_worker",
      title: "Start a web research sandbox?",
      preview: sandboxPreview("candidate-research", web, researchTask),
      status: "pending",
      actionable: true,
    },
  ];
  const sandboxesInUse: SandboxesView = {
    ...noSandboxes,
    workers: [
      { id: "wk-repo", name: "release-notes", environment: web.name, state: "stopped", messages: 1, createdAt: ago(1510), updatedAt: ago(1500), outputs: [] },
      {
        id: "wk-stats",
        name: "meeting-stats",
        environment: python.name,
        state: "idle",
        messages: 2,
        createdAt: ago(13.62),
        updatedAt: ago(8.75),
        sandboxState: "running",
        outputs: [chartOutput("art-1", "meetings.svg", ago(13.24), loadChart), chartOutput("art-2", "meetings-by-type.svg", ago(8.74), typeChart)],
      },
    ],
    runs: {
      w61: { workerId: "wk-stats", startedAt: ago(13.6), finishedAt: ago(13.25), outcome: "idle" },
      w62: { workerId: "wk-stats", startedAt: ago(8.9), finishedAt: ago(8.75), outcome: "idle" },
    },
  };

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
    sandboxes: noSandboxes,
  };

  switch (variant) {
    case "":
    case "loading":
      return snapshot;
    case "sandboxes":
      return { ...snapshot, conversation: { ...snapshot.conversation, busy: true }, lastReadAt: ago(0.5), timeline: sandboxConversation, sandboxes: sandboxesInUse };
    case "sandbox-working":
      return {
        ...snapshot,
        conversation: { ...snapshot.conversation, busy: true },
        lastReadAt: ago(0.5),
        timeline: [
          { kind: "user", id: "u70", at: ago(1), text: "How did my meeting load change over the last four weeks? A chart would help." },
          { kind: "tool", id: "t70", at: ago(0.95), name: "list_events", icon: "calendar", title: "Checked your calendar", detail: "47 events in the last four weeks", status: "succeeded", endedAt: ago(0.9) },
          { kind: "worker", id: "w71", at: ago(0.85), action: "start", worker: "meeting-stats", environment: python.name, text: statsTask, status: "succeeded", workerId: "wk-stats", endedAt: ago(0.55) },
          {
            kind: "approval",
            id: "approval:w71",
            at: ago(0.84),
            tool: "start_worker",
            title: "Start a Python sandbox?",
            preview: sandboxPreview("meeting-stats", python, statsTask),
            status: "approved",
            actionable: false,
            decidedAt: ago(0.57),
          },
        ],
        sandboxes: {
          ...noSandboxes,
          workers: [{ id: "wk-stats", name: "meeting-stats", environment: python.name, state: "working", messages: 1, createdAt: ago(0.57), updatedAt: ago(0.5), sandboxState: "running", outputs: [] }],
          runs: { w71: { workerId: "wk-stats", startedAt: ago(0.55) } },
        },
      };
    case "sandboxes-legacy":
      return {
        ...snapshot,
        sandboxes: {
          enabled: false,
          unavailable: { reason: "This conversation started before your assistant could use sandboxes. Start a new conversation (Settings → Start over) to use them.", startOver: true },
          environments: SANDBOX_ENVIRONMENTS,
          workers: [],
          runs: {},
        },
      };
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
