// The session manager's constants and pure helpers (no manager state).
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isManagedCopilotError, ManagedCopilotError, type SessionInference } from "@managed-copilot/protocol";
import type { Logger } from "../../../log.js";
import type { RuntimeSessionEvent } from "../../durable/contract.js";
import { SANDBOX_CUSTOMIZATIONS_DIR } from "../admission.js";
import type { PlatformToolRegistry, ResolvedEnvironment, SessionRecord } from "../contracts.js";
import type { AdmittedConfig, CallbackInventory } from "../ledger.js";
import type { Attachment, InventoryChange, InferenceRoute, LiveSession } from "./types.js";

/** Handler flags the runtime registers per connection; the gateway sends the union across attached clients. */
export const WIRE_FLAGS = ["requestPermission", "requestUserInput", "requestElicitation", "requestExitPlanMode", "requestAutoModeSwitch", "hooks", "hasSkillProvider", "hasMemoryStore"] as const;

/** The callback kinds an attached client registered. */
export function attachmentCallbacks(attachment: Attachment): string[] {
  const kinds: [boolean, string][] = [
    [attachment.requestPermission, "requestPermission"],
    [attachment.requestUserInput, "requestUserInput"],
    [attachment.requestElicitation, "requestElicitation"],
    [attachment.requestExitPlanMode, "requestExitPlanMode"],
    [attachment.requestAutoModeSwitch, "requestAutoModeSwitch"],
    [attachment.hooks, "hooks"],
    [attachment.skillProvider, "skillProvider"],
    [attachment.memoryStore, "memoryStore"],
    [attachment.transforms, "systemMessageTransforms"],
    [attachment.canvases, "canvases"],
  ];
  return kinds.filter(([on]) => on).map(([, name]) => name);
}

/** How long past the runtime's one-hour refresh threshold a GitHub token answer stays valid (the gateway decides again after). */
export const TOKEN_LEASE_SECONDS = 3600 + 300;

export function describeRoute(route: Pick<InferenceRoute, "kind" | "name"> | undefined): string {
  if (!route) return "to its owner's Copilot plan";
  return route.kind === "foundry" ? `to Azure AI Foundry account "${route.name}"` : `to OpenAI-compatible endpoint "${route.name}"`;
}

export function sessionInference(route: InferenceRoute): SessionInference {
  return route.kind === "foundry" ? { route: "foundry", foundry: route.name, deployment: route.model } : { route: "openai", openai: route.name, model: route.model };
}

/**
 * Hook types whose answer can stop the dependent operation, and how they fail closed without their handler (each
 * verified on runtime 1.0.103): a denied tool call, a blocked prompt, and a withheld tool result (`postToolUse` hooks
 * review results, for example to redact them, so the model never sees one they did not review).
 */
export const FAIL_CLOSED_HOOKS: Readonly<Record<string, (reason: string) => Record<string, unknown>>> = {
  preToolUse: (reason) => ({ permissionDecision: "deny", permissionDecisionReason: reason }),
  userPromptSubmitted: (reason) => ({ decision: "block", reason }),
  postToolUse: (reason) => ({ modifiedResult: { textResultForLlm: `The tool ran, but its result is withheld because the session's hooks could not review it. ${reason}`, resultType: "denied" } }),
};

/** Thrown inside dispatch when a placement cutover moved the session after the request was admitted. */
export const MOVED = Symbol("moved");

/** How many times a sandbox runtime is opened again after its sandbox restarted it (`details.reopen`). */
export const MAX_REOPENS = 2;

/**
 * How long a session's registration path (create, resume, restore, a tools update) waits for each answer of its
 * runtime, and then for a `ping` that shows whether its connection still answers at all (`#bounded`). Mutable for tests.
 */
export const upstreamTimings = { answerMs: 60_000, probeMs: 10_000 };

/** What a bound that expired resolves to (never surfaced). */
export const EXPIRED = Symbol("expired");

/** The ending a turn gets when the platform lost the runtime connection it needed (a standard `session.error`). */
export const INTERRUPTED_TURN =
  "This turn was interrupted because the platform lost the connection to the session's runtime (for example, during an update or restart). Send your message again to continue.";

/**
 * Whether a turn has not ended yet: it ends with its root `session.idle`. Its status alone does not say so: a root
 * `session.error` marks it `failed` before it ends (also an error the turn goes on from, and a subagent's).
 */
export function unfinished(turn: SessionRecord["lastTurn"]): turn is NonNullable<SessionRecord["lastTurn"]> {
  return turn !== undefined && turn.completedAt === undefined;
}

/**
 * What a `sendAndWait` the runtime connection was lost under learns. Which turn was its own is not known here (only its
 * answer may have been lost, or another turn was the one cut), so it says what is known; the session's last turn tells
 * the rest, and the turn core ended gets its own `session.error`.
 */
export const LOST_ANSWER =
  "The platform lost the connection to the session's runtime before this message's answer arrived (for example, during an update or restart). The turn may not have finished: check the session before sending the message again.";

/**
 * What a runtime emits because `session.suspend` / `sessions.close` interrupted the session, seen on the wire of runtime
 * 1.0.103 (several are internal types the SDK does not list); an aborted `session.idle` counts too.
 */
const HANDOFF_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.interrupted",
  "abort",
  "external_tool.completed",
  "model.call_finished",
  "model.telemetry",
  "model.turn_failed",
  "model.turn_ended",
  "assistant.turn_end",
  "session.usage_checkpoint",
  "session.shutdown",
]);

/** Session configuration calls: set again on the new owner when a cutover moved the session while they ran. */
export const CONFIG_METHODS: ReadonlySet<string> = new Set([
  "session.options.update",
  "session.tools.set",
  "session.model.switchTo",
  "session.model.switchAutoTier",
  "session.agent.select",
  "session.agent.deselect",
]);

/** Reads of a session's event history (`{ events }`): hidden handoff events are filtered and history origin scrubbed. */
export const HISTORY_METHODS: ReadonlySet<string> = new Set(["session.getMessages", "session.eventLog.read"]);

/** Runtime → client requests bound to a session and the attachment flag that answers them. */
export const CLIENT_REQUESTS: Record<string, keyof Attachment | undefined> = {
  "userInput.request": "requestUserInput",
  "exitPlanMode.request": "requestExitPlanMode",
  "autoModeSwitch.request": "requestAutoModeSwitch",
  "hooks.invoke": "hooks",
  "skillProvider.list": "skillProvider",
  "skillProvider.read": "skillProvider",
  "memoryStore.store": "memoryStore",
  "systemMessage.transform": "transforms",
  "canvas.open": "canvases",
  "canvas.close": "canvases",
  "canvas.action.invoke": "canvases",
};

/** Session-scoped client methods forwarded upstream after the ownership check (supported-operation matrix). */
export const FORWARDED_SESSION_METHODS = new Set([
  "session.send",
  "session.sendAndWait",
  "session.abort",
  "session.getMessages",
  "session.log",
  "session.ui.handlePendingUserInput",
  "session.ui.handlePendingExitPlanMode",
  "session.ui.handlePendingAutoModeSwitch",
  "session.ui.elicitation",
  "session.commands.handlePendingCommand",
  "session.mcp.oauth.handlePendingRequest",
  "session.eventLog.registerInterest",
  "session.eventLog.releaseInterest",
  "session.eventLog.read",
  "session.eventLog.tail",
  "session.model.getCurrent",
  "session.model.list",
  "session.model.setReasoningEffort",
  "session.model.getReasoningSummaries",
  "session.mode.get",
  "session.mode.set",
  "session.name.get",
  "session.name.set",
  "session.name.setAuto",
  "session.tools.getCurrentMetadata",
  "session.tools.listPendingRequests",
  "session.permissions.pendingRequests",
  "session.agent.list",
  "session.agent.getCurrent",
  "session.agent.select",
  "session.agent.deselect",
  "session.skills.list",
  "session.usage.getMetrics",
  "session.quota.get",
  "session.plan.read",
  "session.history.compact",
  "session.metadata.isProcessing",
  "session.metadata.snapshot",
  "session.canvas.list",
  "session.canvas.listOpen",
  "session.canvas.open",
  "session.canvas.close",
  "session.canvas.action.invoke",
  "session.tools.handlePendingToolCall",
  "session.permissions.handlePendingPermissionRequest",
  "session.ui.handlePendingElicitation",
]);

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** How the stock runtime reports a session it has no persisted state for. */
export const UNKNOWN_SESSION = /session not found|failed to load session events/i;

export function workspaceOnly(sessionId: string): ManagedCopilotError {
  return new ManagedCopilotError(
    "invalid_request",
    `Session ${sessionId} is a workspace-only sandbox: it runs commands and holds files, but has no agent to send prompts to, resume, or attach Copilot CLI to. Use managed.exec and managed.files with it.`,
    { sessionId, kind: "workspace" },
  );
}

/** Whether an event is something `session.suspend` / `sessions.close` caused, rather than output already under way. */
export function isHandoffEvent(event: RuntimeSessionEvent): boolean {
  if (typeof event.type !== "string") return true;
  return HANDOFF_EVENT_TYPES.has(event.type) || (event.type === "session.idle" && event.data?.["aborted"] === true);
}

/** `patch` without the keys `replacing` sets (a later resume's configuration replaces earlier option changes). */
export function withoutKeys(patch: Record<string, unknown> | undefined, replacing: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!patch) return undefined;
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !(key in replacing)));
}

export function hooksUnavailable(sessionId: string): string {
  return `Session ${sessionId} has SDK hooks (such as onPreToolUse) that no connected client answers right now, so it does not run work that would skip them. Resume it from the client that registers its hooks.`;
}

/** A record's incarnation, for durable inputs that are scoped to it. */
export function pinned(record: SessionRecord): { readonly incarnation?: string } {
  return record.incarnation ? { incarnation: record.incarnation } : {};
}

/**
 * The sandbox restarted its runtime and asks for it to be opened again (`details.reopen`): stock 1.0.103 keeps the
 * inference-provider registration of a closed connection forever, so a runtime a lost connection served can only
 * serve a new one after a restart.
 */
export function wantsReopen(error: unknown): boolean {
  return isManagedCopilotError(error) && error.details?.["reopen"] === true;
}

/** `60 s`, `0.3 s`. */
export function duration(ms: number): string {
  return `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)} s`;
}

/** A session's callback inventory; sessions stored before it existed always asked for permission decisions. */
export function inventoryOf(stored: AdmittedConfig): CallbackInventory {
  return stored.callbacks ?? { tools: [], flags: { requestPermission: true } };
}

export function applyInventory(base: CallbackInventory | undefined, change: InventoryChange | undefined): CallbackInventory {
  const tools = new Map((base?.tools ?? []).map((tool) => [String(tool["name"]), tool] as const));
  const flags: Record<string, true> = { ...base?.flags };
  const revisions = { tools: { ...base?.revisions?.tools }, flags: { ...base?.revisions?.flags } };
  let revision = base?.revision ?? 0;
  if (change) {
    for (const { name, revision: seen } of change.removeTools) {
      if (revisions.tools[name] !== seen) continue;
      tools.delete(name);
      delete revisions.tools[name];
    }
    for (const { key, revision: seen } of change.removeFlags) {
      if (revisions.flags[key] !== seen) continue;
      delete flags[key];
      delete revisions.flags[key];
    }
    const added = trueFlags(change.flags);
    if (change.tools.length > 0 || Object.keys(added).length > 0) {
      revision += 1;
      for (const tool of change.tools) {
        tools.set(String(tool["name"]), tool);
        revisions.tools[String(tool["name"])] = revision;
      }
      for (const key of Object.keys(added)) {
        flags[key] = true;
        revisions.flags[key] = revision;
      }
    }
  }
  return { tools: [...tools.values()], flags, revisions, revision };
}

/** The registration in create/resume params: the client's tool declarations (no platform tools) and handler flags. */
export function registrationOf(params: Record<string, unknown>, platformTools: PlatformToolRegistry, environment: string): { tools: Record<string, unknown>[]; flags: Record<string, unknown> } {
  return { tools: clientDeclarations(params["tools"], platformTools, environment), flags: Object.fromEntries(WIRE_FLAGS.filter((key) => params[key] !== undefined).map((key) => [key, params[key]])) };
}

export function clientDeclarations(tools: unknown, platformTools: PlatformToolRegistry, environment: string): Record<string, unknown>[] {
  return ((Array.isArray(tools) ? tools : []) as Record<string, unknown>[]).filter((tool) => !platformTools.has(String(tool["name"]), environment));
}

export function trueFlags(flags: Readonly<Record<string, unknown>>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const key of WIRE_FLAGS) if (flags[key] === true) out[key] = true;
  return out;
}

export function cutoverClosed(sessionId: string): ManagedCopilotError {
  return new ManagedCopilotError("conflict", `The cutover of session ${sessionId} is already closed`, { sessionId });
}

/** Whether an agent name resolves in a session's configuration: deployed with its environment, or declared inline. */
export function agentResolves(environment: ResolvedEnvironment, name: string, params: Record<string, unknown>): boolean {
  if (environment.customizations?.agents.some((agent) => agent.name === name)) return true;
  const inline = params["customAgents"];
  return Array.isArray(inline) && inline.some((agent) => agent && typeof agent === "object" && (agent as { name?: unknown }).name === name);
}

/** Whether stored admitted params include remote MCP servers (top-level or in custom agents). */
export function hasRemoteMcp(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  const servers = params["mcpServers"];
  if (servers && typeof servers === "object" && Object.keys(servers).length > 0) return true;
  const agents = params["customAgents"];
  return Array.isArray(agents) && agents.some((agent) => agent && typeof agent === "object" && (agent as { mcpServers?: object }).mcpServers && Object.keys((agent as { mcpServers: object }).mcpServers).length > 0);
}

/** Whether the session's admitted configuration has memory its app stores (`memory.storeMemory`). */
export function hasAppMemory(params: Record<string, unknown> | undefined): boolean {
  const memory = params?.["memory"];
  return Boolean(memory && typeof memory === "object" && (memory as { enabled?: unknown }).enabled === true);
}

/**
 * Shared sessions keep memory only while a client stores it: without `hasMemoryStore` the runtime would fall back to
 * its built-in memory backends, which are state across the shared runtime's sessions. Turned off instead.
 */
export function withoutHostMemory(live: LiveSession, params: Record<string, unknown>, log: Logger): Record<string, unknown> {
  if (live.placement !== "shared" || !hasAppMemory(params) || params["hasMemoryStore"] === true) return params;
  log.warn("Turning memory off: no client stores this shared session's memories", { sessionId: live.id });
  return { ...params, memory: { enabled: false } };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a deep string replacer for platform host paths under the gateway's data directory, tolerant of slash
 * direction, case on Windows, and the directory's resolved form (8.3 names, symlinks): a shared session's directory
 * becomes `/workspace`, a pinned customizations bundle the path sandboxes mount it at, anything else `/platform`.
 */
export function pathScrubber(dataDir: string): (value: unknown) => unknown {
  const separators = String.raw`[\\/]+`;
  // Session IDs, environment names, and bundle digests: identifier characters only, so punctuation after a path stays.
  const segment = String.raw`[A-Za-z0-9_-]+`;
  // The rest of the path (segments without spaces), rewritten with POSIX separators.
  const tail = String.raw`((?:[\\/]+[^\\/\s"'\`]+)*)`;
  // The directory itself, not part of a longer name: `/data` is neither `/mnt/data` nor `/database` (`/data.` ends one).
  const before = String.raw`(?<![A-Za-z0-9_.~-])`;
  const after = String.raw`(?![A-Za-z0-9_~-]|\.[A-Za-z0-9_~-])`;
  const flags = process.platform === "win32" ? "gi" : "g";
  const variants = new Set([resolvePath(dataDir)]);
  try {
    variants.add(realpathSync.native(dataDir));
  } catch {
    // Not created yet: the configured form is the one the runtime sees.
  }
  const rules: [RegExp, string][] = [];
  for (const variant of variants) {
    const root = before + variant.replace(/[\\/]+$/, "").split(/[\\/]+/).map(escapeRegExp).join(separators);
    rules.push(
      [new RegExp(`${root}${separators}runtime${separators}shared${separators}workspaces${separators}${segment}${tail}`, flags), "/workspace"],
      [new RegExp(`${root}${separators}customizations${separators}${segment}${separators}${segment}${tail}`, flags), SANDBOX_CUSTOMIZATIONS_DIR],
      [new RegExp(`${root}${separators}runtime${separators}shared${tail}`, flags), "/platform"],
      [new RegExp(`${root}${after}${tail}`, flags), "/platform"],
    );
  }
  const shortest = Math.min(...[...variants].map((variant) => variant.length));
  const replaceString = (text: string) =>
    text.length < shortest ? text : rules.reduce((out, [pattern, base]) => out.replace(pattern, (_match, rest: string) => `${base}${rest.replace(/[\\/]+/g, "/")}`), text);
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return replaceString(value);
    if (depth > 12 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item, depth + 1);
    return out;
  };
  return (value) => walk(value, 0);
}

/** Per-connection fields are not stored with the session; they are resent by whichever client resumes it. */
export function storedParams(params: Record<string, unknown>): Record<string, unknown> {
  const {
    tools: _tools,
    requestPermission: _requestPermission,
    requestUserInput: _requestUserInput,
    requestElicitation: _requestElicitation,
    requestExitPlanMode: _requestExitPlanMode,
    requestAutoModeSwitch: _requestAutoModeSwitch,
    hooks: _hooks,
    hasSkillProvider: _hasSkillProvider,
    hasMemoryStore: _hasMemoryStore,
    gitHubTokenProviderRegistrationId: _registration,
    traceparent: _traceparent,
    tracestate: _tracestate,
    ...rest
  } = params;
  return rest;
}

/** The caller's configuration as requested (no credentials, no per-connection fields), for admission elsewhere. */
export function requestedParams(raw: Record<string, unknown>): Record<string, unknown> {
  const { gitHubToken: _token, sessionId: _sessionId, ...rest } = structuredClone(raw);
  return storedParams(rest);
}

export function withoutSessionId(params: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, ...rest } = structuredClone(params);
  return rest;
}
