// One conversation: a session of the help desk's shared environment, created with tools bound to the one person it
// serves: a store customer of the current simulation (`CustomerTicket`), or a live Downhill player who opened support
// from the game (`PlayerTicketSession`). Refunds and cancellations wait in the permission handler until the operator
// answers on the wall. Facts a customer's agent proposes for the team knowledge base don't: the runtime's memory
// permission (`kind: "memory"`) is granted at once and `memory.storeMemory` keeps the fact as a proposal for a team
// member to decide later, outside the agent's turn. Declining in the turn would reach the customer: the runtime fails
// the other tool calls waiting in the same step and the agent answers the rejection.
import type { PermissionRequest, PermissionRequestResult, SessionEvent, StoredMemory, Tool } from "@github/copilot-sdk";
import type { ApprovalRequest, BugReport, MemoryProposal, PlayerContext, PlayerTicket, Ticket, TicketStatus, TranscriptItem } from "../shared/types.js";
import { HelpDeskError, errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { DeskPlatform, SupportSession } from "./platform.js";
import { PLAYER_APPROVAL_TOOLS, PlayerAccount, playerCard, playerSessionId, playerSystemMessage, playerTools, promptFor, readPrompt, ticketOpenedAt, UNKNOWN_PLAYER } from "./player.js";
import { Transcript, type Effect, type SessionEventLike } from "./projection.js";
import type { CustomerSeed } from "./seed.js";
import { normalizeOrderId, type Shop } from "./shop.js";
import { APPROVAL_TOOLS, checkRequest, customerTools, systemMessage } from "./tools.js";

export interface TicketHost {
  readonly platform: DeskPlatform;
  readonly shop: Shop;
  /** Something a person would see changed; the host coalesces publishing. */
  changed(ticket: TicketSession): void;
  /** The team knowledge section of every customer's session's instructions. */
  knowledgePrompt(): string;
  /** Keeps a memory a customer's agent stored as a proposal for the team. Rejects when it can't be kept. */
  remember(ticket: CustomerTicket, memory: StoredMemory): Promise<void>;
  /** The oldest fact this conversation's agent proposed that no one has decided yet. */
  proposal(ticket: CustomerTicket): MemoryProposal | undefined;
}

/** What the agent is told when the operator declines a customer's request. */
const DECLINED =
  "A support team member declined this request. Tell the customer it needs a closer look and that the team will email them within one business day. Don't try it again unless they ask.";

/** What the agent is told when the operator declines a player's refund. */
const PLAYER_DECLINED = "A support team member declined this refund. Tell the player it needs a closer look and that a team member will follow up with them. Don't try it again unless they ask.";

interface HeldApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (result: PermissionRequestResult) => void;
}

type State = "new" | "starting" | "live" | "detached" | "failed" | "closed";

/** Who a session serves, for logs and problems. */
interface Party {
  /** "customer" or "player". */
  readonly word: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Session IDs carry their simulation and customer, so a restarted Help Desk finds its tickets on the platform. */
export function sessionIdFor(runId: string, customerId: string): string {
  return `hd-${runId}-${customerId}`;
}

export function parseSessionId(sessionId: string): { runId: string; customerId: string } | undefined {
  const match = /^hd-([a-z0-9]+)-(c\d{2})$/.exec(sessionId);
  return match ? { runId: match[1]!, customerId: match[2]! } : undefined;
}

/** A session and its conversation. Subclasses say whose: the tools, the instructions, and what approvals mean. */
export abstract class TicketSession {
  readonly sessionId: string;
  protected readonly host: TicketHost;
  #state: State = "new";
  #starting: Promise<void> | undefined;
  #created = false;
  #problem: string | undefined;
  #session: SupportSession | undefined;
  #transcript: Transcript;
  #generation = 0;
  readonly #approvals = new Map<string, HeldApproval>();
  #premiumRequests: number | undefined;

  /** `existing`: its session is already on the platform (picked up after a restart); attach to it. */
  protected constructor(host: TicketHost, sessionId: string, existing: boolean) {
    this.host = host;
    this.sessionId = sessionId;
    this.#transcript = this.#newTranscript();
    if (existing) {
      this.#state = "detached";
      this.#created = true;
    }
  }

  /** Who the session serves. */
  protected abstract get party(): Party;
  /** The tools its session gets, bound to the person it serves. */
  protected abstract sessionTools(): Tool<any>[];
  /** Added to the platform's instructions. */
  protected abstract instructions(): string;
  /** The tools that wait for the operator. */
  protected abstract get approvalTools(): ReadonlySet<string>;
  /** What a call of an approval tool would do, for the operator; nothing when the tool refuses it anyway. */
  protected abstract approvalFor(tool: string, args: Readonly<Record<string, unknown>>, id: string): ApprovalRequest | undefined;
  /** What the agent is told when the operator declines. */
  protected abstract get declined(): string;

  /** Whether a refused call named an order of another customer (it shows as Blocked). */
  protected othersOrder(_args: Readonly<Record<string, unknown>>): boolean {
    return false;
  }

  /** Called once a resumed session's history has been read. */
  protected restored(): void {}

  /** How its session keeps the memories its agent stores (`store_memory`); none, and its agent can't store any. */
  protected memoryStore(): ((memory: StoredMemory) => Promise<void>) | undefined {
    return undefined;
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

  /** The software problem its agent reported, if any. */
  get bug(): BugReport | undefined {
    return this.#transcript.bug;
  }

  protected get items(): readonly TranscriptItem[] {
    return this.#transcript.items;
  }

  /** A problem a person should see, besides the session's own. */
  protected note(problem: string | undefined): void {
    this.#problem = problem;
  }

  #newTranscript(): Transcript {
    return new Transcript((args) => this.othersOrder(args));
  }

  #handlers(generation: number, onEvent: (event: SessionEvent) => void) {
    const storeMemory = this.memoryStore();
    return {
      streaming: true,
      tools: this.sessionTools(),
      // Only this app's tools, plus the runtime's store_memory for an agent that proposes team knowledge: its hands are
      // exactly what this app gives it.
      availableTools: storeMemory ? ["custom:*", "builtin:store_memory"] : ["custom:*"],
      // Help Desk stores memories itself, as proposals for the team knowledge base.
      ...(storeMemory ? { memory: { enabled: true, storeMemory } } : {}),
      systemMessage: { content: this.instructions() },
      onEvent,
      onPermissionRequest: (request: PermissionRequest) => this.#onPermission(request, generation),
    };
  }

  /** Creates the session and sends the first message. A start that failed before its session existed can be tried again. */
  start(prompt: string): Promise<void> {
    if (this.#state === "new" || (this.#state === "failed" && !this.#created && !this.#session)) this.#starting = this.#start(prompt);
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

  /** Its first message went out, or is going out (a session picked up after a restart has started long ago). */
  get started(): boolean {
    return this.#state !== "new";
  }

  /** Why it failed, while it has. */
  protected get failure(): string | undefined {
    return this.#state === "failed" ? (this.#problem ?? "This conversation failed.") : undefined;
  }

  async #start(prompt: string): Promise<void> {
    const generation = ++this.#generation;
    this.#state = "starting";
    this.#changed();
    try {
      const model = this.host.platform.model;
      const session = await this.host.platform.createSession({
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
      this.#problem = this.#created ? `The ${this.party.word}'s message wasn't delivered: ${errorText(error)}` : `Couldn't start the session: ${errorText(error)}`;
      log.warn(`A ${this.party.word}'s session failed to start`, { ...this.party.fields, error: errorText(error) });
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
      session = await this.host.platform.resumeSession(this.sessionId, { ...this.#handlers(generation, onEvent), continuePendingWork: true, suppressResumeEvent: true });
      if (generation !== this.#generation) {
        await session.disconnect().catch(() => undefined);
        return "gone";
      }
      const [history, info] = await Promise.all([session.getEvents(), this.host.platform.sessionInfo(this.sessionId).catch(() => undefined)]);
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
      this.restored();
      this.#changed();
      void this.#refreshUsage();
      return "live";
    } catch (error) {
      await session?.disconnect().catch(() => undefined);
      if (generation !== this.#generation) return "gone";
      if (isMissingSession(error)) return "gone";
      this.#state = "failed";
      this.#problem = `Couldn't reopen this conversation: ${errorText(error)}`;
      log.warn(`Couldn't resume a ${this.party.word}'s session`, { ...this.party.fields, error: errorText(error) });
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

  /** Sends a message as the person the session serves. After a first message that wasn't delivered, it tries again. */
  async send(text: string): Promise<void> {
    const session = this.#session;
    if (!session || (this.#state !== "live" && this.#state !== "failed")) throw new HelpDeskError("unavailable", this.#problem ?? "This conversation isn't connected right now. Try again in a moment.", 503);
    try {
      await session.send({ prompt: text });
    } catch (error) {
      throw new HelpDeskError("send_failed", `The message wasn't delivered: ${errorText(error)}`, 502);
    }
    if (this.#state === "failed" && this.#session === session) {
      this.#state = "live";
      this.#problem = undefined;
      this.#changed();
    }
  }

  /** The operator's answer to a refund or a cancellation. */
  answer(approvalId: string, approve: boolean): void {
    const held = this.#approvals.get(approvalId);
    if (!held) throw new HelpDeskError("not_actionable", "This request was answered already.", 409);
    this.#approvals.delete(approvalId);
    held.resolve(approve ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject", feedback: this.declined });
    log.info(approve ? "Approved a request" : "Declined a request", { ...this.party.fields, action: held.request.action, order: held.request.orderId, amount: held.request.amount });
    this.#changed();
  }

  async #onPermission(request: PermissionRequest, generation: number): Promise<PermissionRequestResult> {
    // The team decides on a proposed fact later, in the knowledge base: the agent's turn never waits for it or hears it.
    if (request.kind === "memory") return { kind: "approve-once" };
    if (request.kind !== "custom-tool" || !this.approvalTools.has(request.toolName)) return { kind: "approve-once" };
    if (generation !== this.#generation) return { kind: "no-result" };
    const args = (request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {}) as Record<string, unknown>;
    const id = request.toolCallId ?? `request-${Date.now().toString(36)}`;
    // A request that would be refused anyway needs no one: the tool runs and tells the agent why.
    const approval = this.approvalFor(request.toolName, args, id);
    if (!approval) return { kind: "approve-once" };
    // Delivered again (for example after a reconnection): the newest callback is the one that answers.
    this.#approvals.get(id)?.resolve({ kind: "no-result" });
    return await new Promise<PermissionRequestResult>((resolve) => {
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
      log.debug("Couldn't read a session's usage", { ...this.party.fields, error: errorText(error) });
    }
  }

  #changed(): void {
    this.host.changed(this);
  }

  status(): TicketStatus {
    if (this.#state === "failed") return "failed";
    if (this.#approvals.size > 0 || this.#transcript.asking.length > 0) return "approval";
    if (this.#state === "new" || this.#state === "starting" || this.#transcript.items.length === 0) return "starting";
    if (this.#transcript.busy) return "answering";
    return this.#transcript.resolved ? "resolved" : "waiting";
  }

  /** What every ticket shows: its session, status, conversation, and anything waiting for the operator. */
  protected conversation() {
    const approval = [...this.#approvals.values()][0]?.request;
    const problem = this.#problem ?? this.#transcript.problem;
    const bug = this.#transcript.bug;
    return {
      ...(this.#created ? { sessionId: this.sessionId } : {}),
      status: this.status(),
      items: this.#transcript.items,
      ...(approval ? { approval } : {}),
      ...(bug ? { bug } : {}),
      ...(this.#premiumRequests !== undefined ? { premiumRequests: this.#premiumRequests } : {}),
      ...(problem ? { problem } : {}),
    };
  }
}

/** A store customer of the current simulation, with the store's tools bound to their orders. */
export class CustomerTicket extends TicketSession {
  readonly customer: CustomerSeed;

  /** `existing`: its session is already on the platform (a simulation picked up after a restart); attach to it. */
  constructor(host: TicketHost, customer: CustomerSeed, sessionId: string, existing = false) {
    super(host, sessionId, existing);
    this.customer = customer;
  }

  protected override get party(): Party {
    return { word: "customer", fields: { customer: this.customer.id } };
  }

  protected override sessionTools(): Tool<any>[] {
    return customerTools(this.host.shop, this.customer.id);
  }

  protected override instructions(): string {
    return `${systemMessage(this.customer, this.host.shop)}\n\n${this.host.knowledgePrompt()}`;
  }

  /** Its agent proposes facts for the team knowledge base; Help Desk keeps them for a team member to decide. */
  protected override memoryStore(): (memory: StoredMemory) => Promise<void> {
    return (memory) => this.host.remember(this, memory);
  }

  protected override get approvalTools(): ReadonlySet<string> {
    return APPROVAL_TOOLS;
  }

  protected override get declined(): string {
    return DECLINED;
  }

  protected override othersOrder(args: Readonly<Record<string, unknown>>): boolean {
    const owner = this.host.shop.ownerOf(args["orderId"]);
    return owner !== undefined && owner !== this.customer.id;
  }

  protected override approvalFor(tool: string, args: Readonly<Record<string, unknown>>, id: string): ApprovalRequest | undefined {
    // A request the store refuses anyway needs no one.
    const check = checkRequest(this.host.shop, this.customer.id, tool, args);
    if (!check.ok) return undefined;
    return {
      id,
      action: tool === "request_refund" ? "refund" : "cancel",
      orderId: normalizeOrderId(args["orderId"]),
      amount: check.amount,
      ...(typeof args["reason"] === "string" && args["reason"].trim() ? { reason: args["reason"].trim() } : {}),
    };
  }

  view(): Ticket {
    const { items, ...rest } = this.conversation();
    const memory = this.created ? this.host.proposal(this) : undefined;
    return { customerId: this.customer.id, ...rest, items, ...(memory ? { memory } : {}), blocked: items.filter((item) => item.kind === "tool" && item.blocked).length };
  }
}

/** A player's message that carried a checkout shows it as an attachment. */
const CHECKOUT_ATTACHMENT = "Checkout details";

/**
 * A live player of Downhill who opened support from the game. The ticket opens without a session: the player's first
 * message starts it. Their context (who they are, what they last tried at checkout) travels hidden with their first
 * message, and again with the next message whenever the game sent a newer one, so a ticket picked up after a restart
 * reads it back from the conversation. Its tools reach only that player's checkout and order.
 */
export class PlayerTicketSession extends TicketSession {
  readonly ticketId: string;
  readonly openedAt: Date;
  readonly account: PlayerAccount;
  /** When the game last opened it (Date.now()): a ticket that never got a message is dropped after a while. */
  lastOpenedAt = Date.now();
  /** Its session is being deleted. */
  ending = false;
  /** The context the session got last, as JSON: a message carries the context again only when it changed. */
  #delivered: string | undefined;
  /** The player's messages, one at a time and in order. */
  #queue: Promise<void> = Promise.resolve();

  /** `context`: a new ticket's, from the game. Without it, the ticket is one picked up from the platform after a restart. */
  constructor(host: TicketHost, ticketId: string, context?: PlayerContext) {
    super(host, playerSessionId(ticketId), context === undefined);
    this.ticketId = ticketId;
    this.openedAt = ticketOpenedAt(ticketId) ?? new Date();
    this.account = new PlayerAccount(context);
  }

  /** Who the player is and what they last tried at checkout, as the game sent it. */
  get context(): PlayerContext | undefined {
    return this.account.context;
  }

  /** The player's name, once known. */
  get name(): string {
    return this.account.context?.player.name ?? UNKNOWN_PLAYER.name;
  }

  /** The game opened this ticket again: its latest context, which `get_checkout` returns from now on. */
  reopen(context: PlayerContext): void {
    this.account.update(context);
    this.lastOpenedAt = Date.now();
    this.host.changed(this);
  }

  /** Sends the player's message: the first creates the session. It carries their context when that changed. */
  override send(text: string): Promise<void> {
    const sent = this.#queue.then(() => this.#deliver(text));
    this.#queue = sent.catch(() => undefined);
    return sent;
  }

  async #deliver(text: string): Promise<void> {
    const context = this.account.context;
    const key = context ? JSON.stringify(context) : undefined;
    const prompt = promptFor(text, key !== this.#delivered ? context : undefined);
    if (this.created) {
      await super.send(prompt);
    } else {
      // The ticket's first message: its session starts with it.
      this.lastOpenedAt = Date.now();
      await this.start(prompt);
      const failure = this.failure;
      if (failure) throw new HelpDeskError("send_failed", failure, 502);
    }
    this.#delivered = key;
  }

  override status(): TicketStatus {
    return this.started ? super.status() : "opened";
  }

  protected override get party(): Party {
    return { word: "player", fields: { player: this.ticketId } };
  }

  protected override sessionTools(): Tool<any>[] {
    return playerTools(this.account);
  }

  protected override instructions(): string {
    return playerSystemMessage();
  }

  protected override get approvalTools(): ReadonlySet<string> {
    return PLAYER_APPROVAL_TOOLS;
  }

  protected override get declined(): string {
    return PLAYER_DECLINED;
  }

  protected override approvalFor(tool: string, args: Readonly<Record<string, unknown>>, id: string): ApprovalRequest | undefined {
    if (tool !== "request_refund") return undefined;
    // A refund the player's order can't take needs no one: the tool runs and tells the agent why.
    const order = this.account.order;
    const check = this.account.checkRefund(args["orderId"], args["amount"]);
    if (!order || !check.ok) return undefined;
    return {
      id,
      action: "refund",
      orderId: order.id,
      amount: check.amount,
      ...(typeof args["reason"] === "string" && args["reason"].trim() ? { reason: args["reason"].trim() } : {}),
    };
  }

  protected override restored(): void {
    // The latest context the conversation carried; a newer one sent since (not restarted) stays.
    let latest: PlayerContext | undefined;
    for (const item of this.items) {
      if (item.kind !== "message" || item.from !== "customer") continue;
      const { context } = readPrompt(item.text);
      if (context) latest = context;
    }
    if (latest) {
      this.account.know(latest);
      this.#delivered ??= JSON.stringify(latest);
    }
    // Refunds the conversation records as done, each applied once.
    for (const effect of this.effects()) if (effect.tool === "request_refund") this.account.refund(effect.args["orderId"], effect.args["amount"], effect.id);
    if (!this.account.context) this.note("Couldn't read this player's details from their conversation.");
  }

  view(): PlayerTicket {
    const context = this.account.context;
    const { items, ...rest } = this.conversation();
    return {
      ticketId: this.ticketId,
      product: "downhill",
      player: context ? playerCard(context.player) : UNKNOWN_PLAYER,
      ...(context?.opener ? { opener: context.opener } : {}),
      ...(context?.checkout ? { checkout: context.checkout } : {}),
      ...(context ? { gameVersion: context.gameVersion, ...(context.userAgent ? { userAgent: context.userAgent } : {}) } : {}),
      createdAt: this.openedAt.toISOString(),
      ...rest,
      // The player's words only: the context their messages carried is never shown, only noted as an attachment.
      items: items.map((item) => {
        if (item.kind !== "message" || item.from !== "customer") return item;
        const prompt = readPrompt(item.text);
        if (prompt.text === item.text) return item;
        return { ...item, text: prompt.text, ...(prompt.context?.checkout ? { attachment: CHECKOUT_ATTACHMENT } : {}) };
      }),
      ...(this.account.refunded > 0 ? { refunded: this.account.refunded } : {}),
      ...(this.ending ? { ending: true } : {}),
    };
  }
}
