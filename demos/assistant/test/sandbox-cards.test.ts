import { describe, expect, it } from "vitest";
import type { ApprovalItem, AssistantItem, SandboxesView, SandboxOutputView, SandboxWorkerView, TimelineItem, UserItem, WorkerItem } from "../src/shared/protocol.js";
import { formatElapsed, replyImages, sandboxCardStates } from "../src/web/src/sandboxCards.js";
import { buildBlocks, type Block } from "../src/web/src/timelineBlocks.js";

const T0 = Date.parse("2027-01-15T22:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const user = (id: string, seconds: number): UserItem => ({ kind: "user", id, at: at(seconds), text: "Hello" });
const reply = (id: string, seconds: number): AssistantItem => ({ kind: "assistant", id, at: at(seconds), text: "Done.", streaming: false, proactive: false });
const card = (id: string, seconds: number, overrides: Partial<WorkerItem> = {}): WorkerItem => ({
  kind: "worker",
  id,
  at: at(seconds),
  action: "start",
  worker: "meeting-stats",
  environment: "assistant-python",
  text: "Chart these events",
  status: "succeeded",
  endedAt: at(seconds + 1),
  ...overrides,
});
const approval = (cardId: string, seconds: number, status: ApprovalItem["status"]): ApprovalItem => ({
  kind: "approval",
  id: `approval:${cardId}`,
  at: at(seconds),
  tool: "start_worker",
  title: "Start a Python sandbox?",
  preview: { type: "sandbox", worker: "meeting-stats", environment: "assistant-python", kind: "python", label: "Python sandbox", task: "Chart these events" },
  status,
  actionable: status === "pending",
  decidedAt: status === "pending" ? undefined : at(seconds + 1),
});
const output = (id: string, path: string, seconds?: number): SandboxOutputView => ({
  id,
  path,
  version: 1,
  size: 100,
  contentType: "image/svg+xml",
  publishedAt: seconds === undefined ? undefined : at(seconds),
  image: true,
  url: `/api/sandboxes/outputs/${id}`,
});
const sandbox = (overrides: Partial<SandboxWorkerView> = {}): SandboxWorkerView => ({
  id: "w1",
  name: "meeting-stats",
  environment: "assistant-python",
  state: "idle",
  messages: 1,
  createdAt: at(2),
  updatedAt: at(30),
  outputs: [],
  ...overrides,
});
const view = (workers: SandboxWorkerView[], runs: SandboxesView["runs"] = {}): SandboxesView => ({
  enabled: true,
  environments: [{ name: "assistant-python", kind: "python", label: "Python sandbox", size: "medium", network: "network off", default: true }],
  workers,
  runs,
});

describe("sandboxCardStates", () => {
  it("follows a card's sandbox through its work, timed by its run", () => {
    const start = card("c1", 0, { workerId: "w1" });
    const working = sandboxCardStates([start], view([sandbox({ state: "working", updatedAt: at(5) })], { c1: { workerId: "w1", startedAt: at(1) } }))(start);
    expect(working).toMatchObject({ phase: "working", startedAt: at(1), finishedAt: undefined, latest: true });
    expect(working.environment?.label).toBe("Python sandbox");
    const done = sandboxCardStates([start], view([sandbox()], { c1: { workerId: "w1", startedAt: at(1), finishedAt: at(22), outcome: "idle" } }))(start);
    expect(done).toMatchObject({ phase: "done", finishedAt: at(22) });
    expect(formatElapsed(Date.parse(done.finishedAt!) - Date.parse(done.startedAt))).toBe("0:21");
  });

  it("shows calls in flight and calls that failed, and works before the sandboxes are known", () => {
    expect(sandboxCardStates([], undefined)(card("c1", 0, { status: "running", endedAt: undefined }))).toMatchObject({ phase: "calling", outputs: [] });
    expect(sandboxCardStates([], undefined)(card("c2", 0, { status: "failed", error: "Too many sandboxes" }))).toMatchObject({ phase: "call-failed" });
    expect(sandboxCardStates([], undefined)(card("c3", 0)).phase).toBeUndefined();
  });

  it("gives each card the outputs published during its work, and finds its sandbox by name when needed", () => {
    const first = card("c1", 0);
    const followUp = card("c2", 40, { action: "message", text: "Split it" });
    const outputs = [output("a1", "meetings.svg", 25), output("a2", "meetings-by-type.svg", 60), output("a3", "notes.svg")];
    const stateOf = sandboxCardStates([first, followUp], view([sandbox({ messages: 2, outputs, updatedAt: at(62) })]));
    expect(stateOf(first)).toMatchObject({ latest: false, phase: "done" });
    expect(stateOf(first).outputs.map((entry) => entry.path)).toEqual(["meetings.svg"]);
    // The latest card also gets outputs without a publication time.
    expect(stateOf(followUp).outputs.map((entry) => entry.path)).toEqual(["meetings-by-type.svg", "notes.svg"]);
    expect(stateOf(followUp)).toMatchObject({ latest: true, phase: "done", finishedAt: at(62) });
  });

  it("reports a failed or stopped sandbox on its latest card", () => {
    const start = card("c1", 0, { workerId: "w1" });
    expect(sandboxCardStates([start], view([sandbox({ state: "failed", error: "Python crashed" })]))(start)).toMatchObject({ phase: "failed", worker: { error: "Python crashed" } });
    expect(sandboxCardStates([start], view([sandbox({ state: "stopped" })]))(start)).toMatchObject({ phase: "stopped" });
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("doesn't take a sandbox's earlier state for a new card's work", () => {
    const first = card("c1", 0, { workerId: "w1" });
    const followUp = card("c2", 40, { action: "message", workerId: "w1", endedAt: at(41) });
    // The follow-up just went out; the last listing still shows the sandbox idle after its first task.
    const stale = sandboxCardStates([first, followUp], view([sandbox({ state: "idle", updatedAt: at(30) })], { c1: { workerId: "w1", startedAt: at(1), finishedAt: at(30), outcome: "idle" } }));
    expect(stale(followUp)).toMatchObject({ phase: "working", finishedAt: undefined });
    expect(stale(first)).toMatchObject({ phase: "done", finishedAt: at(30) });
    // A listing that counts the follow-up's message is about it, though the platform's clock puts its end earlier.
    const skewed = sandboxCardStates(
      [first, followUp],
      view([sandbox({ state: "idle", messages: 2, updatedAt: at(39) })], { c1: { workerId: "w1", startedAt: at(1), finishedAt: at(30), outcome: "idle" }, c2: { workerId: "w1", startedAt: at(41) } }),
    );
    expect(skewed(followUp)).toMatchObject({ phase: "done", finishedAt: at(39) });
    // Started, but not listed yet.
    const fresh = card("c3", 50);
    expect(sandboxCardStates([fresh], view([]))(fresh)).toMatchObject({ phase: "starting" });
    // Listed since (it has a run), and its sandbox is gone: no progress shown.
    expect(sandboxCardStates([fresh], view([], { c3: { startedAt: at(51) } }))(fresh).phase).toBeUndefined();
  });

  it("splits a sandbox's outputs between consecutive cards without overlap", () => {
    const first = card("c1", 0);
    const followUp = card("c2", 40, { action: "message", endedAt: at(41) });
    const stateOf = sandboxCardStates([first, followUp], view([sandbox({ messages: 2, outputs: [output("a1", "early.svg", 38), output("a2", "late.svg", 60)] })]));
    expect(stateOf(first).outputs.map((entry) => entry.path)).toEqual(["early.svg"]);
    expect(stateOf(followUp).outputs.map((entry) => entry.path)).toEqual(["late.svg"]);
  });
});

/** A compact picture of the blocks, like ["user:u1", "worker:c1(approved)", "assistant:a1"]. */
function shape(blocks: readonly Block[]): string[] {
  return blocks
    .filter((block) => block.type === "item" || block.type === "unread")
    .map((block) => {
      if (block.type !== "item") return "unread";
      return `${block.item.kind}:${block.item.id}${block.item.kind === "worker" && block.approval ? "(approved)" : ""}`;
    });
}

describe("buildBlocks with sandboxes", () => {
  const build = (items: TimelineItem[], unreadAnchor?: string) => shape(buildBlocks(items, "America/Los_Angeles", unreadAnchor, new Date(T0)));

  it("shows an approved sandbox as its card, and one waiting for approval as the approval", () => {
    expect(build([user("u1", 0), card("c1", 1), approval("c1", 2, "approved"), reply("a1", 30)])).toEqual(["user:u1", "worker:c1(approved)", "assistant:a1"]);
    expect(build([user("u1", 0), card("c1", 1, { status: "running", endedAt: undefined }), approval("c1", 2, "pending")])).toEqual(["user:u1", "approval:approval:c1"]);
    expect(build([user("u1", 0), card("c1", 1, { status: "failed" }), approval("c1", 2, "denied"), reply("a1", 5)])).toEqual(["user:u1", "approval:approval:c1", "assistant:a1"]);
  });

  it("keeps the unread divider when its item is shown as a sandbox card", () => {
    expect(build([user("u1", 0), card("c1", 1), approval("c1", 2, "approved"), reply("a1", 30)], "approval:c1")).toEqual(["user:u1", "worker:c1(approved)", "unread", "assistant:a1"]);
  });
});

describe("replyImages", () => {
  const named = (id: string, seconds: number, text: string): AssistantItem => ({ ...reply(id, seconds), text });
  const images = (items: TimelineItem[], workers: SandboxWorkerView[]) => {
    const found = replyImages(items, sandboxCardStates(items, view(workers)));
    return Object.fromEntries([...found].map(([replyId, list]) => [replyId, list.map((image) => `${image.output.path}@${image.worker}`)]));
  };

  it("puts a chart under the reply that answers with it", () => {
    const items = [user("u1", 0), named("a0", 1, "Starting a sandbox for meetings.svg."), card("c1", 2), approval("c1", 3, "approved"), named("a1", 31, "Here it is: meetings.svg")];
    expect(images(items, [sandbox({ outputs: [output("o1", "outputs/meetings.svg", 29)] })])).toEqual({ a1: ["outputs/meetings.svg@meeting-stats"] });
  });

  it("skips replies to questions asked while the sandbox worked", () => {
    const items = [
      user("u1", 0),
      card("c1", 2),
      approval("c1", 3, "approved"),
      user("u2", 10),
      named("a1", 12, "Your first meeting tomorrow is at 9:30."),
      named("a2", 40, "Done: your first meeting tomorrow is the standup."),
      named("a3", 41, "The chart is meetings.svg."),
    ];
    expect(images(items, [sandbox({ outputs: [output("o1", "meetings.svg", 30)] })])).toEqual({ a3: ["meetings.svg@meeting-stats"] });
    // Without a reply naming it, the first reply written after it was published.
    expect(images(items.slice(0, 6), [sandbox({ outputs: [output("o1", "meetings.svg", 30)] })])).toEqual({ a2: ["meetings.svg@meeting-stats"] });
  });

  it("shows each image once, and an undated image under the reply that names it", () => {
    const followUp = card("c2", 50, { action: "message" });
    const items = [user("u1", 0), card("c1", 2), named("a1", 31, "See meetings.svg"), user("u2", 49), followUp, named("a2", 70, "Next to meetings.svg, here is by-type.svg")];
    const outputs = [output("o1", "meetings.svg", 29), output("o2", "by-type.svg")];
    expect(images(items, [sandbox({ messages: 2, outputs })])).toEqual({ a1: ["meetings.svg@meeting-stats"], a2: ["by-type.svg@meeting-stats"] });
  });
});
