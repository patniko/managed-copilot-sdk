import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { ManagedCopilotError, type ArtifactInfo, type DeploymentInfo, type EnvironmentInfo, type PlatformEvent, type WorkerInfo } from "@managed-copilot/sdk";
import { describe, expect, it, vi } from "vitest";
import type { SandboxesView, WorkerItem } from "../src/shared/protocol.js";
import type { AssistantConfig } from "../src/server/config.js";
import { Conversation } from "../src/server/conversation.js";
import { describeApproval, describeTool } from "../src/server/describe.js";
import { networkSummary, sandboxEnvironments, sandboxKind } from "../src/server/environments.js";
import { HttpError } from "../src/server/http.js";
import { createLogger } from "../src/server/log.js";
import type { Platform } from "../src/server/platform.js";
import { Sandboxes, SANDBOXES_LEGACY, SANDBOXES_UNSUPPORTED } from "../src/server/sandboxes.js";
import { Store } from "../src/server/store.js";
import { addDays, zonedParts } from "../src/server/time.js";
import { seedWorkspace } from "../src/server/tools/demo/seed.js";
import { systemInstructions } from "../src/server/tools/index.js";
import { Timeline, type TimelineChange } from "../src/server/timeline.js";

let seq = 0;
function event(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionEvent {
  seq++;
  return { id: `evt-${seq}`, parentId: null, timestamp: new Date(Date.UTC(2026, 9, 27, 17, 0, seq)).toISOString(), type, data, ...extra } as unknown as SessionEvent;
}

const NO_NETWORK = { access: "disabled" as const, allowedDomains: [] };
const GITHUB_ONLY = { access: "restricted" as const, allowedDomains: ["api.github.com", "github.com"] };

const ENVIRONMENTS: EnvironmentInfo[] = [
  { name: "assistant", type: "orchestrator", network: NO_NETWORK, workers: ["assistant-python", "assistant-web"], maxWorkers: 3, scheduling: true, agents: [] },
  { name: "assistant-python", type: "isolated", description: "Python sandbox: calculations and SVG charts. No network.", size: "medium", network: NO_NETWORK, scheduling: false, agents: [] },
  { name: "assistant-web", type: "isolated", description: "Web research sandbox: github.com only.", size: "small", network: GITHUB_ONLY, scheduling: false, agents: [] },
];

const VIEWS = sandboxEnvironments({ environments: ENVIRONMENTS }, ENVIRONMENTS[0]!);
const lookup = (name: string | undefined) => (name === undefined ? VIEWS[0] : VIEWS.find((view) => view.name === name));

describe("sandbox environments", () => {
  it("describes the orchestrator's worker environments, the first being the default", () => {
    expect(VIEWS).toEqual([
      expect.objectContaining({ name: "assistant-python", kind: "python", label: "Python sandbox", size: "medium", network: "network off", default: true }),
      expect.objectContaining({ name: "assistant-web", kind: "web", label: "web research sandbox", size: "small", network: "can reach api.github.com and github.com only", default: false }),
    ]);
    expect(networkSummary({ access: "enabled", allowedDomains: [] })).toBe("full network access");
    expect(networkSummary({ access: "restricted", allowedDomains: ["a.example", "b.example", "c.example", "d.example"] })).toBe("can reach 4 hosts only");
    expect(sandboxKind({ name: "tools", description: "General tools", network: { access: "enabled", allowedDomains: [] } })).toBe("general");
  });
});

describe("sandbox cards in the timeline", () => {
  function timeline() {
    return new Timeline({ timeZone: () => "UTC", scheduleNameFor: () => undefined, isOffline: () => false, isActionable: () => false, sandboxEnvironment: lookup });
  }

  it("turns start_worker and message_worker into cards and reports that sandboxes changed", () => {
    const t = timeline();
    expect(t.apply(event("tool.execution_start", { toolCallId: "c1", toolName: "start_worker", arguments: { name: "meeting-stats", task: "Chart these events" } }))).toEqual([
      { type: "item", item: expect.objectContaining({ kind: "worker", id: "c1", action: "start", worker: "meeting-stats", environment: "assistant-python", status: "running" }) },
    ]);
    const done = t.apply(
      event("tool.execution_complete", {
        toolCallId: "c1",
        success: true,
        result: { content: 'Started worker "meeting-stats" (ID 0b7e3f5c-1111-4222-8333-944455556666) in environment "assistant-python". Its sandbox is starting.' },
      }),
    );
    expect(done).toEqual([
      { type: "item", item: expect.objectContaining({ id: "c1", status: "succeeded", workerId: "0b7e3f5c-1111-4222-8333-944455556666", text: "Chart these events" }) },
      { type: "workers-changed" },
    ]);
    // A follow-up names the sandbox by name or by ID; either way it is the same sandbox.
    t.apply(event("tool.execution_start", { toolCallId: "c2", toolName: "message_worker", arguments: { worker: "0b7e3f5c-1111-4222-8333-944455556666", message: "Split it by type" } }));
    t.apply(event("tool.execution_complete", { toolCallId: "c2", success: true, result: { content: 'Sent to "meeting-stats".' } }));
    expect(t.get("c2")).toMatchObject({ kind: "worker", action: "message", worker: "meeting-stats", environment: "assistant-python", workerId: "0b7e3f5c-1111-4222-8333-944455556666", text: "Split it by type" });
  });

  it("hides waiting and listing, shows file and stop tools as rows, and settles unfinished cards", () => {
    const t = timeline();
    t.apply(event("tool.execution_start", { toolCallId: "w1", toolName: "wait_for_workers", arguments: {} }));
    expect(t.apply(event("tool.execution_complete", { toolCallId: "w1", success: true, result: { content: "done" } }))).toEqual([{ type: "workers-changed" }]);
    t.apply(event("tool.execution_start", { toolCallId: "s1", toolName: "stop_worker", arguments: { worker: "candidate-research" } }));
    t.apply(event("tool.execution_complete", { toolCallId: "s1", success: true, result: { content: "Stopped" } }));
    t.apply(event("tool.execution_start", { toolCallId: "r1", toolName: "read_worker_file", arguments: { worker: "meeting-stats", path: "outputs/report.md" } }));
    expect(t.list().map((item) => (item.kind === "tool" ? item.title : item.kind))).toEqual(["Stopped candidate-research · its sandbox is deleted", "Reading outputs/report.md from meeting-stats…"]);

    const unfinished = timeline();
    unfinished.replaceAll([
      event("user.message", { content: "Chart it", messageId: "m1" }),
      event("assistant.turn_start", { turnId: "t1" }),
      event("tool.execution_start", { toolCallId: "c9", toolName: "start_worker", arguments: { name: "x", task: "y" } }),
      event("abort", { reason: "user initiated" }),
    ]);
    expect(unfinished.get("c9")).toMatchObject({ kind: "worker", status: "failed", error: "Stopped before it finished." });
  });

  it("asks the person before a sandbox starts, describing it", () => {
    const t = timeline();
    t.apply(event("tool.execution_start", { toolCallId: "c3", toolName: "start_worker", arguments: { name: "candidate-research", environment: "assistant-web", task: "Summarize octocat's repositories" } }));
    t.apply(
      event("permission.requested", {
        requestId: "r1",
        permissionRequest: { kind: "custom-tool", toolName: "start_worker", toolCallId: "c3", toolDescription: "", args: { name: "candidate-research", environment: "assistant-web", task: "Summarize octocat's repositories" } },
      }),
    );
    expect(t.get("approval:c3")).toMatchObject({
      kind: "approval",
      tool: "start_worker",
      status: "pending",
      title: "Start a web research sandbox?",
      preview: { type: "sandbox", worker: "candidate-research", environment: "assistant-web", kind: "web", size: "small", network: "can reach api.github.com and github.com only", task: "Summarize octocat's repositories" },
    });
  });
});

describe("sandbox descriptions", () => {
  it("titles approvals by the kind of sandbox", () => {
    expect(describeApproval("start_worker", { name: "stats", task: "Chart" }, "UTC", undefined, lookup).title).toBe("Start a Python sandbox?");
    expect(describeApproval("start_worker", { name: "x", task: "y", environment: "elsewhere" }, "UTC").title).toBe("Start a sandbox?");
    const at = new Date();
    expect(describeTool("copy_worker_files", { from: "a", to: "b", paths: ["outputs/data.csv"] }, "succeeded", undefined, "UTC", at).title).toBe("Copied outputs/data.csv from a to b");
    expect(describeTool("read_worker_file", { worker: "a", path: "." }, "succeeded", undefined, "UTC", at).title).toBe("Listed the files in a");
    expect(describeTool("stop_worker", { worker: "a" }, "failed", undefined, "UTC", at).title).toBe("Couldn't stop a");
  });

  it("tells the agent about sandboxes only when it can start them", () => {
    const withSandboxes = systemInstructions({ name: "Mona", sandboxes: true });
    expect(withSandboxes).toMatch(/Sandboxes \(your workers\)/);
    expect(withSandboxes).toMatch(/can't see this conversation or use your tools/);
    expect(withSandboxes).toMatch(/message_worker/);
    expect(withSandboxes).toMatch(/Don't stop it in the turn it answered/);
    expect(withSandboxes).toMatch(/starting a sandbox require the person's approval/);
    const without = systemInstructions({ name: "Mona" });
    expect(without).not.toMatch(/start_worker|sandbox/i);
  });
});

/** A conversation over fake SDK objects that records its permission handler and sends. */
function conversation(options: { busy?: boolean; blocked?: string } = {}) {
  const store = new Store(":memory:");
  store.upsertUser({ id: 1, login: "octo" });
  store.setSessionId(1, "s1");
  let onPermission: ((request: PermissionRequest) => Promise<PermissionRequestResult>) | undefined;
  const sends: unknown[] = [];
  const systemFor: (string | undefined)[] = [];
  const session = {
    sessionId: "s1",
    getEvents: async () => (options.busy ? [event("user.message", { content: "Chart", messageId: "m1" }), event("assistant.turn_start", { turnId: "t1" })] : []),
    disconnect: async () => undefined,
    send: async (message: unknown) => {
      sends.push(message);
      return "m2";
    },
  };
  const client = {
    resumeSession: async (_id: string, config: { onPermissionRequest: typeof onPermission }) => {
      onPermission = config.onPermissionRequest;
      return session;
    },
    createSession: async () => session,
    stop: async () => [],
    forceStop: async () => undefined,
    ping: async () => ({}),
  };
  const changes: TimelineChange[] = [];
  const subject = new Conversation({
    config: { environment: "assistant", model: "test-model" } as AssistantConfig,
    log: createLogger("test"),
    store,
    platform: { managed: { client: async () => client, sessions: { list: async () => [] } }, reconnect: async () => undefined } as unknown as Platform,
    accountId: () => 1,
    tools: () => [],
    systemMessage: async (sessionId) => {
      systemFor.push(sessionId);
      return "test";
    },
    currentEvent: async () => undefined,
    sandboxBlocked: () => options.blocked,
    timeline: { timeZone: () => "UTC", scheduleNameFor: () => undefined, isOffline: () => false, sandboxEnvironment: lookup },
    onChanges: (batch) => changes.push(...batch),
    onReset: () => undefined,
    onStatus: () => undefined,
    onSessionChanged: () => undefined,
  });
  return { subject, changes, sends, systemFor, permission: (request: PermissionRequest) => onPermission!(request) };
}

const START: PermissionRequest = {
  kind: "custom-tool",
  toolName: "start_worker",
  toolCallId: "c1",
  toolDescription: "",
  args: { name: "meeting-stats", task: "Chart these events" },
} as PermissionRequest;

describe("starting a sandbox from the conversation", () => {
  it("waits for the person (never answered for them) and lets go on detach so it is asked again later", async () => {
    const { subject, permission, systemFor } = conversation();
    await subject.attach();
    expect(systemFor).toEqual(["s1"]);
    const decision = permission(START);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subject.timeline.get("approval:c1")).toMatchObject({ status: "pending", actionable: true, title: "Start a Python sandbox?" });
    await subject.detach("tab closed");
    expect(await decision).toEqual({ kind: "no-result" });
  });

  it("starts it once the person approves, and passes on a refusal's note", async () => {
    const { subject, permission } = conversation();
    await subject.attach();
    const approved = permission(START);
    await new Promise((resolve) => setTimeout(resolve, 0));
    subject.decide("approval:c1", "approve");
    expect(await approved).toEqual({ kind: "approve-once", approvedInteractively: true });
    const declined = permission({ ...START, toolCallId: "c2" } as PermissionRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    subject.decide("approval:c2", "deny", "Not now");
    expect(await declined).toEqual({ kind: "reject", feedback: "The person declined: Not now" });
    await subject.detach("test");
  });

  it("refuses without asking when the conversation can't start sandboxes", async () => {
    const { subject, permission } = conversation({ blocked: SANDBOXES_LEGACY });
    await subject.attach();
    expect(await permission(START)).toEqual({ kind: "reject", feedback: SANDBOXES_LEGACY });
    expect(subject.timeline.get("approval:c1")).toBeUndefined();
    await subject.detach("test");
  });

  it("steers a running turn with new messages instead of queuing them", async () => {
    const idle = conversation();
    await idle.subject.attach();
    await idle.subject.send("Hi");
    expect(idle.sends).toEqual([{ prompt: "Hi" }]);
    await idle.subject.detach("test");

    const busy = conversation({ busy: true });
    await busy.subject.attach();
    await busy.subject.send("Also check tomorrow");
    expect(busy.sends).toEqual([{ prompt: "Also check tomorrow", mode: "immediate" }]);
    await busy.subject.detach("test");
  });
});

// ---- the sandboxes module ---------------------------------------------------------------------------------------

const COORDINATOR = "coord-1";
const T0 = Date.parse("2026-10-27T17:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function worker(overrides: Partial<WorkerInfo> & Pick<WorkerInfo, "id" | "name">): WorkerInfo {
  return { coordinatorId: COORDINATOR, environment: "assistant-python", state: "idle", task: "Chart these events", messages: 1, createdAt: at(1), updatedAt: at(30), ...overrides };
}

function artifact(overrides: Partial<ArtifactInfo> & Pick<ArtifactInfo, "id" | "path">): ArtifactInfo {
  return { size: 120, digest: "sha256:x", contentType: "image/svg+xml", turnId: "turn-1", version: 1, state: "published", publishedAt: at(29), ...overrides };
}

interface FakeOptions {
  type?: string;
  capabilities?: string[];
  environments?: EnvironmentInfo[];
  workers?: WorkerInfo[];
  artifacts?: Record<string, ArtifactInfo[]>;
  sessionId?: string;
  cards?: WorkerItem[];
}

function sandboxes(options: FakeOptions = {}) {
  const store = new Store(":memory:");
  const listeners = new Map<string, Set<(event: PlatformEvent) => void>>();
  const state = {
    workers: options.workers ?? [],
    artifacts: options.artifacts ?? {},
    reads: 0,
    lists: 0,
    waits: 0,
    failReads: 0,
    /** The conversation's session (changes on Start over). */
    sessionId: options.sessionId ?? COORDINATOR,
    /** While set, listing outputs waits for it. */
    listGate: undefined as Promise<void> | undefined,
  };
  const managed = {
    info: { environments: options.environments ?? ENVIRONMENTS, capabilities: options.capabilities ?? ["orchestrator"] } as unknown as DeploymentInfo,
    on: (type: string, handler: (event: PlatformEvent) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
      return () => set.delete(handler);
    },
    sessions: {
      get: async (id: string) => {
        if (id === COORDINATOR || id === state.sessionId) return { id, type: options.type ?? "orchestrator" };
        const found = state.workers.find((candidate) => candidate.id === id);
        if (!found || found.state === "stopped") throw new ManagedCopilotError("not_found", `Session ${id} was not found`);
        return { id, type: "isolated", sandbox: { id: `sbx-${id}`, state: "running" } };
      },
    },
    workers: () => ({ list: async () => state.workers }),
    artifacts: (id: string) => ({
      list: async () => {
        state.lists++;
        if (state.listGate) await state.listGate;
        return state.artifacts[id] ?? [];
      },
      waitForPublication: async () => {
        state.waits++;
        return { turnId: "turn-1", state: "published", artifacts: state.artifacts[id] ?? [] };
      },
      readBytes: async (path: string) => {
        state.reads++;
        if (state.failReads > 0) {
          state.failReads--;
          throw new Error("connection reset");
        }
        if (!state.workers.some((candidate) => candidate.id === id && candidate.state !== "stopped")) throw new ManagedCopilotError("not_found", "gone");
        return new TextEncoder().encode(`<svg><!-- ${path} --></svg>`);
      },
    }),
  };
  const views: SandboxesView[] = [];
  const subject = new Sandboxes({
    log: createLogger("test"),
    store,
    platform: { managed } as unknown as Platform,
    environment: "assistant",
    sessionId: () => state.sessionId,
    cards: () => options.cards ?? [],
    onChange: (view) => views.push(view),
  });
  const emit = (type: string, data: Record<string, unknown>, createdAt: string, sessionId = COORDINATOR) => {
    for (const handler of listeners.get(type) ?? []) handler({ id: `pe-${type}-${createdAt}`, type, createdAt, sessionId, data } as unknown as PlatformEvent);
  };
  subject.listen(managed as never);
  return { subject, store, state, views, emit, reconnect: () => subject.listen(managed as never) };
}

function card(overrides: Partial<WorkerItem> & Pick<WorkerItem, "id">): WorkerItem {
  return { kind: "worker", at: at(0), action: "start", worker: "meeting-stats", environment: "assistant-python", text: "Chart these events", status: "succeeded", endedAt: at(2), ...overrides };
}

class FakeResponse {
  status = 0;
  headers: Record<string, unknown> = {};
  body: Uint8Array | undefined;
  writeHead(status: number, headers: Record<string, unknown>) {
    this.status = status;
    this.headers = headers;
  }
  end(body: Uint8Array) {
    this.body = body;
  }
}

describe("Sandboxes", () => {
  it("is off unless the conversation's environment is an orchestrator, and says why a deployment can't run them", async () => {
    const shared = sandboxes({ environments: [{ ...ENVIRONMENTS[0]!, type: "shared", workers: undefined }] });
    await shared.subject.refresh();
    expect(shared.subject.view).toMatchObject({ enabled: false, environments: [], workers: [] });
    expect(await shared.subject.canStart(undefined)).toBe(false);

    const unsupported = sandboxes({ capabilities: [] });
    await unsupported.subject.refresh();
    expect(unsupported.subject.view).toMatchObject({ enabled: false, unavailable: { reason: SANDBOXES_UNSUPPORTED } });
    expect(unsupported.subject.blocked()).toBe(SANDBOXES_UNSUPPORTED);
  });

  it("offers a new conversation when the current one started before sandboxes", async () => {
    const legacy = sandboxes({ type: "shared" });
    await legacy.subject.refresh();
    expect(legacy.subject.view).toMatchObject({ enabled: false, unavailable: { reason: SANDBOXES_LEGACY, startOver: true }, workers: [] });
    expect(legacy.subject.blocked()).toBe(SANDBOXES_LEGACY);
    expect(await legacy.subject.canStart(COORDINATOR)).toBe(false);
    expect(await legacy.subject.canStart(undefined)).toBe(true);
  });

  it("lists the sandboxes with their sandbox, published outputs (images copied), and how long each card's work took", async () => {
    const stats = worker({ id: "w-stats", name: "meeting-stats", messages: 2, updatedAt: at(80) });
    const research = worker({ id: "w-web", name: "candidate-research", environment: "assistant-web", state: "stopped", updatedAt: at(120) });
    const { subject, store, state } = sandboxes({
      workers: [stats, research],
      artifacts: {
        "w-stats": [
          artifact({ id: "a1", path: "meetings.svg", publishedAt: at(29) }),
          artifact({ id: "a2", path: "data.csv", contentType: "text/csv", publishedAt: at(29) }),
          artifact({ id: "a3", path: "meetings-by-type.svg", publishedAt: at(79) }),
          artifact({ id: "a4", path: "draft.svg", state: "pending" }),
        ],
      },
      cards: [
        card({ id: "c1", workerId: "w-stats", endedAt: at(2) }),
        card({ id: "c2", action: "message", workerId: undefined, at: at(60), endedAt: at(61), text: "Split it" }),
      ],
    });
    await subject.refresh();
    const view = subject.view;
    expect(view.enabled).toBe(true);
    expect(view.workers.map((entry) => [entry.name, entry.state, entry.sandboxState, entry.outputs.map((output) => [output.path, output.image])])).toEqual([
      ["meeting-stats", "idle", "running", [["data.csv", false], ["meetings.svg", true], ["meetings-by-type.svg", true]]],
      ["candidate-research", "stopped", undefined, []],
    ]);
    expect(view.workers[0]!.outputs[1]!.url).toBe("/api/sandboxes/outputs/a1");
    expect(store.output("a1")?.cached).toBe(true);
    expect(store.output("a2")?.cached).toBe(false);
    // The first card's work ended when the follow-up reached the sandbox; the follow-up's when it went idle.
    expect(view.runs).toEqual({
      c1: { workerId: "w-stats", startedAt: at(2), finishedAt: at(61), outcome: "idle" },
      c2: { workerId: "w-stats", startedAt: at(61), finishedAt: at(80), outcome: "idle" },
    });
    // Nothing changed: no second read of the outputs.
    const reads = state.reads;
    await subject.refresh();
    expect(state.reads).toBe(reads);
  });

  it("copies a finished sandbox's images as soon as they publish, before the agent can stop it", async () => {
    const stats = worker({ id: "w1", name: "stats", state: "working", updatedAt: at(3) });
    const { subject, emit, state, store } = sandboxes({ workers: [stats], artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" })] } });
    await subject.refresh();
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(20));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The agent stopped it right away, before the next refresh: the chart was copied already.
    state.workers = [{ ...stats, state: "stopped", updatedAt: at(21) }];
    expect(store.output("a1")?.cached).toBe(true);
    await subject.refresh();
    expect(subject.view.workers[0]!.outputs.map((output) => output.path)).toEqual(["chart.svg"]);
    subject.stop();
  });

  it("finds outputs published while it was disconnected", async () => {
    const idle = worker({ id: "w1", name: "stats", updatedAt: at(20) });
    const { subject, state, reconnect } = sandboxes({ workers: [idle] });
    // Seen idle with nothing published yet; its publication wait finds nothing either, and it is read again.
    await subject.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await subject.refresh();
    const lists = state.lists;
    // Published while the connection was being replaced: no event arrived, and the sandbox's own state didn't change.
    state.artifacts = { w1: [artifact({ id: "a1", path: "chart.svg" })] };
    await subject.refresh();
    expect(state.lists).toBe(lists);
    expect(subject.view.workers[0]!.outputs).toEqual([]);
    // Reconnecting reads every sandbox again.
    reconnect();
    await subject.refresh();
    expect(subject.view.workers[0]!.outputs.map((output) => output.path)).toEqual(["chart.svg"]);
    subject.stop();
  });

  it("keeps a finish that arrived before its card's run was known, even after the sandbox is stopped", async () => {
    const cards: WorkerItem[] = [];
    const research = worker({ id: "w1", name: "research", environment: "assistant-web", state: "working", updatedAt: at(3) });
    const { subject, emit, state } = sandboxes({ workers: [research], cards });
    // Listed at work, but its card isn't in the chat yet (the conversation wasn't loaded) when it finishes.
    await subject.refresh();
    emit("worker.idle", { workerId: "w1", name: "research", state: "idle" }, at(25));
    emit("worker.stopped", { workerId: "w1", name: "research", state: "stopped" }, at(600));
    state.workers = [{ ...research, state: "stopped", updatedAt: at(600) }];
    cards.push(card({ id: "c1", workerId: "w1", worker: "research", environment: "assistant-web" }));
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(25), outcome: "idle" });
    subject.stop();
  });

  it("keeps that finish when the card shows up before the sandbox is stopped", async () => {
    const cards: WorkerItem[] = [];
    const research = worker({ id: "w1", name: "research", environment: "assistant-web", state: "working", updatedAt: at(3) });
    const { subject, emit, state } = sandboxes({ workers: [research], cards });
    await subject.refresh();
    emit("worker.idle", { workerId: "w1", name: "research", state: "idle" }, at(25));
    cards.push(card({ id: "c1", workerId: "w1", worker: "research", environment: "assistant-web" }));
    // Stopped before anything listed the sandboxes again.
    emit("worker.stopped", { workerId: "w1", name: "research", state: "stopped" }, at(600));
    state.workers = [{ ...research, state: "stopped", updatedAt: at(600) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(25), outcome: "idle" });
    subject.stop();
  });

  it("keeps a finish reported before the sandbox was ever listed, when the first listing finds it stopped", async () => {
    const cards: WorkerItem[] = [];
    const research = worker({ id: "w1", name: "research", environment: "assistant-web", state: "stopped", updatedAt: at(30) });
    const { subject, emit } = sandboxes({ workers: [research], cards });
    // Just after a restart: it finishes, its card shows up, and it's stopped, all before anything lists it.
    emit("worker.idle", { workerId: "w1", name: "research", state: "idle" }, at(25));
    cards.push(card({ id: "c1", workerId: "w1", worker: "research", environment: "assistant-web" }));
    emit("worker.stopped", { workerId: "w1", name: "research", state: "stopped" }, at(30));
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(25), outcome: "idle" });
    subject.stop();
  });

  it("places a finish reported before the first listing by that listing, when it was taken before the finish", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) })];
    const stats = worker({ id: "w1", name: "stats", state: "working", updatedAt: at(3) });
    const { subject, emit, state } = sandboxes({ workers: [stats], cards });
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(25));
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(25), outcome: "idle" });
    state.workers = [{ ...stats, state: "stopped", updatedAt: at(600) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(25), outcome: "idle" });
    subject.stop();
  });

  it("ends a card's work when its sandbox finishes, though the platform's clock differs from the card's", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(30) })];
    // The platform's clock is behind: by it, the task was sent at :26 and finished at :27, before the card's tool call
    // returned at :30 by the other clock.
    const stats = worker({ id: "w1", name: "stats", state: "working", updatedAt: at(26) });
    const { subject, emit, state } = sandboxes({ workers: [stats], cards });
    await subject.refresh();
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(27));
    state.workers = [{ ...stats, state: "idle", updatedAt: at(27) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(30), finishedAt: at(30), outcome: "idle" });

    // Its finish was missed: a listing that counts the follow-up's message ends it; one from before it doesn't.
    cards.push(card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(60), endedAt: at(61) }));
    await subject.refresh();
    expect(subject.view.runs.c2).toMatchObject({ startedAt: at(61), finishedAt: undefined });
    state.workers = [{ ...stats, state: "idle", messages: 2, updatedAt: at(59) }];
    await subject.refresh();
    expect(subject.view.runs.c2).toEqual({ workerId: "w1", startedAt: at(61), finishedAt: at(61), outcome: "idle" });
    subject.stop();
  });

  it("doesn't end a follow-up's work with an earlier finish that arrives late", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) })];
    const stats = worker({ id: "w1", name: "stats", state: "idle", updatedAt: at(30) });
    const { subject, emit, state } = sandboxes({ workers: [stats], cards });
    await subject.refresh();
    expect(subject.view.runs.c1).toMatchObject({ finishedAt: at(30), outcome: "idle" });
    cards.push(card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(40), endedAt: at(41) }));
    state.workers = [{ ...stats, state: "working", messages: 2, updatedAt: at(41) }];
    await subject.refresh();
    // The event stream reconnected and caught up: the first task's finish arrives now.
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(30));
    await subject.refresh();
    expect(subject.view.runs.c2).toMatchObject({ startedAt: at(41), finishedAt: undefined });
    state.workers = [{ ...stats, state: "failed", messages: 2, error: "Python crashed", updatedAt: at(90) }];
    await subject.refresh();
    expect(subject.view.runs.c2).toEqual({ workerId: "w1", startedAt: at(41), finishedAt: at(90), outcome: "failed" });
    subject.stop();
  });

  it("knows a sandbox stopped after it finished, when its card showed up late and the clocks differ", async () => {
    const cards: WorkerItem[] = [];
    const research = worker({ id: "w1", name: "research", environment: "assistant-web", state: "working", updatedAt: at(3) });
    const { subject, emit, state } = sandboxes({ workers: [research], cards });
    await subject.refresh();
    // Finished at :39 by the platform's clock; the card (timed by another clock) says its work started at :41.
    emit("worker.idle", { workerId: "w1", name: "research", state: "idle" }, at(39));
    cards.push(card({ id: "c1", workerId: "w1", worker: "research", environment: "assistant-web", endedAt: at(41) }));
    emit("worker.stopped", { workerId: "w1", name: "research", state: "stopped" }, at(600));
    state.workers = [{ ...research, state: "stopped", updatedAt: at(600) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(41), finishedAt: at(41), outcome: "idle" });

    // Seen finished by a listing before its card showed up, and that finish's event was missed.
    const lateCards: WorkerItem[] = [];
    const other = sandboxes({ workers: [{ ...research, state: "idle", updatedAt: at(25) }], cards: lateCards });
    await other.subject.refresh();
    lateCards.push(card({ id: "c1", workerId: "w1", worker: "research", environment: "assistant-web" }));
    other.state.workers = [{ ...research, state: "stopped", updatedAt: at(600) }];
    await other.subject.refresh();
    expect(other.subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(25), outcome: "idle" });
    subject.stop();
    other.subject.stop();
  });

  it("knows a sandbox stopped mid-task was cut short", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) })];
    const stats = worker({ id: "w1", name: "stats", state: "idle", updatedAt: at(30) });
    const { subject, emit, state } = sandboxes({ workers: [stats], cards });
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(30));
    await subject.refresh();
    // The follow-up was under way when the sandbox was stopped: nothing says its message's work finished.
    cards.push(card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(40), endedAt: at(41) }));
    state.workers = [{ ...stats, state: "working", messages: 2, updatedAt: at(41) }];
    await subject.refresh();
    emit("worker.stopped", { workerId: "w1", name: "stats", state: "stopped" }, at(50));
    state.workers = [{ ...stats, state: "stopped", messages: 2, updatedAt: at(50) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(30), outcome: "idle" });
    expect(subject.view.runs.c2).toEqual({ workerId: "w1", startedAt: at(41), finishedAt: at(50), outcome: "stopped" });
    subject.stop();
  });

  it("keeps a failure a listing saw when a follow-up's card shows up while the sandbox is read", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) })];
    const { subject, state } = sandboxes({ workers: [worker({ id: "w1", name: "stats", state: "failed", error: "Python crashed", updatedAt: at(30) })], cards });
    let open!: () => void;
    state.listGate = new Promise((resolve) => (open = resolve));
    const reading = subject.refresh();
    await vi.waitFor(() => expect(state.lists).toBeGreaterThan(0));
    // The agent sent the work again meanwhile.
    cards.push(card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(40), endedAt: at(41) }));
    open();
    await reading;
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(30), outcome: "failed" });
    expect(subject.view.runs.c2).toMatchObject({ startedAt: at(41), finishedAt: undefined });
    subject.stop();
  });

  it("knows how a follow-up ended after a restart, from a listing and the finish right after it", async () => {
    // This server started while the sandbox worked on its second message: it never saw the first.
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) }), card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(40), endedAt: at(41) })];
    const stats = worker({ id: "w1", name: "stats", state: "working", messages: 2, updatedAt: at(41) });
    const { subject, emit, state } = sandboxes({ workers: [stats], cards });
    await subject.refresh();
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(70));
    emit("worker.stopped", { workerId: "w1", name: "stats", state: "stopped" }, at(80));
    state.workers = [{ ...stats, state: "stopped", updatedAt: at(80) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(41), outcome: "idle" });
    expect(subject.view.runs.c2).toEqual({ workerId: "w1", startedAt: at(41), finishedAt: at(70), outcome: "idle" });
    subject.stop();
  });

  it("knows a start whose task never arrived failed, and counts the retry as the first message", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) })];
    const stats = worker({ id: "w1", name: "stats", state: "failed", messages: 0, error: "Couldn't give it its task", updatedAt: at(5) });
    const { subject, state } = sandboxes({ workers: [stats], cards });
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(5), outcome: "failed" });
    // The agent sent the task again, and the sandbox was stopped while it worked on it.
    cards.push(card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(40), endedAt: at(41) }));
    state.workers = [{ ...stats, state: "working", messages: 1, error: undefined, updatedAt: at(41) }];
    await subject.refresh();
    expect(subject.view.runs.c2).toMatchObject({ finishedAt: undefined });
    state.workers = [{ ...stats, state: "stopped", messages: 1, error: undefined, updatedAt: at(60) }];
    await subject.refresh();
    expect(subject.view.runs.c2).toEqual({ workerId: "w1", startedAt: at(41), finishedAt: at(60), outcome: "stopped" });
    subject.stop();
  });

  it("forgets a finish reported for a task the platform took back, so the retry isn't ended by it", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats", endedAt: at(2) })];
    // Listed just after the task was counted, while it was being delivered.
    const stats = worker({ id: "w1", name: "stats", state: "working", messages: 1, updatedAt: at(3) });
    const { subject, emit, state } = sandboxes({ workers: [stats], cards });
    await subject.refresh();
    // Delivery failed: the platform takes the message back and reports the sandbox failed.
    emit("worker.failed", { workerId: "w1", name: "stats", state: "failed" }, at(4));
    state.workers = [{ ...stats, state: "failed", messages: 0, error: "Couldn't give it its task", updatedAt: at(4) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(4), outcome: "failed" });
    cards.push(card({ id: "c2", action: "message", workerId: "w1", worker: "stats", at: at(40), endedAt: at(41) }));
    state.workers = [{ ...stats, state: "working", messages: 1, updatedAt: at(41) }];
    await subject.refresh();
    expect(subject.view.runs.c2).toMatchObject({ startedAt: at(41), finishedAt: undefined });
    state.workers = [{ ...stats, state: "idle", messages: 1, updatedAt: at(70) }];
    await subject.refresh();
    expect(subject.view.runs.c2).toEqual({ workerId: "w1", startedAt: at(41), finishedAt: at(70), outcome: "idle" });
    subject.stop();
  });

  it("writes nothing for a conversation replaced while it was being read", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats" })];
    const { subject, state, store } = sandboxes({ workers: [worker({ id: "w1", name: "stats" })], artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" })] }, cards });
    let open!: () => void;
    state.listGate = new Promise((resolve) => (open = resolve));
    const reading = subject.refresh();
    await vi.waitFor(() => expect(state.lists).toBeGreaterThan(0));
    // Start over: the new conversation has its own card by the time the old read returns.
    state.sessionId = "coord-2";
    cards.splice(0, cards.length, card({ id: "c9", workerId: "w9", worker: "fresh" }));
    subject.reset(COORDINATOR);
    open();
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subject.view.workers).toEqual([]);
    expect(store.runs(COORDINATOR)).toEqual([]);
    expect(store.outputs(COORDINATOR)).toEqual([]);
    subject.stop();
  });

  it("copies an image again by itself after a failed copy, backing off, and gives up after a few tries", async () => {
    vi.useFakeTimers();
    try {
      const { subject, state, store } = sandboxes({ workers: [worker({ id: "w1", name: "stats" })], artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" })] } });
      state.failReads = Number.POSITIVE_INFINITY;
      await subject.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.output("a1")?.cached).toBe(false);
      // The connection recovers: the next try copies it, with nothing else happening.
      state.failReads = 0;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(store.output("a1")?.cached).toBe(true);
      const reads = state.reads;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(state.reads).toBe(reads);

      // Failing for good: a handful of tries, then it waits for something to happen.
      const broken = sandboxes({ workers: [worker({ id: "w1", name: "stats" })], artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" })] } });
      broken.state.failReads = Number.POSITIVE_INFINITY;
      await broken.subject.refresh();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      const tries = broken.state.reads;
      expect(tries).toBeGreaterThanOrEqual(5);
      expect(tries).toBeLessThanOrEqual(8);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(broken.state.reads).toBe(tries);
      subject.stop();
      broken.subject.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("copies an image again after a failed copy, though the sandbox didn't change", async () => {
    const { subject, state, store } = sandboxes({ workers: [worker({ id: "w1", name: "stats" })], artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" })] } });
    state.failReads = Number.POSITIVE_INFINITY;
    await subject.refresh();
    // Its publication wait settles (and fails to copy too); the next refresh fails again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await subject.refresh();
    expect(store.output("a1")?.cached).toBe(false);
    state.failReads = 0;
    await subject.refresh();
    expect(store.output("a1")?.cached).toBe(true);
    subject.stop();
  });

  it("stops copying a broken image after a few tries, even while another sandbox keeps the list polled", async () => {
    vi.useFakeTimers();
    try {
      const { subject, state } = sandboxes({
        workers: [worker({ id: "w1", name: "stats" }), worker({ id: "w2", name: "research", environment: "assistant-web", state: "working", updatedAt: at(3) })],
        artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" })] },
      });
      state.failReads = Number.POSITIVE_INFINITY;
      await subject.refresh();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const tries = state.reads;
      expect(tries).toBeLessThanOrEqual(7);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(state.reads).toBe(tries);
      expect(state.lists).toBeGreaterThan(0);
      subject.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads every sandbox again when a sandbox tool finishes", async () => {
    const { subject, state } = sandboxes({ workers: [worker({ id: "w1", name: "stats" }), worker({ id: "w2", name: "research", environment: "assistant-web" })] });
    await subject.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await subject.refresh();
    const lists = state.lists;
    await subject.refresh();
    expect(state.lists).toBe(lists);
    subject.changed();
    await subject.refresh();
    expect(state.lists).toBe(lists + 2);
    subject.stop();
  });

  it("times work by listings that its events prompt, and ignores other conversations' sandboxes", async () => {
    const cards = [card({ id: "c1", workerId: "w1", worker: "stats" }), card({ id: "c2", workerId: "w2", worker: "research", environment: "assistant-web" })];
    const stats = worker({ id: "w1", name: "stats", state: "working", updatedAt: at(3) });
    const research = worker({ id: "w2", name: "research", environment: "assistant-web", state: "working", updatedAt: at(3) });
    const { subject, emit, state, views } = sandboxes({ workers: [stats, research], cards });
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: undefined, outcome: undefined });
    // A finish in another conversation (even for the same ID) isn't this one's.
    emit("worker.idle", { workerId: "w2", name: "research", state: "idle" }, at(10), "someone-else");
    emit("worker.idle", { workerId: "w1", name: "stats", state: "idle" }, at(21));
    state.workers = [{ ...stats, state: "idle", updatedAt: at(21) }, { ...research, state: "stopped", updatedAt: at(30) }];
    await subject.refresh();
    expect(subject.view.runs.c1).toEqual({ workerId: "w1", startedAt: at(2), finishedAt: at(21), outcome: "idle" });
    expect(subject.view.runs.c2).toEqual({ workerId: "w2", startedAt: at(2), finishedAt: at(30), outcome: "stopped" });
    expect(views.at(-1)!.workers[0]!.state).toBe("idle");
    subject.stop();
  });

  it("serves only this conversation's outputs, keeps images after the sandbox is gone, and downloads other files", async () => {
    const live = worker({ id: "w1", name: "stats" });
    const { subject, state, store } = sandboxes({ workers: [live], artifacts: { w1: [artifact({ id: "a1", path: "chart.svg" }), artifact({ id: "a2", path: "table.csv", contentType: "text/csv" })] } });
    await subject.refresh();
    state.workers = [{ ...live, state: "stopped" }];

    const image = new FakeResponse();
    await subject.serveOutput(image as never, "a1");
    expect(image.status).toBe(200);
    expect(image.headers).toMatchObject({ "content-type": "image/svg+xml", "x-content-type-options": "nosniff" });
    expect(String(image.headers["content-security-policy"])).toMatch(/sandbox/);
    expect(new TextDecoder().decode(image.body)).toContain("chart.svg");

    await expect(subject.serveOutput(new FakeResponse() as never, "a2")).rejects.toMatchObject({ status: 410 });
    state.workers = [live];
    const download = new FakeResponse();
    await subject.serveOutput(download as never, "a2");
    expect(download.headers).toMatchObject({ "content-type": "application/octet-stream" });
    expect(String(download.headers["content-disposition"])).toMatch(/^attachment; filename\*=UTF-8''table\.csv$/);

    store.recordOutputs([{ artifactId: "x1", coordinatorId: "another", workerId: "w1", path: "secret.svg", version: 1, size: 10 }]);
    await expect(subject.serveOutput(new FakeResponse() as never, "x1")).rejects.toBeInstanceOf(HttpError);

    subject.reset(COORDINATOR);
    expect(store.output("a1")).toBeUndefined();
    expect(subject.view.workers).toEqual([]);
  });
});

describe("demo calendar history", () => {
  it("has four weeks of meetings whose load grows with interviews", () => {
    const zone = "America/Los_Angeles";
    const now = new Date("2026-10-27T18:00:00Z");
    const { events } = seedWorkspace(now, zone, { name: "Mona", address: "mona@example.com" });
    const startOfToday = addDays(now, 0, zone);
    const past = events.filter((entry) => entry.start < startOfToday);
    const hours = [0, 1, 2, 3].map((week) => {
      const from = addDays(now, -(week + 1) * 7, zone);
      const to = addDays(now, -week * 7, zone);
      return past.filter((entry) => entry.start >= from && entry.start < to).reduce((sum, entry) => sum + (entry.end.getTime() - entry.start.getTime()) / 3_600_000, 0);
    });
    expect(hours).toEqual([15, 12, 10, 9]);
    expect(past.every((entry) => ![0, 6].includes(zonedParts(entry.start, zone).weekday))).toBe(true);
    const interview = events.find((entry) => entry.start > now && entry.title.startsWith("Interview"));
    expect(interview?.description).toMatch(/GitHub: @octocat/);
  });
});
