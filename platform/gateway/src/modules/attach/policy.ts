// What an attached Copilot CLI may send over AHP, and how the runtime's frames are filtered before it sees them.
//
// The relay is deny-by-default: reads of the attached session pass through, writes go through core's attachment
// (`CliAttachment.write`, which admits them and checks the fence in the same step as the socket write) or the actions
// ledger (`answer`), and everything else is refused. Facts from stock Copilot CLI 1.0.92 with runtime 1.0.103:
// - A turn is `dispatchAction chat/turnStarted { turnId, startedAt, message: { text, origin: { kind: "user" } } }`.
// - A permission prompt is `chat/toolCallReady` (and `session/inputNeededSet` kind `toolConfirmation`) carrying the
//   runtime's `requestId` in `_meta.requestId`; the CLI answers with `chat/toolCallConfirmed { turnId, toolCallId,
//   approved, ... }`. When an answer reaches the runtime over JSON-RPC, the AHP host emits no `toolCallConfirmed`; the
//   tool call goes straight to `chat/toolCallComplete`.
// - The CLI does not display `rejectionReason`; a rejected confirmation closes its dialog and the tool call is shown
//   as still waiting until the runtime reports the real outcome.
// - The host advertises `terminalCommandPrefix: "!"` and opens a shell for `createTerminal`, offers host slash
//   commands (`/chronicle` reads the runtime's whole session store), and serves changeset and file resources.

/** AHP JSON-RPC error codes (AHP 0.9). */
export const AHP_ERRORS = {
  methodNotFound: -32601,
  invalidParams: -32602,
  permissionDenied: -32009,
} as const;

export const ROOT_CHANNEL = "ahp-root://";
const CHAT_CHANNEL = /^ahp-chat:\/[^/?#\s]+$/;

/** Where the attached session runs: the policy differs only for host commands (`/chronicle` on a shared runtime). */
export type AttachPlacement = "shared" | "sandbox";

export interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function sessionChannel(sessionId: string): string {
  return `ahp-session:/${sessionId}`;
}

/** Client requests that only read the attached session (forwarded, with their results filtered). */
const READ_REQUESTS: ReadonlySet<string> = new Set(["initialize", "reconnect", "ping", "subscribe", "listSessions", "fetchTurns", "completions", "extensions/getPlan", "extensions/getSessionModels"]);

/** Why a request is refused, by what it would have reached. */
function refusalFor(method: string): string {
  if (/^(createSession|disposeSession|createChat|disposeChat|resolveSessionConfig|sessionConfigCompletions)$/.test(method)) {
    return "Copilot CLI attach continues this session only; it can't create or remove sessions or chats.";
  }
  if (/terminal/i.test(method)) return "Shell access isn't available to an attached Copilot CLI.";
  if (/^resource|ResourceWatch|Changeset/i.test(method)) return "File access isn't available to an attached Copilot CLI. Use the session's files API instead.";
  if (/automation/i.test(method)) return "Automations aren't available to an attached Copilot CLI.";
  if (/^extensions\/|^x-/.test(method)) return `${method} isn't available to an attached Copilot CLI.`;
  return `${method} isn't supported over Copilot CLI attach.`;
}

export type RequestVerdict = { readonly kind: "forward"; readonly message: JsonRpcMessage } | { readonly kind: "refuse"; readonly code: number; readonly message: string };

/** Whether a subscription channel belongs to the attached session (the stock host also refuses other sessions' chats). */
export function channelAllowed(channel: unknown, sessionId: string): boolean {
  return channel === ROOT_CHANNEL || channel === sessionChannel(sessionId) || (typeof channel === "string" && CHAT_CHANNEL.test(channel));
}

/** Decides a client request (a message with `method` and `id`). */
export function decideRequest(message: JsonRpcMessage, sessionId: string): RequestVerdict {
  const method = String(message.method);
  if (!READ_REQUESTS.has(method)) return { kind: "refuse", code: AHP_ERRORS.permissionDenied, message: refusalFor(method) };
  const params = isDict(message.params) ? message.params : {};
  if (method === "subscribe" && !channelAllowed(params["channel"], sessionId)) {
    return { kind: "refuse", code: AHP_ERRORS.permissionDenied, message: "Copilot CLI attach shows this session's conversation only." };
  }
  if (method === "reconnect" && Array.isArray(params["subscriptions"])) {
    // Channels outside the session are dropped; the host replays or snapshots the rest.
    const subscriptions = params["subscriptions"].filter((channel) => channelAllowed(channel, sessionId));
    return { kind: "forward", message: { ...message, params: { ...params, subscriptions } } };
  }
  if (method === "initialize" && Array.isArray(params["initialSubscriptions"])) {
    const initialSubscriptions = params["initialSubscriptions"].filter((channel) => channelAllowed(channel, sessionId));
    return { kind: "forward", message: { ...message, params: { ...params, initialSubscriptions } } };
  }
  return { kind: "forward", message };
}

/** A user message the CLI dispatched (`chat/turnStarted`, `chat/pendingMessageSet`). */
interface AhpMessage {
  readonly text?: unknown;
  readonly origin?: { readonly kind?: unknown };
  readonly attachments?: unknown;
  readonly model?: unknown;
  readonly agent?: unknown;
}

const SLASH_COMMAND = /^\s*\/([A-Za-z][\w-]*)(?=\s|$)/;
/** Host slash commands a shared session may run: they act on this session only. */
const SHARED_HOST_COMMANDS: ReadonlySet<string> = new Set(["compact"]);
const SESSION_MODES: ReadonlySet<string> = new Set(["interactive", "plan", "autopilot"]);

export type ActionVerdict =
  | { readonly kind: "refuse"; readonly reason: string }
  /** Forward after the attachment's fence and ownership check (state that starts no work). */
  | { readonly kind: "gated" }
  /** A user message: core admits it and the AHP write runs inside `CliAttachment.write`. */
  | { readonly kind: "turn"; readonly text: string; readonly modelId?: string }
  | { readonly kind: "abort" }
  /** The person's decision on a permission prompt: answered through the actions ledger, never forwarded. */
  | { readonly kind: "confirm"; readonly channel: string; readonly toolCallId: string; readonly approved: boolean; readonly feedback?: string }
  /** The person's answer to a question (`chat/inputCompleted`). */
  | { readonly kind: "input"; readonly channel: string; readonly inputId: string; readonly response: string; readonly answers: Dict };

function messageVerdict(message: unknown, placement: AttachPlacement): ActionVerdict {
  if (!isDict(message)) return { kind: "refuse", reason: "A message needs text." };
  const { text, origin, attachments, model, agent } = message as AhpMessage;
  if (typeof text !== "string" || !text.trim()) return { kind: "refuse", reason: "A message needs text." };
  if (!isDict(origin) || origin["kind"] !== "user") return { kind: "refuse", reason: "Copilot CLI can only send your own messages." };
  if (Array.isArray(attachments) ? attachments.length > 0 : attachments !== undefined && attachments !== null) {
    return { kind: "refuse", reason: "Attachments aren't supported over Copilot CLI attach. Paste the content into your message instead." };
  }
  if (agent !== undefined && agent !== null) return { kind: "refuse", reason: "Choose agents in your application; Copilot CLI attach sends messages only." };
  let modelId: string | undefined;
  if (model !== undefined && model !== null) {
    modelId = isDict(model) ? str(model["id"]) : undefined;
    if (!modelId) return { kind: "refuse", reason: "The message names a model without an id." };
  }
  // The host runs `!command` in a shell (terminalCommandPrefix): no shell is reachable through attach.
  if (text.trimStart().startsWith("!")) return { kind: "refuse", reason: "Shell commands aren't available to an attached Copilot CLI." };
  const command = SLASH_COMMAND.exec(text)?.[1];
  if (command && placement === "shared" && !SHARED_HOST_COMMANDS.has(command.toLowerCase())) {
    // Host commands such as /chronicle read every session on the runtime, which a shared runtime shares with others.
    return { kind: "refuse", reason: `/${command} isn't available in a shared session.` };
  }
  return { kind: "turn", text, ...(modelId ? { modelId } : {}) };
}

/** Decides a `dispatchAction` (fire-and-forget AHP write) from the client. */
export function decideAction(params: unknown, context: { readonly sessionId: string; readonly placement: AttachPlacement; readonly clientId: string | undefined }): ActionVerdict {
  if (!isDict(params) || !isDict(params["action"])) return { kind: "refuse", reason: "Malformed action." };
  const channel = params["channel"];
  const action = params["action"];
  const type = String(action["type"]);
  const onSession = channel === sessionChannel(context.sessionId);
  const onChat = typeof channel === "string" && CHAT_CHANNEL.test(channel);
  if (type.startsWith("chat/") && !onChat) return { kind: "refuse", reason: "Chat actions must target a chat of this session." };
  if ((type.startsWith("session/") || type.startsWith("copilot/")) && !onSession) return { kind: "refuse", reason: "Session actions must target this session." };
  switch (type) {
    case "chat/turnStarted":
      return messageVerdict(action["message"], context.placement);
    case "chat/pendingMessageSet":
      return messageVerdict(action["message"], context.placement);
    case "chat/turnCancelled":
      return { kind: "abort" };
    case "chat/pendingMessageRemoved":
    case "chat/queuedMessagesReordered":
    case "chat/draftChanged":
    case "chat/inputAnswerChanged":
    case "session/titleChanged":
    case "session/isReadChanged":
    case "copilot/viewState":
      return { kind: "gated" };
    case "session/activeClientSet": {
      const client = isDict(action["activeClient"]) ? action["activeClient"] : undefined;
      const tools = client?.["tools"];
      const customizations = client?.["customizations"];
      if (!client || !context.clientId || client["clientId"] !== context.clientId) return { kind: "refuse", reason: "A client can only register itself." };
      // Client-provided tools and plugins would change the session's tools outside admission.
      if ((Array.isArray(tools) && tools.length > 0) || (tools !== undefined && !Array.isArray(tools))) return { kind: "refuse", reason: "Copilot CLI can't add tools to this session." };
      if (Array.isArray(customizations) ? customizations.length > 0 : customizations !== undefined && customizations !== null) {
        return { kind: "refuse", reason: "Copilot CLI can't add plugins or customizations to this session." };
      }
      return { kind: "gated" };
    }
    case "session/activeClientRemoved":
      return context.clientId && action["clientId"] === context.clientId ? { kind: "gated" } : { kind: "refuse", reason: "A client can only remove itself." };
    case "session/configChanged": {
      const config = action["config"];
      if (!isDict(config) || action["replace"] === true) return { kind: "refuse", reason: "Only the session mode can be changed from Copilot CLI." };
      const keys = Object.keys(config);
      // The approval mode stays with the platform: "allow-all" would run tools without the actions ledger.
      if (keys.length !== 1 || keys[0] !== "mode" || !SESSION_MODES.has(String(config["mode"]))) {
        return { kind: "refuse", reason: "Only the session mode can be changed from Copilot CLI; approvals stay as configured." };
      }
      return { kind: "gated" };
    }
    case "chat/toolCallConfirmed": {
      const toolCallId = str(action["toolCallId"]);
      if (!toolCallId || typeof action["approved"] !== "boolean") return { kind: "refuse", reason: "Malformed approval." };
      if (action["editedToolInput"] !== undefined) return { kind: "refuse", reason: "Editing a tool's input isn't supported over Copilot CLI attach." };
      const feedback = action["approved"] ? undefined : textOf(action["reasonMessage"]) ?? textOf(isDict(action["userSuggestion"]) ? action["userSuggestion"]["text"] : undefined);
      return { kind: "confirm", channel: channel as string, toolCallId, approved: action["approved"], ...(feedback ? { feedback } : {}) };
    }
    case "chat/inputCompleted": {
      const inputId = str(action["requestId"]);
      const response = str(action["response"]);
      if (!inputId || !response) return { kind: "refuse", reason: "Malformed answer." };
      return { kind: "input", channel: channel as string, inputId, response, answers: isDict(action["answers"]) ? action["answers"] : {} };
    }
    default:
      // Tool results (only the app runs its tools), history truncation, turn resume, working directories, terminals,
      // customizations, MCP servers, annotations, automations, and host configuration.
      return { kind: "refuse", reason: `${type} isn't available to an attached Copilot CLI.` };
  }
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (isDict(value) && typeof value["markdown"] === "string") return value["markdown"].trim() || undefined;
  return undefined;
}

/** An elicitation result for `session.ui.handlePendingElicitation` from an AHP `chat/inputCompleted`. */
export function elicitationResult(response: string, answers: Dict): Dict {
  if (response !== "accept") return { action: response === "decline" ? "decline" : "cancel" };
  const content: Dict = {};
  for (const [question, answer] of Object.entries(answers)) {
    if (!isDict(answer) || (answer["state"] !== undefined && answer["state"] !== "submitted")) continue;
    const value = answer["value"];
    if (isDict(value) && "value" in value) content[question] = value["value"];
  }
  return { action: "accept", content };
}

/** A prompt the runtime surfaced over AHP, keyed by chat channel and tool call or question ID. */
export interface PromptRecord {
  readonly requestId: string;
}

const MAX_TRACKED = 1_000;

function key(channel: string, id: string): string {
  return `${channel}\u0000${id}`;
}

function remember<T>(map: Map<string, T>, k: string, value: T): void {
  map.delete(k);
  map.set(k, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

/**
 * What the bridge learns from the runtime's frames: the request IDs behind the prompts the CLI was shown (only the
 * server's frames are trusted for these), and the latest `serverSeq` for envelopes the relay synthesizes.
 */
export class AhpObserver {
  lastServerSeq = 0;
  readonly #permissions = new Map<string, PromptRecord>();
  /** Questions (`chat/inputRequested`); `requestId` is set when the host links one to a runtime request. */
  readonly #inputs = new Map<string, { readonly requestId?: string }>();

  permission(channel: string, toolCallId: string): PromptRecord | undefined {
    return this.#permissions.get(key(channel, toolCallId));
  }

  input(channel: string, inputId: string): { readonly requestId?: string } | undefined {
    return this.#inputs.get(key(channel, inputId));
  }

  /** Learns from a runtime frame (notification or response) before it is forwarded. */
  observe(message: JsonRpcMessage): void {
    if (message.method === "action" && isDict(message.params)) {
      const envelope = message.params;
      if (typeof envelope["serverSeq"] === "number") this.lastServerSeq = Math.max(this.lastServerSeq, envelope["serverSeq"]);
      if (typeof envelope["channel"] === "string" && isDict(envelope["action"])) this.#action(envelope["channel"], envelope["action"]);
      return;
    }
    if (isDict(message.result)) {
      const result = message.result;
      if (typeof result["serverSeq"] === "number") this.lastServerSeq = Math.max(this.lastServerSeq, result["serverSeq"]);
      if (Array.isArray(result["actions"])) for (const envelope of result["actions"]) this.observe({ method: "action", params: envelope });
      this.#walk(result, undefined, 0);
    }
  }

  #action(channel: string, action: Dict): void {
    const type = action["type"];
    if (type === "chat/toolCallReady") this.#toolCall(channel, action);
    else if (type === "chat/toolCallComplete") this.#permissions.delete(key(channel, String(action["toolCallId"])));
    else if (type === "chat/inputRequested" && isDict(action["request"])) this.#question(channel, action["request"]);
    else if (type === "chat/inputCompleted") this.#inputs.delete(key(channel, String(action["requestId"])));
    else if (type === "session/inputNeededSet" && isDict(action["request"])) this.#walk(action["request"], undefined, 0);
  }

  #toolCall(channel: string, toolCall: Dict): void {
    const toolCallId = str(toolCall["toolCallId"]);
    const meta = isDict(toolCall["_meta"]) ? toolCall["_meta"] : undefined;
    const requestId = str(meta?.["requestId"]);
    if (toolCallId && requestId && isDict(meta?.["permissionRequest"])) remember(this.#permissions, key(channel, toolCallId), { requestId });
  }

  #question(channel: string, request: Dict): void {
    const id = str(request["id"]);
    if (!id || !Array.isArray(request["questions"])) return;
    const requestId = str(isDict(request["_meta"]) ? request["_meta"]["requestId"] : undefined);
    remember(this.#inputs, key(channel, id), requestId ? { requestId } : {});
  }

  /** Snapshots (`subscribe`, `reconnect`) and `inputNeeded` entries: tool calls and questions waiting for a person. */
  #walk(node: unknown, chat: string | undefined, depth: number): void {
    if (depth > 24) return;
    if (Array.isArray(node)) {
      for (const item of node) this.#walk(item, chat, depth + 1);
      return;
    }
    if (!isDict(node)) return;
    let scope = chat;
    for (const field of ["resource", "chat"]) {
      const value = node[field];
      if (typeof value === "string" && CHAT_CHANNEL.test(value)) scope = value;
    }
    if (scope && typeof node["toolCallId"] === "string") this.#toolCall(scope, node);
    if (scope && Array.isArray(node["questions"]) && typeof node["id"] === "string") this.#question(scope, node);
    for (const value of Object.values(node)) if (typeof value === "object" && value !== null) this.#walk(value, scope, depth + 1);
  }
}

/**
 * Filters a runtime response for the request that asked for it: `initialize` loses the host's shell prefix and its
 * host directory (neither shells nor files are reachable), and a shared session's completions lose host commands it
 * may not run.
 */
export function filterResult(method: string | undefined, result: unknown, placement: AttachPlacement): unknown {
  if (!isDict(result)) return result;
  if (method === "initialize") {
    const { terminalCommandPrefix: _prefix, defaultDirectory: _directory, ...rest } = result;
    return rest;
  }
  if (method === "completions" && placement === "shared" && Array.isArray(result["items"])) {
    const items = result["items"].filter((item) => {
      const command = isDict(item) && typeof item["insertText"] === "string" ? SLASH_COMMAND.exec(item["insertText"])?.[1] : undefined;
      return !command || SHARED_HOST_COMMANDS.has(command.toLowerCase());
    });
    return { ...result, items };
  }
  return result;
}

/**
 * Deep scrubber for platform host paths: core's `pathScrubber` (data directory, its resolved form, and the session
 * workspace), applied to `file:` URIs by their decoded path, which AHP uses for working directories. A URI whose path
 * is rewritten is rebuilt around the sandbox-style path (`file:///workspace`), percent-encoded again.
 */
export function uriAwareScrubber(scrub: (value: unknown) => unknown): (value: unknown) => unknown {
  const FILE_URI = /file:\/\/[^\s"'<>]*/gi;
  const scrubUri = (uri: string): string => {
    let path: string;
    try {
      path = decodeURI(uri.slice("file://".length));
    } catch {
      return uri;
    }
    // `file:///C:/x` names `C:/x`; `file:///home/x` names `/home/x`.
    const local = /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
    const scrubbed = scrub(local) as string;
    if (scrubbed === local) return uri;
    return `file://${scrubbed.startsWith("/") ? "" : "/"}${encodeURI(scrubbed)}`;
  };
  const scrubText = (text: string): string => {
    const out = scrub(/file:/i.test(text) ? text.replace(FILE_URI, scrubUri) : text) as string;
    // A drive path rewritten inside a URI that wasn't percent-encoded (a raw space) leaves `file:///` + `/workspace`.
    return out.includes("file:////") ? out.replace(/file:\/\/\/\/(?=workspace|platform|opt\/managed-copilot)/gi, "file:///") : out;
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return scrubText(value);
    if (depth > 64 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const out: Dict = {};
    for (const [field, item] of Object.entries(value as Dict)) out[field] = walk(item, depth + 1);
    return out;
  };
  return (value) => walk(value, 0);
}
