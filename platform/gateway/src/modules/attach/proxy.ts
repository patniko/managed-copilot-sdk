import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { ATTACH_CLOSE_CODES, ManagedCopilotError, filterAhpClientFrame } from "@managed-copilot/protocol";
import { WebSocket, type RawData } from "ws";
import type { Logger } from "../../log.js";
import { ANSWER_METHODS } from "../durable/contract.js";
import type { AhpHost, AttachedBridge } from "./hosts.js";
import { AHP_ERRORS, AhpObserver, decideAction, decideRequest, elicitationResult, filterResult, isDict, type AttachPlacement, type Dict, type JsonRpcMessage } from "./policy.js";
import type { AttachActions, CliAttachment } from "./types.js";

/** `ws` treats its transport as a net.Socket; tunnels from the sandbox relay are plain duplex streams. */
function asSocket(stream: Duplex): Socket {
  const socket = stream as Duplex & Partial<Socket>;
  socket.setNoDelay ??= () => socket as Socket;
  socket.setTimeout ??= () => socket as Socket;
  socket.setKeepAlive ??= () => socket as Socket;
  socket.ref ??= () => socket as Socket;
  socket.unref ??= () => socket as Socket;
  return socket as Socket;
}

/** Opens a WebSocket to the host's loopback listener through the runtime's own network namespace. */
export async function openUpstream(host: AhpHost, protocols: readonly string[]): Promise<WebSocket> {
  const stream = asSocket(await host.runtime.connect(host.port));
  const url = new URL(`ws://127.0.0.1:${host.port}/`);
  url.searchParams.set("tkn", host.token);
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(url, [...protocols], {
      createConnection: () => stream,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return new Promise<WebSocket>((resolve, reject) => {
    const fail = (error: Error) => {
      upstream.terminate();
      stream.destroy();
      reject(error);
    };
    upstream.once("open", () => {
      upstream.off("error", fail);
      resolve(upstream);
    });
    upstream.once("error", fail);
    upstream.once("unexpected-response", (_request, response) => fail(new Error(`The session's AHP listener refused the connection (HTTP ${response.statusCode})`)));
  });
}

function isNormalClose(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

/**
 * How long a client outlives an abnormal drop of its listener connection. A runtime that stops or a session that moves
 * drops the listener connection moments before its lifecycle event, whose release then closes the client with 4410 or
 * 4307 and a reason; only a drop with no such event ends the client with 1011.
 */
export const LISTENER_LOSS_GRACE_MS = 500;

/**
 * How long a CLI answer waits for the actions ledger to record the request it answers: the runtime reports a prompt to
 * the gateway on its JSON-RPC connection and to the CLI on the AHP listener, so the CLI may see it first.
 */
export const LEDGER_WAIT_MS = 5_000;

const MAX_PENDING_REQUESTS = 1_000;

export interface BridgeOptions {
  readonly log: Logger;
  readonly sessionId: string;
  readonly maxLifetimeMs: number;
  /** How long an answer waits for the ledger to record its request (default `LEDGER_WAIT_MS`). */
  readonly ledgerWaitMs?: number;
  /** Where the session ran when the CLI attached (a move ends the attachment). */
  readonly placement: AttachPlacement;
  /** Core's handle for this CLI: admitted, fenced writes and ledger answers. */
  readonly attachment: CliAttachment;
  /** The actions ledger. Without it, approvals and answers are refused. */
  readonly actions: AttachActions | undefined;
  /** For writes that start no work: throws while the session is fenced, moved, or replaced. */
  readonly gate: () => void;
  /** Rewrites platform host paths in what the runtime sends (core's path scrubber). */
  readonly scrub: (value: unknown) => unknown;
}

function reasonOf(error: unknown): string {
  if (error instanceof ManagedCopilotError) return error.message;
  return "Managed Copilot couldn't apply this from Copilot CLI.";
}

function idKey(id: unknown): string {
  return JSON.stringify(id);
}

/** Who holds a prompt the CLI tried to answer, in the person's terms. */
function heldBy(claimedBy: string | undefined): string {
  const type = claimedBy?.split(":")[0];
  if (type === "live") return "Your application is answering this request.";
  if (type === "webhook") return "A webhook worker is answering this request.";
  if (type === "poll") return "Another responder is answering this request.";
  if (type === "cli") return "Another attached Copilot CLI is answering this request.";
  if (type === "platform") return "Managed Copilot is answering this request.";
  return "Another responder is answering this request.";
}

/**
 * Mediates one attached Copilot CLI and its session's AHP listener. Reads of the session pass through; turns,
 * steering, and cancels are admitted by core and written in the same step as its ownership and fence checks; approvals
 * and answers go through the actions ledger by the runtime's request ID (learned from the runtime's frames, never from
 * the client); everything else is refused. What the runtime sends is filtered and scrubbed of platform host paths.
 */
export class AhpBridge implements AttachedBridge {
  readonly ended: Promise<void>;
  readonly #client: WebSocket;
  readonly #upstream: WebSocket;
  readonly #options: BridgeOptions;
  readonly #observer = new AhpObserver();
  /** The client's requests in flight upstream, by ID, so their results can be filtered. */
  readonly #pending = new Map<string, string>();
  #clientId: string | undefined;
  #stopped = false;
  #lifetime: NodeJS.Timeout | undefined;
  #lossTimer: NodeJS.Timeout | undefined;

  constructor(client: WebSocket, upstream: WebSocket, options: BridgeOptions) {
    this.#client = client;
    this.#upstream = upstream;
    this.#options = options;
    this.ended = new Promise<void>((resolve) => client.once("close", () => resolve()));
    const { log, sessionId } = options;
    this.#lifetime = setTimeout(() => this.close(ATTACH_CLOSE_CODES.expired, "Attachment expired. Attach again to continue."), options.maxLifetimeMs);
    this.#lifetime.unref();

    client.on("message", (data: RawData, isBinary: boolean) => this.#onClientFrame(data, isBinary));
    upstream.on("message", (data: RawData, isBinary: boolean) => this.#onUpstreamFrame(data, isBinary));
    client.on("close", () => this.#stop());
    upstream.on("close", (code: number, reason: Buffer) => {
      clearTimeout(this.#lifetime);
      // Stopped by the gateway (fence, release, client gone): the client already has its close code.
      if (this.#stopped) return;
      const text = reason.toString();
      if (!isNormalClose(code)) return this.#listenerLost(text || "The session's runtime connection failed.");
      if (client.readyState === WebSocket.OPEN) client.close(code, text.slice(0, 120));
    });
    client.on("error", (error: Error) => log.debug("Attached client socket error", { sessionId, error: error.message }));
    upstream.on("error", (error: Error) => {
      if (this.#stopped) return;
      log.warn("Session AHP listener connection failed", { sessionId, error: error.message });
      this.#listenerLost("The session's runtime connection failed.");
    });
  }

  close(code: number, reason: string): void {
    this.#stop();
    if (this.#client.readyState === WebSocket.OPEN || this.#client.readyState === WebSocket.CONNECTING) this.#client.close(code, reason.slice(0, 120));
  }

  /** Nothing more is relayed in either direction; the CLI stops being a responder for the session. */
  #stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#lifetime);
    clearTimeout(this.#lossTimer);
    this.#upstream.terminate();
    this.#options.attachment.close();
  }

  #listenerLost(reason: string): void {
    if (this.#lossTimer) return;
    this.#lossTimer = setTimeout(() => {
      if (this.#client.readyState === WebSocket.OPEN) this.#client.close(1011, reason.slice(0, 120));
    }, LISTENER_LOSS_GRACE_MS);
    this.#lossTimer.unref();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Client → runtime

  #onClientFrame(data: RawData, isBinary: boolean): void {
    if (this.#stopped) return;
    if (isBinary) {
      this.close(1003, "Copilot CLI attach carries JSON text frames only.");
      return;
    }
    // Credentials first: the CLI's GitHub token never reaches a runtime, whatever else the frame holds.
    const filtered = filterAhpClientFrame(data.toString());
    if (filtered.invalid) {
      this.close(1007, "Copilot CLI attach carries JSON-RPC messages only.");
      return;
    }
    if (filtered.refused.length > 0) this.#options.log.info("Refused credential-bearing messages from an attached client", { sessionId: this.#options.sessionId, methods: filtered.refused });
    for (const reply of filtered.replies) this.#toClientText(reply);
    if (filtered.forward === undefined) return;
    const parsed = JSON.parse(filtered.forward) as unknown;
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) this.#fromClient(message);
  }

  #fromClient(message: unknown): void {
    if (!isDict(message) || typeof message["method"] !== "string") return; // responses: no runtime request reaches the client
    const hasId = message["id"] !== undefined && message["id"] !== null;
    if (hasId) return this.#onRequest(message);
    if (message["method"] === "dispatchAction") return this.#onDispatch(isDict(message["params"]) ? message["params"] : {});
    if (message["method"] === "unsubscribe") return this.#sendUpstream(message);
    this.#options.log.debug("Dropped a notification from an attached client", { sessionId: this.#options.sessionId, method: message["method"] });
  }

  #onRequest(message: Dict): void {
    const method = String(message["method"]);
    const verdict = decideRequest(message, this.#options.sessionId);
    if (verdict.kind === "refuse") {
      this.#options.log.info("Refused a request from an attached Copilot CLI", { sessionId: this.#options.sessionId, method });
      this.#toClient({ jsonrpc: "2.0", id: message["id"], error: { code: verdict.code, message: verdict.message } });
      return;
    }
    if (method === "initialize" || method === "reconnect") {
      const clientId = isDict(message["params"]) ? message["params"]["clientId"] : undefined;
      if (typeof clientId === "string" && clientId) this.#clientId = clientId;
    }
    this.#pending.set(idKey(message["id"]), method);
    if (this.#pending.size > MAX_PENDING_REQUESTS) this.#pending.delete(this.#pending.keys().next().value!);
    this.#sendUpstream(verdict.message);
  }

  #onDispatch(params: Dict): void {
    const { attachment, placement, sessionId } = this.#options;
    const verdict = decideAction(params, { sessionId, placement, clientId: this.#clientId });
    switch (verdict.kind) {
      case "refuse":
        return this.#reject(params, verdict.reason);
      case "gated":
        return this.#write(params, verdict.action, (send) => {
          this.#options.gate();
          send();
        });
      case "turn":
        return this.#write(params, verdict.action, (send) => {
          // A model on the message is checked against the environment (and recorded for restores) before the turn.
          if (verdict.modelId) attachment.write({ kind: "model", modelId: verdict.modelId }, () => undefined);
          attachment.write({ kind: "turn", text: verdict.text }, send);
        });
      case "abort":
        return this.#write(params, verdict.action, (send) => attachment.write({ kind: "abort" }, send));
      case "confirm":
        void this.#confirm(params, verdict);
        return;
      case "input":
        void this.#input(params, verdict);
        return;
    }
  }

  /**
   * Runs `run`, whose `send` writes `action` (rebuilt by the policy, never the client's own) upstream on the client's
   * channel and sequence number; refusals become an AHP rejection.
   */
  #write(params: Dict, action: Dict, run: (send: () => void) => void): void {
    if (this.#stopped) return;
    let sent = false;
    try {
      run(() => {
        if (this.#stopped || this.#upstream.readyState !== WebSocket.OPEN) throw new ManagedCopilotError("conflict", "This Copilot CLI attachment ended. Attach again.");
        this.#upstream.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel: params["channel"], clientSeq: params["clientSeq"], action } }));
        sent = true;
      });
    } catch (error) {
      if (!sent) this.#reject(params, reasonOf(error));
    }
  }

  /** A person's decision on a permission prompt: through the actions ledger only, never the client's own frame. */
  async #confirm(params: Dict, verdict: { readonly channel: string; readonly toolCallId: string; readonly approved: boolean; readonly feedback?: string }): Promise<void> {
    const prompt = this.#observer.permission(verdict.channel, verdict.toolCallId);
    if (!prompt) return this.#reject(params, "This approval isn't available to Copilot CLI.");
    const result = verdict.approved ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", ...(verdict.feedback ? { feedback: verdict.feedback } : {}) };
    try {
      await this.#claimable("permission", prompt.requestId);
      await this.#options.attachment.answer(ANSWER_METHODS.permission, { requestId: prompt.requestId, result });
      this.#echo(params);
    } catch (error) {
      this.#reject(params, reasonOf(error));
    }
  }

  /** A person's answer to a question: an elicitation through the ledger, or an ask_user answer through core's gate. */
  async #input(params: Dict, verdict: { readonly channel: string; readonly inputId: string; readonly response: string; readonly answers: Dict; readonly action: Dict }): Promise<void> {
    const question = this.#observer.input(verdict.channel, verdict.inputId);
    if (!question) return this.#reject(params, "This question isn't available to Copilot CLI.");
    try {
      if (question.requestId) {
        await this.#claimable("elicitation", question.requestId);
        await this.#options.attachment.answer(ANSWER_METHODS.elicitation, { requestId: question.requestId, result: elicitationResult(verdict.response, verdict.answers) });
        this.#echo(params);
        return;
      }
      // Not linked to a runtime request: an ask_user question (user input is not a ledger action), unless the ledger
      // holds an elicitation this could be, which then must be answered where it can be matched.
      const actions = this.#options.actions;
      if (!actions) throw new ManagedCopilotError("capability_unavailable", "This deployment can't take answers from Copilot CLI.");
      if (actions.list(this.#options.sessionId, { open: true }).some((action) => action.kind === "elicitation")) {
        throw new ManagedCopilotError("conflict", "Answer this question in your application.");
      }
      this.#write(params, verdict.action, (send) => this.#options.attachment.write({ kind: "userInput" }, send));
    } catch (error) {
      this.#reject(params, reasonOf(error));
    }
  }

  /**
   * Resolves when this CLI may answer the request: the ledger recorded it and this connection holds or just took its
   * claim (durable's `promptVisibility`), or, before that hook exists, the ledger lists it as open. Anything the
   * ledger can't account for is refused.
   */
  async #claimable(kind: "permission" | "elicitation", requestId: string): Promise<void> {
    const { actions, attachment, sessionId } = this.#options;
    if (!actions) throw new ManagedCopilotError("capability_unavailable", "This deployment can't record answers from Copilot CLI.");
    if (actions.promptVisibility) {
      const visibility = await actions.promptVisibility({
        sessionId,
        incarnation: attachment.incarnation,
        generation: attachment.generation,
        responder: { connectionId: attachment.connectionId, kind: "cli", tools: [], requestPermission: true, requestElicitation: true },
        kind,
        requestId,
        waitMs: this.#options.ledgerWaitMs ?? LEDGER_WAIT_MS,
      });
      if (visibility.status === "actionable") return;
      if (visibility.status === "observe") throw new ManagedCopilotError("conflict", heldBy(visibility.claimedBy));
      throw new ManagedCopilotError("conflict", visibility.reason || "This request was already answered.");
    }
    const deadline = Date.now() + (this.#options.ledgerWaitMs ?? LEDGER_WAIT_MS);
    for (;;) {
      if (actions.list(sessionId, { open: true }).some((action) => action.requestId === requestId && action.kind === kind)) return;
      if (this.#stopped || Date.now() >= deadline) throw new ManagedCopilotError("conflict", "Managed Copilot has no open record of this request, so Copilot CLI can't answer it.");
      await sleep(100);
    }
  }

  /** Confirms the client's own action (its optimistic copy) after the gateway applied it another way. */
  #echo(params: Dict): void {
    if (this.#stopped || !this.#clientId || typeof params["clientSeq"] !== "number") return;
    this.#toClient({
      jsonrpc: "2.0",
      method: "action",
      params: { channel: params["channel"], action: params["action"], serverSeq: this.#observer.lastServerSeq, origin: { clientId: this.#clientId, clientSeq: params["clientSeq"] } },
    });
  }

  /** Rejects the client's action so it reverts its optimistic copy (stock CLI 1.0.92 does not show the reason). */
  #reject(params: Dict, reason: string): void {
    const type = isDict(params["action"]) ? params["action"]["type"] : undefined;
    this.#options.log.info("Refused an action from an attached Copilot CLI", { sessionId: this.#options.sessionId, type, reason });
    if (this.#stopped || !this.#clientId || typeof params["clientSeq"] !== "number" || !isDict(params["action"])) return;
    this.#toClient({
      jsonrpc: "2.0",
      method: "action",
      params: {
        channel: params["channel"],
        action: params["action"],
        serverSeq: this.#observer.lastServerSeq,
        origin: { clientId: this.#clientId, clientSeq: params["clientSeq"] },
        rejectionReason: reason,
      },
    });
  }

  #sendUpstream(message: JsonRpcMessage | Dict): void {
    if (!this.#stopped && this.#upstream.readyState === WebSocket.OPEN) this.#upstream.send(JSON.stringify(message));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Runtime → client

  #onUpstreamFrame(data: RawData, isBinary: boolean): void {
    if (this.#stopped || isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.#options.log.debug("Dropped a non-JSON frame from the session's AHP listener", { sessionId: this.#options.sessionId });
      return;
    }
    if (Array.isArray(parsed)) {
      const kept = parsed.map((message) => this.#fromRuntime(message)).filter((message) => message !== undefined);
      if (kept.length > 0) this.#toClient(kept);
      return;
    }
    const message = this.#fromRuntime(parsed);
    if (message !== undefined) this.#toClient(message);
  }

  #fromRuntime(message: unknown): unknown {
    if (!isDict(message)) return undefined;
    const method = typeof message["method"] === "string" ? message["method"] : undefined;
    const hasId = message["id"] !== undefined && message["id"] !== null;
    if (method && hasId) {
      // The host asking the client for its files or resource watches: the attached person's machine is not exposed.
      this.#sendUpstream({ jsonrpc: "2.0", id: message["id"], error: { code: AHP_ERRORS.methodNotFound, message: "Managed Copilot doesn't expose the attached client's files." } });
      return undefined;
    }
    // Host telemetry stays on the platform.
    if (method?.startsWith("otlp/")) return undefined;
    this.#observer.observe(message);
    let out: Dict = message;
    if (!method && hasId) {
      const key = idKey(message["id"]);
      const requested = this.#pending.get(key);
      this.#pending.delete(key);
      if ("result" in message) out = { ...message, result: filterResult(requested, message["result"], this.#options.placement) };
    }
    return this.#options.scrub(out);
  }

  #toClient(message: unknown): void {
    this.#toClientText(JSON.stringify(message));
  }

  #toClientText(text: string): void {
    if (this.#client.readyState === WebSocket.OPEN) this.#client.send(text);
  }
}
