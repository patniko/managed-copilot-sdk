// One customer's conversation: a session of the help desk's shared environment, created with the store's tools bound to
// that customer. Refunds and cancellations wait in the permission handler until the operator answers on the wall.
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { ApprovalRequest, Ticket, TicketStatus } from "../shared/types.js";
import { HelpDeskError, errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { DeskPlatform, SupportSession } from "./platform.js";
import { Transcript, type Effect, type SessionEventLike } from "./projection.js";
import type { CustomerSeed } from "./seed.js";
import { normalizeOrderId, type Shop } from "./shop.js";
import { APPROVAL_TOOLS, checkRequest, customerTools, systemMessage } from "./tools.js";

export interface TicketHost {
  readonly platform: DeskPlatform;
  readonly shop: Shop;
  /** Something a person would see changed; the host coalesces publishing. */
  changed(ticket: TicketSession): void;
}

/** What the agent is told when the operator declines a request. */
const DECLINED =
  "A support team member declined this request. Tell the customer it needs a closer look and that the team will email them within one business day. Don't try it again unless they ask.";

interface HeldApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (result: PermissionRequestResult) => void;
}

type State = "new" | "starting" | "live" | "detached" | "failed" | "closed";

/** Session IDs carry their simulation and customer, so a restarted Help Desk finds its tickets on the platform. */
export function sessionIdFor(runId: string, customerId: string): string {
  return `hd-${runId}-${customerId}`;
}

export function parseSessionId(sessionId: string): { runId: string; customerId: string } | undefined {
  const match = /^hd-([a-z0-9]+)-(c\d{2})$/.exec(sessionId);
  return match ? { runId: match[1]!, customerId: match[2]! } : undefined;
}

export class TicketSession {
  readonly customer: CustomerSeed;
  readonly sessionId: string;
  readonly #host: TicketHost;
  #state: State = "new";
  #starting: Promise<void> | undefined;
  #created = false;
  #problem: string | undefined;
  #session: SupportSession | undefined;
  #transcript: Transcript;
  #generation = 0;
  readonly #approvals = new Map<string, HeldApproval>();
  #premiumRequests: number | undefined;
  #updatedAt = new Date().toISOString();

  /** `existing`: its session is already on the platform (a simulation picked up after a restart); attach to it. */
  constructor(host: TicketHost, customer: CustomerSeed, sessionId: string, existing = false) {
    this.#host = host;
    this.customer = customer;
    this.sessionId = sessionId;
    this.#transcript = this.#newTranscript();
    if (existing) {
      this.#state = "detached";
      this.#created = true;
    }
  }

  /** Whether its session exists on the platform. */
  get created(): boolean {
    return this.#created;
  }

  get premiumRequests(): number | undefined {
    return this.#premiumRequests;
  }

  get messageCount(): number {
    return this.#transcript.items.filter((item) => item.kind === "message").length;
  }

  /** Refunds and cancellations its history records as done. */
  effects(): Effect[] {
    return this.#transcript.effects();
  }

  #newTranscript(): Transcript {
    const customerId = this.customer.id;
    return new Transcript((args) => {
      const owner = this.#host.shop.ownerOf(args["orderId"]);
      return owner !== undefined && owner !== customerId;
    });
  }

  #handlers(generation: number, onEvent: (event: SessionEvent) => void) {
    return {
      streaming: true,
      tools: customerTools(this.#host.shop, this.customer.id),
      // Only the store's tools: no built-in tools, so its hands are exactly what this app gives it.
      availableTools: ["custom:*"],
      systemMessage: { content: systemMessage(this.customer, this.#host.shop) },
      onEvent,
      onPermissionRequest: (request: PermissionRequest) => this.#onPermission(request, generation),
    };
  }

  /** Creates the session and sends the customer's first message. */
  start(prompt: string): Promise<void> {
    if (this.#state === "new") this.#starting = this.#start(prompt);
    return this.#starting ?? Promise.resolve();
  }

  /** Resolves once a start in progress has finished, successfully or not. */
  settled(): Promise<void> {
    return this.#starting ?? Promise.resolve();
  }

  /** Not started yet, or starting now. */
  get pending(): boolean {
    return this.#state === "new" || this.#state === "starting";
  }

  async #start(prompt: string): Promise<void> {
    const generation = ++this.#generation;
    this.#state = "starting";
    this.#changed();
    try {
      const model = this.#host.platform.model;
      const session = await this.#host.platform.createSession({
        sessionId: this.sessionId,
        ...(model ? { model } : {}),
        ...this.#handlers(generation, (event) => {
          if (generation === this.#generation) this.#onEvent(event);
        }),
      });
      if (generation !== this.#generation) return void (await session.disconnect().catch(() => undefined));
      this.#session = session;
      this.#created = true;
      this.#state = "live";
      this.#changed();
      await session.send({ prompt });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#state = "failed";
      this.#problem = this.#created ? `The customer's message wasn't delivered: ${errorText(error)}` : `Couldn't start the session: ${errorText(error)}`;
      log.warn("A customer's session failed to start", { customer: this.customer.id, error: errorText(error) });
      this.#changed();
    }
  }

  /** Resumes the session on the current client, rebuilding the conversation from its history. */
  async attach(): Promise<"live" | "gone" | "failed"> {
    if (this.#state === "closed") return "gone";
    this.#releaseApprovals();
    const generation = ++this.#generation;
    const transcript = this.#newTranscript();
    const buffered: SessionEvent[] = [];
    let loading = true;
    const onEvent = (event: SessionEvent) => {
      if (generation !== this.#generation) return;
      if (loading) buffered.push(event);
      else this.#onEvent(event);
    };
    let session: SupportSession | undefined;
    try {
      session = await this.#host.platform.resumeSession(this.sessionId, { ...this.#handlers(generation, onEvent), continuePendingWork: true, suppressResumeEvent: true });
      if (generation !== this.#generation) {
        await session.disconnect().catch(() => undefined);
        return "gone";
      }
      const [history, info] = await Promise.all([session.getEvents(), this.#host.platform.sessionInfo(this.sessionId).catch(() => undefined)]);
      if (generation !== this.#generation) {
        await session.disconnect().catch(() => undefined);
        return "gone";
      }
      for (const event of history) transcript.apply(event as SessionEventLike);
      // History has no `session.idle`: a turn the platform reports finished has ended.
      if (transcript.busy && info?.lastTurn && info.lastTurn.status !== "running") transcript.settle();
      for (const event of buffered) transcript.apply(event as SessionEventLike);
      loading = false;
      this.#transcript = transcript;
      this.#session = session;
      this.#created = true;
      this.#state = "live";
      this.#problem = undefined;
      this.#changed();
      void this.#refreshUsage();
      return "live";
    } catch (error) {
      await session?.disconnect().catch(() => undefined);
      if (generation !== this.#generation) return "gone";
      if (isMissingSession(error)) return "gone";
      this.#state = "failed";
      this.#problem = `Couldn't reopen this conversation: ${errorText(error)}`;
      log.warn("Couldn't resume a customer's session", { customer: this.customer.id, error: errorText(error) });
      this.#changed();
      return "failed";
    }
  }

  /** The client its session lived on is gone: it attaches again on the next connection. A start in progress goes on. */
  detach(): void {
    if (this.#state !== "live") return;
    ++this.#generation;
    this.#releaseApprovals();
    this.#session = undefined;
    this.#state = "detached";
  }

  /** Lets go of the session without touching the platform. */
  close(): void {
    ++this.#generation;
    this.#releaseApprovals();
    this.#session = undefined;
    this.#state = "closed";
  }

  /** Sends a message as the customer. */
  async send(text: string): Promise<void> {
    const session = this.#session;
    if (!session || this.#state !== "live") throw new HelpDeskError("unavailable", this.#problem ?? "This conversation isn't connected right now. Try again in a moment.", 503);
    try {
      await session.send({ prompt: text });
    } catch (error) {
      throw new HelpDeskError("send_failed", `The message wasn't delivered: ${errorText(error)}`, 502);
    }
  }

  /** The operator's answer to a refund or cancellation. */
  answer(approvalId: string, approve: boolean): void {
    const held = this.#approvals.get(approvalId);
    if (!held) throw new HelpDeskError("not_actionable", "This request was answered already.", 409);
    this.#approvals.delete(approvalId);
    held.resolve(approve ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback: DECLINED });
    log.info(approve ? "Approved a request" : "Declined a request", { customer: this.customer.id, action: held.request.action, order: held.request.orderId, amount: held.request.amount });
    this.#changed();
  }

  async #onPermission(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    if (request.kind !== "custom-tool" || !APPROVAL_TOOLS.has(request.toolName)) return { kind: "approve-once" };
    if (generation !== this.#generation) return { kind: "no-result" };
    const tool = request.toolName;
    const args = (request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {}) as Record<string, unknown>;
    // A request the store refuses anyway needs no one: the tool runs and tells the agent why.
    const check = checkRequest(this.#host.shop, this.customer.id, tool, args);
    if (!check.ok) return { kind: "approve-once" };
    const id = request.toolCallId ?? `request-${Date.now().toString(36)}`;
    // Delivered again (for example after a reconnection): the newest callback is the one that answers.
    this.#approvals.get(id)?.resolve({ kind: "no-result" });
    return await new Promise<PermissionRequestResult>((resolve) => {
      const approval: ApprovalRequest = {
        id,
        action: tool === "request_refund" ? "refund" : "cancel",
        orderId: normalizeOrderId(args["orderId"]),
        amount: check.amount,
        ...(typeof args["reason"] === "string" && args["reason"].trim() ? { reason: args["reason"].trim() } : {}),
        requestedAt: new Date().toISOString(),
      };
      this.#approvals.set(id, { request: approval, resolve });
      this.#changed();
    });
  }

  /** Lets go of waiting permission callbacks without answering; the platform asks again on resume. */
  #releaseApprovals(): void {
    for (const [id, held] of [...this.#approvals]) {
      this.#approvals.delete(id);
      held.resolve({ kind: "no-result" });
    }
  }

  #onEvent(event: SessionEvent): void {
    const changed = this.#transcript.apply(event as SessionEventLike);
    if (event.type === "permission.completed") {
      // Answered elsewhere, or withdrawn with its turn.
      const id = (event.data as { toolCallId?: string }).toolCallId;
      const held = id ? this.#approvals.get(id) : undefined;
      if (held && id) {
        this.#approvals.delete(id);
        held.resolve({ kind: "no-result" });
      }
    }
    if (event.type === "session.idle" || event.type === "abort") {
      this.#releaseApprovals();
      void this.#refreshUsage();
    }
    if (changed || event.type === "session.idle") this.#changed();
  }

  /** The session's premium requests so far, from the runtime's own usage metrics. */
  async #refreshUsage(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      const metrics = await session.rpc.usage.getMetrics();
      if (session !== this.#session || metrics.totalPremiumRequestCost === this.#premiumRequests) return;
      this.#premiumRequests = metrics.totalPremiumRequestCost;
      this.#changed();
    } catch (error) {
      log.debug("Couldn't read a session's usage", { customer: this.customer.id, error: errorText(error) });
    }
  }

  #changed(): void {
    this.#updatedAt = new Date().toISOString();
    this.#host.changed(this);
  }

  status(): TicketStatus {
    if (this.#state === "failed") return "failed";
    if (this.#approvals.size > 0 || this.#transcript.asking.length > 0) return "approval";
    if (this.#state === "new" || this.#state === "starting" || this.#transcript.items.length === 0) return "starting";
    if (this.#transcript.busy) return "answering";
    return this.#transcript.resolved ? "resolved" : "waiting";
  }

  view(): Ticket {
    const approval = [...this.#approvals.values()][0]?.request;
    const problem = this.#problem ?? this.#transcript.problem;
    return {
      customerId: this.customer.id,
      ...(this.#created ? { sessionId: this.sessionId } : {}),
      status: this.status(),
      items: this.#transcript.items,
      ...(approval ? { approval } : {}),
      blocked: this.#transcript.blocked,
      ...(this.#premiumRequests !== undefined ? { premiumRequests: this.#premiumRequests } : {}),
      ...(problem ? { problem } : {}),
      updatedAt: this.#transcript.updatedAt ?? this.#updatedAt,
    };
  }
}
