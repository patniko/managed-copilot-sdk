import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { pathScrubber } from "../src/modules/core/sessions.js";
import { AhpObserver, decideAction, decideRequest, elicitationResult, filterResult, uriAwareScrubber } from "../src/modules/attach/policy.js";

const SESSION = "ahp-session:/s1";
const CHAT = "ahp-chat:/c1";
const shared = { sessionId: "s1", placement: "shared" as const, clientId: "cli-1" };
const sandbox = { ...shared, placement: "sandbox" as const };
const message = (text: string, extra: Record<string, unknown> = {}) => ({ text, origin: { kind: "user" }, ...extra });
const turn = (text: string, extra: Record<string, unknown> = {}) => ({ channel: CHAT, clientSeq: 1, action: { type: "chat/turnStarted", turnId: "t", startedAt: "x", message: message(text, extra) } });

describe("attach policy: client requests", () => {
  it("forwards reads of the attached session and refuses everything that reaches further", () => {
    for (const method of ["initialize", "reconnect", "ping", "listSessions", "fetchTurns", "completions", "extensions/getPlan"]) {
      expect(decideRequest({ id: 1, method, params: { channel: "ahp-root://" } }, "s1").kind).toBe("forward");
    }
    for (const method of ["createSession", "disposeSession", "createChat", "createTerminal", "disposeTerminal", "resourceRead", "resourceWrite", "resourceList", "createResourceWatch", "invokeChangesetOperation", "runAutomation", "resolveSessionConfig", "extensions/setSessionApproveAll", "extensions/addProject", "x-copilot/session", "somethingNew"]) {
      expect(decideRequest({ id: 1, method, params: {} }, "s1")).toMatchObject({ kind: "refuse", code: -32009 });
    }
  });

  it("subscribes only to the root, this session, and chats", () => {
    for (const channel of ["ahp-root://", SESSION, CHAT]) expect(decideRequest({ id: 1, method: "subscribe", params: { channel } }, "s1").kind).toBe("forward");
    for (const channel of ["ahp-session:/s2", "ahp-session:/s1/annotations", "ahp-changeset:/c1/session", "ahp-terminal:/t", "ahp-automations://", "ahp-otlp:/logs"]) {
      expect(decideRequest({ id: 1, method: "subscribe", params: { channel } }, "s1").kind).toBe("refuse");
    }
  });

  it("drops channels outside the session from reconnect and initial subscriptions", () => {
    const reconnect = decideRequest({ id: 1, method: "reconnect", params: { clientId: "c", lastSeenServerSeq: 3, subscriptions: ["ahp-root://", SESSION, CHAT, "ahp-terminal:/t", "ahp-changeset:/c1/session"] } }, "s1");
    expect(reconnect).toMatchObject({ kind: "forward", message: { params: { subscriptions: ["ahp-root://", SESSION, CHAT] } } });
    const initialize = decideRequest({ id: 1, method: "initialize", params: { initialSubscriptions: ["ahp-root://", "ahp-terminal:/t"] } }, "s1");
    expect(initialize).toMatchObject({ kind: "forward", message: { params: { initialSubscriptions: ["ahp-root://"] } } });
  });
});

describe("attach policy: client actions", () => {
  it("admits the person's text messages and nothing they could smuggle with them", () => {
    expect(decideAction(turn("Hello"), shared)).toEqual({ kind: "turn", text: "Hello" });
    expect(decideAction(turn("Hello", { model: { id: "gpt-5" } }), shared)).toEqual({ kind: "turn", text: "Hello", modelId: "gpt-5" });
    expect(decideAction({ channel: CHAT, clientSeq: 1, action: { type: "chat/pendingMessageSet", kind: "queued", id: "q", message: message("Later") } }, shared)).toEqual({ kind: "turn", text: "Later" });
    expect(decideAction(turn("Hello", { attachments: [{ type: "resource", uri: "file:///etc/passwd" }] }), shared).kind).toBe("refuse");
    expect(decideAction(turn("Hello", { agent: { name: "x" } }), shared).kind).toBe("refuse");
    expect(decideAction({ channel: CHAT, clientSeq: 1, action: { type: "chat/turnStarted", message: { text: "Hi", origin: { kind: "agent" } } } }, shared).kind).toBe("refuse");
    expect(decideAction(turn("   "), shared).kind).toBe("refuse");
  });

  it("refuses shell commands everywhere and host commands that read other sessions on a shared runtime", () => {
    expect(decideAction(turn("!ls -la"), shared).kind).toBe("refuse");
    expect(decideAction(turn("  !ls"), sandbox).kind).toBe("refuse");
    expect(decideAction(turn("/chronicle search secrets"), shared).kind).toBe("refuse");
    expect(decideAction(turn("/skills reload"), shared).kind).toBe("refuse");
    expect(decideAction(turn("/compact"), shared).kind).toBe("turn");
    expect(decideAction(turn("/chronicle standup"), sandbox).kind).toBe("turn");
    // A path is not a command.
    expect(decideAction(turn("/etc/hosts maps names"), shared).kind).toBe("turn");
  });

  it("lets the CLI switch modes and register itself, but not approvals, tools, or other clients", () => {
    const session = (action: Record<string, unknown>) => ({ channel: SESSION, clientSeq: 1, action });
    expect(decideAction(session({ type: "session/configChanged", config: { mode: "autopilot" } }), shared).kind).toBe("gated");
    expect(decideAction(session({ type: "session/configChanged", config: { approvalMode: "allow-all" } }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "session/configChanged", config: { mode: "plan", approvalMode: "assisted" } }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "session/configChanged", config: { mode: "plan" }, replace: true }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "session/activeClientSet", activeClient: { clientId: "cli-1", tools: [] } }), shared).kind).toBe("gated");
    expect(decideAction(session({ type: "session/activeClientSet", activeClient: { clientId: "cli-1", tools: [{ name: "x" }] } }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "session/activeClientSet", activeClient: { clientId: "cli-1", tools: [], customizations: [{ id: "p" }] } }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "session/activeClientSet", activeClient: { clientId: "cli-2", tools: [] } }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "session/activeClientRemoved", clientId: "cli-1" }), shared).kind).toBe("gated");
    expect(decideAction(session({ type: "session/isArchivedChanged", isArchived: true }), shared).kind).toBe("refuse");
    expect(decideAction(session({ type: "copilot/viewState", view: { view: "main" } }), shared).kind).toBe("gated");
    // Session actions on another session, chat actions on the session channel.
    expect(decideAction({ channel: "ahp-session:/s2", clientSeq: 1, action: { type: "session/titleChanged", title: "x" } }, shared).kind).toBe("refuse");
    expect(decideAction({ channel: SESSION, clientSeq: 1, action: { type: "chat/turnStarted", message: message("x") } }, shared).kind).toBe("refuse");
  });

  it("reads approvals and answers, and never tool results", () => {
    const chat = (action: Record<string, unknown>) => ({ channel: CHAT, clientSeq: 1, action });
    expect(decideAction(chat({ type: "chat/toolCallConfirmed", toolCallId: "tc", approved: true, confirmed: "user-action" }), shared)).toEqual({ kind: "confirm", channel: CHAT, toolCallId: "tc", approved: true });
    expect(decideAction(chat({ type: "chat/toolCallConfirmed", toolCallId: "tc", approved: false, reason: "denied", userSuggestion: { text: "Use 42" } }), shared)).toEqual({ kind: "confirm", channel: CHAT, toolCallId: "tc", approved: false, feedback: "Use 42" });
    expect(decideAction(chat({ type: "chat/toolCallConfirmed", toolCallId: "tc", approved: true, editedToolInput: "{}" }), shared).kind).toBe("refuse");
    expect(decideAction(chat({ type: "chat/inputCompleted", requestId: "ui-1", response: "accept", answers: {} }), shared)).toEqual({ kind: "input", channel: CHAT, inputId: "ui-1", response: "accept", answers: {} });
    for (const type of ["chat/toolCallComplete", "chat/toolCallContentChanged", "chat/toolCallResultConfirmed", "chat/truncated", "chat/turnResume", "chat/workingDirectorySet"]) {
      expect(decideAction(chat({ type, toolCallId: "tc" }), shared).kind).toBe("refuse");
    }
    expect(decideAction(chat({ type: "chat/turnCancelled", turnId: "t" }), shared)).toEqual({ kind: "abort" });
  });
});

describe("attach policy: what the runtime sends", () => {
  it("learns permission request IDs from the runtime's frames and snapshots only", () => {
    const observer = new AhpObserver();
    observer.observe({ method: "action", params: { channel: CHAT, serverSeq: 9, action: { type: "chat/toolCallReady", toolCallId: "tc1", _meta: { requestId: "req-1", permissionRequest: { kind: "custom-tool" } } } } });
    expect(observer.permission(CHAT, "tc1")).toEqual({ requestId: "req-1" });
    expect(observer.lastServerSeq).toBe(9);
    // A tool call that needs no permission is not a prompt.
    observer.observe({ method: "action", params: { channel: CHAT, serverSeq: 10, action: { type: "chat/toolCallReady", toolCallId: "tc2", _meta: { requestId: "x" } } } });
    expect(observer.permission(CHAT, "tc2")).toBeUndefined();
    observer.observe({ method: "action", params: { channel: CHAT, serverSeq: 11, action: { type: "chat/toolCallComplete", toolCallId: "tc1" } } });
    expect(observer.permission(CHAT, "tc1")).toBeUndefined();

    observer.observe({ method: "action", params: { channel: SESSION, serverSeq: 12, action: { type: "session/inputNeededSet", request: { kind: "toolConfirmation", chat: CHAT, toolCall: { toolCallId: "tc3", status: "pending-confirmation", _meta: { requestId: "req-3", permissionRequest: {} } } } } } });
    expect(observer.permission(CHAT, "tc3")).toEqual({ requestId: "req-3" });

    observer.observe({ id: 4, result: { snapshot: { resource: CHAT, state: { activeTurn: { responseParts: [{ kind: "toolCall", toolCall: { toolCallId: "tc4", _meta: { requestId: "req-4", permissionRequest: {} } } }] } } } } });
    expect(observer.permission(CHAT, "tc4")).toEqual({ requestId: "req-4" });
    observer.observe({ id: 5, result: { serverSeq: 40, snapshots: [] } });
    expect(observer.lastServerSeq).toBe(40);
  });

  it("learns questions, linked to a runtime request when the host says so", () => {
    const observer = new AhpObserver();
    const question = (id: string, meta?: Record<string, unknown>) => ({ method: "action", params: { channel: CHAT, serverSeq: 1, action: { type: "chat/inputRequested", request: { id, questions: [{ id: "answer", kind: "text" }], ...(meta ? { _meta: meta } : {}) } } } });
    observer.observe(question("ui-1"));
    observer.observe(question("ui-2", { requestId: "el-1" }));
    expect(observer.input(CHAT, "ui-1")).toEqual({});
    expect(observer.input(CHAT, "ui-2")).toEqual({ requestId: "el-1" });
    observer.observe({ method: "action", params: { channel: CHAT, serverSeq: 2, action: { type: "chat/inputCompleted", requestId: "ui-1" } } });
    expect(observer.input(CHAT, "ui-1")).toBeUndefined();
  });

  it("drops the host's shell prefix and directory, and host commands a shared session can't run", () => {
    expect(filterResult("initialize", { protocolVersion: "0.9.0", terminalCommandPrefix: "!", defaultDirectory: "file:///x", serverSeq: 1 }, "shared")).toEqual({ protocolVersion: "0.9.0", serverSeq: 1 });
    const items = [{ insertText: "/compact" }, { insertText: "/chronicle search" }, { insertText: "/skills reload" }, { insertText: "@agent" }];
    expect((filterResult("completions", { items }, "shared") as { items: unknown[] }).items).toEqual([{ insertText: "/compact" }, { insertText: "@agent" }]);
    expect((filterResult("completions", { items }, "sandbox") as { items: unknown[] }).items).toEqual(items);
  });

  it("maps a person's answers to an elicitation result", () => {
    expect(elicitationResult("accept", { color: { state: "submitted", value: { kind: "text", value: "teal" } }, skipped: { state: "skipped" }, n: { value: { kind: "number", value: 3 } } })).toEqual({ action: "accept", content: { color: "teal", n: 3 } });
    expect(elicitationResult("decline", {})).toEqual({ action: "decline" });
    expect(elicitationResult("cancel", {})).toEqual({ action: "cancel" });
  });

  it("rewrites file URIs and paths under the data directory, encoded or not", () => {
    const dataDir = resolve(tmpdir(), "mc data", "gateway");
    const scrub = uriAwareScrubber(pathScrubber(dataDir));
    const workspace = join(dataDir, "runtime", "shared", "workspaces", "s1");
    const encoded = pathToFileURL(join(workspace, "notes.md")).href;
    expect(encoded).toContain("%20");
    const out = scrub({
      encoded,
      raw: `file:///${workspace.replace(/\\/g, "/")}`,
      plain: join(dataDir, "runtime", "shared", "copilot-home", "plan.md"),
      inText: `Saved to ${join(workspace, "a.txt")} just now`,
      untouched: "file:///opt/elsewhere/x.txt",
    }) as Record<string, string>;
    expect(out).toEqual({
      encoded: "file:///workspace/notes.md",
      raw: "file:///workspace",
      plain: "/platform/copilot-home/plan.md",
      inText: "Saved to /workspace/a.txt just now",
      untouched: "file:///opt/elsewhere/x.txt",
    });
  });
});
