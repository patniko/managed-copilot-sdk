// The help desk: the current simulation's tickets (one session per customer on the shared runtime), live players'
// tickets from the Downhill Shop (independent of simulations), and the counters the wall shows. Session IDs name what
// they belong to (`hd-<simulation>-<customer>`, `hd-player-<ticket>`), so after a restart Help Desk adopts the latest
// simulation and every player ticket from the platform, rebuilds each conversation from its history, and deletes older
// simulations' leftovers. Problems with the store's checkout code that the agents report are grouped into software
// issues, which the operator sends to Software Factory; each work order's origin carries the issue's scope and area, so
// a restart finds them again. Facts the customers' agents propose wait in the team knowledge base until the operator
// adds or declines them, outside the agents' turns; added facts outlive simulations and are part of every later
// customer session's instructions. A team member can also write to a ticket's agent (a team note): when it tells the
// agent about an ongoing problem, the agent proposes a known issue, which a team member records for the whole desk;
// Answer matching tickets then has the decision model pick the open tickets about it and sends each one's agent the
// update to reply with.
import type { StoredMemory } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import {
  BUG_AREAS,
  CLASSIFICATION_METHODS,
  SIMULATION_SIZES,
  type BugArea,
  type ClassificationMethod,
  type ClassificationRun,
  type ClassificationRuns,
  type Counters,
  type DeskInfo,
  type HelpDeskState,
  type KnowledgeEntry,
  type KnownIssue,
  type KnownIssueAnswer,
  type KnownIssueTicket,
  type MemoryProposal,
  type PlayerTicket,
  type PlayerTicketCreated,
  type RoutedWorkOrder,
  type RunInfo,
  type ServerEvent,
  type ShopCheckout,
  type SoftwareIssue,
  type Ticket,
  type TicketKnownIssue,
  type TicketTriage,
  type WorkOrderStatus,
} from "../shared/types.js";
import type { HelpDeskConfig } from "./config.js";
import { HelpDeskError, errorText, isMissingSession } from "./errors.js";
import { FACTORY_NOT_CONNECTED, readProject, SoftwareFactory, workOrderName, workOrderUrl, type FactoryClient, type WorkOrderSummary } from "./factory.js";
import { KnowledgeBase } from "./knowledge.js";
import { KnownIssues, MATCH, matchQuestions, updateNote } from "./known-issues.js";
import { defuseTeamNotes, HELP_DESK_AUTHOR } from "./notes.js";
import { groupIssues, isBugArea, issueKey, issueWorkOrder, parseIssueKey, playerScope, type Reported, type ReportedConversation } from "./issues.js";
import { log } from "./log.js";
import type { DeskPlatform } from "./platform.js";
import { chatPath, contextOf, newTicketId, parsePlayerSessionId, parsePlayerTicket, PLAYER_TOOLS, sameOpening } from "./player.js";
import { CUSTOMERS } from "./seed.js";
import { Shop, type ToolResult } from "./shop.js";
import { CustomerTicket, parseSessionId, PlayerTicketSession, sessionIdFor, type TicketHost, type TicketSession } from "./ticket.js";
import { TOOLS, type KnownIssueReport } from "./tools.js";
import { Triage } from "./triage.js";

const PUBLISH_MS = 150;
const COUNTERS_MS = 300;
const MAX_MESSAGE = 2_000;
/** What classification reads of a conversation: the customer's messages, the latest last, up to this many characters. */
const MAX_TRIAGE_TEXT = 4_000;
/** Open player tickets at most: each becomes a live session, with its own premium requests, once the player writes. */
export const MAX_PLAYER_TICKETS = 25;
/** What a player hears while Help Desk can't tell yet whether their ticket still exists. */
const RECONNECTING = "Support is reconnecting. Try again in a moment.";
/** Work orders Software Factory is still working on. */
const ACTIVE: ReadonlySet<WorkOrderStatus> = new Set(["queued", "planning", "building", "releasing"]);
const MAX_FACTORY_BACKOFF_MS = 60_000;

interface Run {
  readonly id: string;
  readonly size: number;
  readonly startedAt: Date;
  ending?: boolean;
}

/**
 * An issue's work order, the scope it was sent in (a simulation's ID, or `player-<ticket>`), and the factory poll it was
 * known by (a later poll that doesn't list it means it's gone).
 */
interface Routing {
  readonly workOrder: RoutedWorkOrder;
  readonly scope: string;
  readonly poll: number;
}

/** A simulation's ID: its start time in base 36, then a little randomness. */
export function runIdAt(startedAt: Date, random: () => number = Math.random): string {
  return `${startedAt.getTime().toString(36)}${Math.floor(random() * 36 ** 3).toString(36).padStart(3, "0")}`;
}

/** When a simulation started, from its ID. */
export function runStartedAt(runId: string): Date | undefined {
  const time = Number.parseInt(runId.slice(0, -3), 36);
  return Number.isFinite(time) && time > 0 ? new Date(time) : undefined;
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

/** The customer's messages in a ticket's conversation, oldest first. */
function customerText(ticket: CustomerTicket): string {
  return ticket
    .view()
    .items.flatMap((item) => (item.kind === "message" && item.from === "customer" ? [item.text] : []))
    .join("\n\n");
}

/** What a player's ticket says happened at checkout, in the player's terms, so it's classified with their words. */
function checkoutContext(checkout: ShopCheckout | undefined): string {
  if (!checkout?.code) return "";
  const items = checkout.items.map((item) => item.name).join(", ");
  return `At checkout${items ? ` for ${items}` : ""}, I entered the promo code ${checkout.code}${checkout.error ? ` and got "${checkout.error}"` : ""}${checkout.order ? ", so I paid full price" : ""}.`;
}

const gone = (session: SessionInfo) => session.state === "deleting" || session.state === "deleted";
const firstOpened = (a: PlayerTicketSession, b: PlayerTicketSession) => a.openedAt.getTime() - b.openedAt.getTime() || a.ticketId.localeCompare(b.ticketId);

export class HelpDesk implements TicketHost {
  readonly platform: DeskPlatform;
  readonly shop = new Shop();
  readonly knowledge: KnowledgeBase;
  readonly knownIssues: KnownIssues;
  readonly #config: HelpDeskConfig;
  readonly #publish: (event: ServerEvent) => void;
  readonly #factory: FactoryClient;
  #run: Run | undefined;
  /** The simulation's customers' tickets, by customer ID, in the store's customer order. */
  readonly #tickets = new Map<string, CustomerTicket>();
  /** Live players' tickets, by ticket ID. Simulations never touch them. */
  readonly #players = new Map<string, PlayerTicketSession>();
  /** The platform's records of the tickets' sessions: placement and sandbox. */
  #records = new Map<string, SessionInfo>();
  #counters: Counters = { sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 };
  /** Coalesced publishing, by session ID. */
  readonly #ticketTimers = new Map<string, NodeJS.Timeout>();
  readonly #startTimers = new Set<NodeJS.Timeout>();
  #countersTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #operation: Promise<unknown> | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  /**
   * Connected, but the platform's sessions not listed since: a player ticket Help Desk doesn't know may be one it hasn't
   * picked up yet (right after a restart), not an ended one.
   */
  #pickingUp = false;
  readonly #unsubscribe: (() => void)[] = [];
  /** Issues sent to Software Factory, by issue key (`<scope>:<area>`). */
  readonly #routings = new Map<string, Routing>();
  /** Issues being sent right now, by issue key. */
  readonly #sending = new Set<string>();
  /** The issues as last published. */
  #issuesJson = "[]";
  /** Polls of Software Factory started so far. */
  #factoryPolls = 0;
  #factoryPolling: Promise<void> | undefined;
  #factoryTimer: NodeJS.Timeout | undefined;
  #factoryFailures = 0;
  /** Scopes whose work orders were looked up in Software Factory: a new simulation or ticket has none, a picked-up one may. */
  readonly #lookedUp = new Set<string>();
  #closed = false;
  readonly #triage: Triage;
  /** The run's classifications, by customer ID. */
  readonly #triaged = new Map<string, TicketTriage>();
  /** Classification with the support sessions' ordinary LLM, for Classify's comparison. */
  readonly #llmTriage: Triage;
  /** The latest Classify, until a simulation starts. */
  #classification: ClassificationRun | undefined;
  /** The latest Classify of each method, until a simulation starts. */
  #classifications: ClassificationRuns = {};
  /** Known issues whose matching tickets are being answered right now. */
  readonly #answering = new Set<string>();

  constructor(
    platform: DeskPlatform,
    config: HelpDeskConfig,
    publish: (event: ServerEvent) => void,
    factory: FactoryClient = new SoftwareFactory(config.factoryUrl, config.factoryPublicUrl),
    triage: Triage = new Triage(),
    llmTriage: Triage = new Triage(undefined, undefined, "llm"),
  ) {
    this.platform = platform;
    this.#config = config;
    this.#publish = publish;
    this.#factory = factory;
    this.knowledge = new KnowledgeBase(config.dataDir);
    this.knownIssues = new KnownIssues(config.dataDir);
    this.#triage = triage;
    this.#llmTriage = llmTriage;
  }

  start(): void {
    this.#unsubscribe.push(
      this.platform.onConnected(() => {
        this.#pickingUp = true;
        void this.sync();
      }),
      this.platform.onStatus(() => this.#publish({ type: "platform", platform: this.platform.status, desk: this.desk() })),
      this.#triage.onChange(() => this.#publish({ type: "platform", platform: this.platform.status, desk: this.desk() })),
      this.#llmTriage.onChange(() => this.#publish({ type: "platform", platform: this.platform.status, desk: this.desk() })),
    );
    this.#pollTimer = setInterval(() => {
      this.dropIdlePlayers();
      // A listing that failed is tried again: until one works, open chats can't be told from ended ones.
      if (this.#pickingUp && !this.#syncing && this.platform.status.state === "connected") void this.sync();
      void this.#poll();
    }, this.#config.countersIntervalMs);
    this.#pollTimer.unref?.();
  }

  /** Lets go of every session (Help Desk is shutting down); the sessions stay on the platform. */
  close(): void {
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    for (const timer of [...this.#ticketTimers.values(), ...this.#startTimers]) clearTimeout(timer);
    this.#ticketTimers.clear();
    this.#startTimers.clear();
    if (this.#countersTimer) clearTimeout(this.#countersTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#stopFactoryPolls();
    for (const ticket of this.#allTickets()) ticket.close();
  }

  desk(): DeskInfo {
    const factory = { configured: this.#factory.configured, ...(this.#factory.configured && this.#factory.publicUrl ? { url: this.#factory.publicUrl } : {}) };
    return { environment: this.#config.environment, ...(this.platform.model ? { model: this.platform.model } : {}), tools: TOOLS, playerTools: PLAYER_TOOLS, factory, triage: this.#triage.status, llmTriage: this.#llmTriage.status };
  }

  #runInfo(): RunInfo | undefined {
    const run = this.#run;
    return run ? { id: run.id, size: run.size, startedAt: run.startedAt.toISOString(), ...(run.ending ? { ending: true } : {}) } : undefined;
  }

  #allTickets(): TicketSession[] {
    return [...this.#tickets.values(), ...this.#players.values()];
  }

  #views(): Ticket[] {
    return [...this.#tickets.values()].map((ticket) => this.#view(ticket));
  }

  /** A ticket as the wall shows it: its conversation, its classification, and the known issue that reached it. */
  #view(ticket: CustomerTicket): Ticket {
    const triage = this.#triaged.get(ticket.customer.id);
    const knownIssue = this.#knownIssueOf(ticket.sessionId);
    return { ...ticket.view(), ...(triage ? { triage } : {}), ...(knownIssue ? { knownIssue } : {}) };
  }

  /** A player's ticket as the wall shows it. */
  #playerView(ticket: PlayerTicketSession): PlayerTicket {
    const knownIssue = this.#knownIssueOf(ticket.sessionId);
    return { ...ticket.view(), ...(knownIssue ? { knownIssue } : {}) };
  }

  /** The newest known issue whose answer reached this session as a match (or is still checking it), for its tile. */
  #knownIssueOf(sessionId: string): TicketKnownIssue | undefined {
    for (const issue of this.knownIssues.list()) {
      const entry = issue.answer?.tickets.find((candidate) => candidate.sessionId === sessionId);
      if (entry && entry.state !== "no-match") return { id: issue.id, title: issue.title, state: entry.state, ...(entry.message ? { message: entry.message } : {}) };
    }
    return undefined;
  }

  /** Classifies a customer's conversation (`text`: the customer's messages), when classification is set up. */
  #classify(ticket: CustomerTicket, text: string): void {
    const run = this.#run;
    // Not connected to the triage environment: the wall says why, rather than every ticket.
    if (!this.#triage.connected || !run) return;
    const id = ticket.customer.id;
    const current = this.#triaged.get(id);
    // A reclassification keeps showing the last category until the new one arrives.
    if (current?.state !== "done") this.#triaged.set(id, { state: "classifying" });
    this.changed(ticket);
    const state = text.length > MAX_TRIAGE_TEXT ? text.slice(-MAX_TRIAGE_TEXT) : text;
    void this.#triage.classify(state).then(
      (result): TicketTriage => ({ state: "done", category: result.category, urgent: result.urgent }),
      (error: unknown): TicketTriage => ({ state: "failed", message: errorText(error) }),
    ).then((triage) => {
      if (this.#run !== run || this.#tickets.get(id) !== ticket) return;
      // A failed reclassification keeps the earlier category.
      if (triage.state === "failed" && this.#triaged.get(id)?.state === "done") return;
      this.#triaged.set(id, triage);
      this.changed(ticket);
    });
  }

  /** Newest first. */
  #playerViews(): PlayerTicket[] {
    return [...this.#players.values()]
      .sort((a, b) => firstOpened(b, a))
      .map((ticket) => this.#playerView(ticket));
  }

  /** The software issues: the simulation's customers' and the players' bug reports by area, and the work orders sent for them. */
  issues(): SoftwareIssue[] {
    const reports: Reported[] = [];
    for (const ticket of this.#tickets.values()) {
      const bug = ticket.bug;
      if (bug) reports.push({ customerId: ticket.customer.id, name: ticket.customer.name, bug });
    }
    for (const ticket of this.#players.values()) {
      const bug = ticket.bug;
      if (bug) reports.push({ ticketId: ticket.ticketId, name: ticket.name, bug });
    }
    const routed = new Map<BugArea, RoutedWorkOrder>();
    for (const area of BUG_AREAS) {
      const scope = this.#scopeOf(area);
      const routing = scope ? this.#routings.get(issueKey(scope, area)) : undefined;
      if (routing) routed.set(area, routing.workOrder);
    }
    return groupIssues(reports, routed);
  }

  state(): HelpDeskState {
    const run = this.#runInfo();
    return {
      platform: this.platform.status,
      desk: this.desk(),
      customers: this.shop.customers(),
      ...(run ? { run } : {}),
      tickets: this.#views(),
      players: this.#playerViews(),
      ...(this.#classification ? { classification: this.#classification } : {}),
      classifications: this.#classifications,
      issues: this.issues(),
      counters: this.#counters,
      knowledge: this.knowledge.list(),
      proposals: this.knowledge.proposals(),
      knownIssues: this.knownIssues.list(),
    };
  }

  /** What a browser gets when it connects to the event stream. */
  initialEvents(): ServerEvent[] {
    const run = this.#runInfo();
    return [
      { type: "platform", platform: this.platform.status, desk: this.desk() },
      { type: "run", ...(run ? { run } : {}), tickets: this.#views(), issues: this.issues() },
      this.#classificationEvent(),
      { type: "players", players: this.#playerViews() },
      { type: "counters", counters: this.#counters },
      this.#knowledgeEvent(),
      this.#knownIssuesEvent(),
    ];
  }

  /**
   * What a player's chat page gets when it connects: the platform's status, and the ticket (none once it ended). While
   * Help Desk can't tell yet whether a ticket it doesn't know ended, the page gets no ticket news at all.
   */
  playerEvents(ticketId: string): ServerEvent[] {
    const ticket = this.#players.get(ticketId);
    const platform: ServerEvent = { type: "platform", platform: this.platform.status, desk: this.desk() };
    if (!ticket && this.#unsure()) return [platform];
    return [platform, { type: "players", players: ticket ? [this.#playerView(ticket)] : [] }];
  }

  /** Whether a ticket Help Desk doesn't know may still exist: it isn't connected, or hasn't picked up its tickets yet. */
  #unsure(): boolean {
    return this.#pickingUp || this.platform.status.state !== "connected";
  }

  #requireConnected(): void {
    if (this.platform.status.state !== "connected") throw new HelpDeskError("platform_unavailable", this.platform.status.message ?? "Managed Copilot isn't connected yet.", 503);
  }

  /** One simulation change at a time. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#operation) throw new HelpDeskError("busy", "The simulation is still starting or ending. Try again in a moment.", 409);
    const operation = work().finally(() => {
      this.#operation = undefined;
    });
    this.#operation = operation;
    return operation;
  }

  #classificationEvent(): ServerEvent {
    return { type: "classification", ...(this.#classification ? { classification: this.#classification } : {}), classifications: this.#classifications };
  }

  #setClassification(run: ClassificationRun | undefined): void {
    this.#classification = run;
    this.#classifications = run ? { ...this.#classifications, [run.method]: run } : {};
    this.#publish(this.#classificationEvent());
  }

  /**
   * Classifies the first `size` customers' opening messages without starting their sessions, all at once, publishing
   * each result as it arrives and the time and usage of the whole lot. `decision` uses the decision model, `llm` the
   * support sessions' model, so the two can be compared. Replaces that method's previous Classify; not during a
   * simulation or another Classify.
   */
  classifyOpenings(size: number, method: ClassificationMethod = "decision"): ClassificationRun {
    if (!(SIMULATION_SIZES as readonly number[]).includes(size)) throw new HelpDeskError("invalid_request", `Classify ${SIMULATION_SIZES.join(", ")} customers.`);
    if (!(CLASSIFICATION_METHODS as readonly string[]).includes(method)) throw new HelpDeskError("invalid_request", `Classify with ${CLASSIFICATION_METHODS.join(" or ")}.`);
    const triage = method === "llm" ? this.#llmTriage : this.#triage;
    if (!triage.enabled) {
      throw new HelpDeskError("classification_off", method === "llm" ? "Classification with the LLM isn't set up." : "Ticket classification isn't set up. Help Desk's README shows how to turn it on.", 409);
    }
    if (this.#run || this.#operation) throw new HelpDeskError("busy", "End the simulation first: Classify reads the customers' first messages without starting their sessions.", 409);
    if (this.#classification && this.#classification.elapsedMs === undefined) throw new HelpDeskError("busy", "Wait for the current Classify to finish, so its time isn't shared with another.", 409);
    if (!triage.connected) throw new HelpDeskError("classification_unavailable", method === "llm" ? "Managed Copilot isn't connected yet." : "The triage environment isn't connected yet.", 503);
    const startedAt = new Date();
    const started = performance.now();
    const customers = CUSTOMERS.slice(0, size);
    let current: ClassificationRun = {
      id: runIdAt(startedAt),
      method,
      ...(triage.model ? { model: triage.model } : {}),
      size,
      startedAt: startedAt.toISOString(),
      results: Object.fromEntries(customers.map((customer) => [customer.id, { state: "classifying" } satisfies TicketTriage])),
      usage: { inputTokens: 0, outputTokens: 0, measured: 0 },
    };
    this.#setClassification(current);
    for (const customer of customers) {
      void triage.classify(customer.opening).then(
        (result) => ({ triage: { state: "done", category: result.category, urgent: result.urgent } satisfies TicketTriage, usage: result.usage }),
        (error: unknown) => ({ triage: { state: "failed", message: errorText(error) } satisfies TicketTriage, usage: undefined }),
      ).then(({ triage: result, usage }) => {
        // A simulation or a newer Classify replaced this one.
        if (this.#classification !== current) return;
        const results = { ...current.results, [customer.id]: result };
        const finished = Object.values(results).every((entry) => entry.state !== "classifying");
        const total = usage
          ? {
              inputTokens: current.usage.inputTokens + usage.inputTokens,
              outputTokens: current.usage.outputTokens + usage.outputTokens,
              measured: current.usage.measured + 1,
            }
          : current.usage;
        current = { ...current, results, usage: total, ...(finished ? { elapsedMs: Math.round(performance.now() - started) } : {}) };
        if (finished) log.info("Classified the customers' first messages", { method, model: current.model, customers: size, ms: current.elapsedMs, ...current.usage });
        this.#setClassification(current);
      });
    }
    return current;
  }

  /** Ends the current simulation, then starts `size` customers' sessions in a quick wave. Player tickets stay. */
  simulate(size: number): Promise<RunInfo> {
    if (!(SIMULATION_SIZES as readonly number[]).includes(size)) throw new HelpDeskError("invalid_request", `Simulate ${SIMULATION_SIZES.join(", ")} customers.`);
    this.#requireConnected();
    return this.#exclusive(async () => {
      await this.#endRun();
      if (this.#classification) this.#setClassification(undefined);
      const startedAt = new Date();
      const run: Run = { id: runIdAt(startedAt), size, startedAt };
      this.shop.reset(startedAt);
      this.#run = run;
      // A new simulation has no work orders in Software Factory yet.
      this.#lookedUp.add(run.id);
      const customers = CUSTOMERS.slice(0, size);
      for (const customer of customers) this.#tickets.set(customer.id, new CustomerTicket(this, customer, sessionIdFor(run.id, customer.id)));
      this.#publishRun();
      for (const customer of customers) this.#classify(this.#tickets.get(customer.id)!, customer.opening);
      customers.forEach((customer, index) => {
        const timer = setTimeout(() => {
          this.#startTimers.delete(timer);
          void this.#tickets.get(customer.id)?.start(customer.opening);
        }, index * this.#config.staggerMs);
        this.#startTimers.add(timer);
      });
      log.info("Started a simulation", { run: run.id, customers: size, model: this.platform.model });
      void this.#deleteLeftovers();
      return this.#runInfo()!;
    });
  }

  /** Ends the simulation: deletes its sessions. Player tickets stay. */
  end(): Promise<void> {
    this.#requireConnected();
    return this.#exclusive(() => this.#endRun());
  }

  async #endRun(): Promise<void> {
    const run = this.#run;
    if (!run) return;
    run.ending = true;
    for (const timer of this.#startTimers) clearTimeout(timer);
    this.#startTimers.clear();
    this.#publishRun();
    const tickets = [...this.#tickets.values()];
    // Creates in flight finish first, so their sessions are deleted too.
    await Promise.all(tickets.map((ticket) => ticket.settled()));
    for (const ticket of tickets) ticket.close();
    await eachLimited(tickets, 8, (ticket) => this.#delete(ticket.sessionId));
    for (const ticket of tickets) {
      this.#clearTimer(ticket);
      this.#records.delete(ticket.sessionId);
    }
    this.#tickets.clear();
    this.#triaged.clear();
    this.#run = undefined;
    // Software Factory keeps the work orders; the next simulation's issues start over. The players' issues stay.
    this.#dropScope(run.id);
    log.info("Ended a simulation", { run: run.id, sessions: tickets.length });
    this.#publishRun();
    this.#updateCounters();
  }

  async #delete(sessionId: string): Promise<void> {
    try {
      await this.platform.deleteSession(sessionId);
    } catch (error) {
      if (!isMissingSession(error)) log.warn("Couldn't delete a session", { sessionId, error: errorText(error) });
    }
  }

  /** Sessions of earlier simulations that weren't deleted (Help Desk stopped while they ran). Players' sessions stay. */
  async #deleteLeftovers(sessions?: readonly SessionInfo[]): Promise<void> {
    let listed = sessions;
    if (!listed) {
      try {
        listed = await this.platform.listSessions();
      } catch (error) {
        return log.warn("Couldn't list the help desk's sessions", { error: errorText(error) });
      }
    }
    const leftovers = listed.filter((session) => !gone(session) && parseSessionId(session.id) && parseSessionId(session.id)?.runId !== this.#run?.id);
    if (leftovers.length === 0) return;
    log.info("Deleting sessions of earlier simulations", { sessions: leftovers.length });
    await eachLimited(leftovers, 8, (session) => this.#delete(session.id));
  }

  #require(customerId: string): CustomerTicket {
    const ticket = this.#tickets.get(customerId);
    if (!ticket) throw new HelpDeskError("not_found", "That customer isn't in the current simulation.", 404);
    return ticket;
  }

  ticket(customerId: string): Ticket {
    return this.#view(this.#require(customerId));
  }

  /** A message someone typed: trimmed, and not too long. */
  #message(text: unknown): string {
    const message = typeof text === "string" ? text.trim() : "";
    if (!message) throw new HelpDeskError("invalid_request", "Write a message first.");
    if (message.length > MAX_MESSAGE) throw new HelpDeskError("invalid_request", `Keep messages under ${MAX_MESSAGE.toLocaleString("en-US")} characters.`);
    return message;
  }

  async send(customerId: string, text: unknown): Promise<void> {
    this.#requireConnected();
    const message = this.#message(text);
    const ticket = this.#require(customerId);
    const said = customerText(ticket);
    await ticket.send(defuseTeamNotes(message));
    this.#classify(ticket, said ? `${said}\n\n${message}` : message);
  }

  /** The GitHub account Help Desk is signed in as: the team member who acts on the wall. */
  #teamMember(): string {
    return this.platform.status.account?.login ?? "a team member";
  }

  /** A team member's note to a customer's agent: the customer doesn't see it, and the agent replies as it asks. */
  async note(customerId: string, text: unknown): Promise<void> {
    this.#requireConnected();
    const message = this.#message(text);
    await this.#require(customerId).sendTeamNote(message, this.#teamMember());
  }

  /** A team member's note to a player's agent: the player doesn't see it. */
  async notePlayer(ticketId: string, text: unknown): Promise<void> {
    this.#requireConnected();
    const message = this.#message(text);
    const ticket = this.#requirePlayer(ticketId);
    if (ticket.ending) throw new HelpDeskError("not_found", "This support chat has ended.", 404);
    await ticket.sendTeamNote(message, this.#teamMember());
  }

  /** The operator's answer to a refund, a cancellation, or a fact the customer's agent proposed. */
  answer(customerId: string, approvalId: string, approve: boolean): void {
    const ticket = this.#require(customerId);
    const proposal = this.knowledge.proposal(approvalId);
    if (proposal && proposal.source.sessionId === ticket.sessionId) this.decide(approvalId, approve);
    else ticket.answer(approvalId, approve);
  }

  /** Adds a proposed fact to the team knowledge base, or declines it; a proposed known issue is recorded or declined. The agent that proposed it is never told. */
  decide(id: string, add: boolean): void {
    const proposal = this.knowledge.proposal(id);
    if (proposal?.kind === "known-issue") return this.#decideKnownIssue(proposal, add);
    const entry = this.knowledge.decide(id, add);
    if (entry === undefined || !proposal) throw new HelpDeskError("not_actionable", "This fact was added or declined already.", 409);
    log.info(add ? "Added a fact to the team knowledge base" : "Declined a proposed fact", { customer: proposal.source.customerId, subject: proposal.subject });
    this.#publishKnowledge();
    const ticket = this.#tickets.get(proposal.source.customerId);
    if (ticket?.sessionId === proposal.source.sessionId) this.changed(ticket);
  }

  /** Removes a fact from the team knowledge base: sessions created or reopened from now on aren't told it. */
  forget(id: string): void {
    if (!this.knowledge.remove(id)) throw new HelpDeskError("not_found", "That fact isn't in the team knowledge base.", 404);
    log.info("Removed a fact from the team knowledge base", { id });
    this.#publishKnowledge();
  }

  #knowledgeEvent(): ServerEvent {
    return { type: "knowledge", knowledge: this.knowledge.list(), proposals: this.knowledge.proposals() };
  }

  #publishKnowledge(): void {
    this.#publish(this.#knowledgeEvent());
  }

  // ─── Known issues ──────────────────────────────────────────────────────────────────────────────────────────

  #knownIssuesEvent(): ServerEvent {
    return { type: "known-issues", knownIssues: this.knownIssues.list() };
  }

  #publishKnownIssues(): void {
    this.#publish(this.#knownIssuesEvent());
  }

  /** Records a known issue an agent proposed (as the signed-in team member), or declines it. */
  #decideKnownIssue(proposal: MemoryProposal, record: boolean): void {
    this.knowledge.withdraw(proposal.id);
    if (record) {
      const issue = this.knownIssues.record(proposal, this.#teamMember());
      log.info("Recorded a known issue", { title: issue.title, by: issue.recordedBy, customer: proposal.source.customerId });
      this.#publishKnownIssues();
    } else {
      log.info("Declined a proposed known issue", { title: proposal.subject, customer: proposal.source.customerId });
    }
    this.#publishKnowledge();
    const ticket = this.#tickets.get(proposal.source.customerId);
    if (ticket?.sessionId === proposal.source.sessionId) this.changed(ticket);
  }

  /** Resolves a known issue: sessions created or reopened from now on aren't told it, and tiles lose its label. */
  resolveKnownIssue(id: string): void {
    const issue = this.knownIssues.get(id);
    if (!issue) throw new HelpDeskError("not_found", "That known issue was resolved already.", 404);
    if (this.#answering.has(id)) throw new HelpDeskError("busy", "Its matching tickets are being answered right now. Resolve it once that's done.", 409);
    this.knownIssues.remove(id);
    log.info("Resolved a known issue", { title: issue.title });
    this.#publishKnownIssues();
    for (const entry of issue.answer?.tickets ?? []) {
      const ticket = this.#ticketBySession(entry.sessionId);
      if (ticket) this.changed(ticket);
    }
  }

  #ticketBySession(sessionId: string): TicketSession | undefined {
    return this.#allTickets().find((ticket) => ticket.sessionId === sessionId);
  }

  /** Whether a ticket is still on the wall, and can still be written to. */
  #onWall(ticket: TicketSession): boolean {
    if (ticket instanceof PlayerTicketSession) return this.#players.get(ticket.ticketId) === ticket && !ticket.ending;
    return ticket instanceof CustomerTicket && this.#tickets.get(ticket.customer.id) === ticket && !this.#run?.ending;
  }

  /**
   * The open tickets a known issue's answer checks, players first as on the wall: those with a conversation that isn't
   * resolved, failed, or ending, except the one the issue was learned in. With the customer's or player's words.
   */
  #openTickets(issue: KnownIssue): { readonly ticket: TicketSession; readonly entry: KnownIssueTicket; readonly text: string }[] {
    const open = (ticket: TicketSession) => ticket.created && ticket.sessionId !== issue.source.sessionId && !["resolved", "failed", "opened"].includes(ticket.status());
    const players = [...this.#players.values()]
      .sort((a, b) => firstOpened(b, a))
      .filter((ticket) => open(ticket) && !ticket.ending)
      .map((ticket) => {
        const view = ticket.view();
        const words = view.items.flatMap((item) => (item.kind === "message" && item.from === "customer" ? [item.text] : [])).join("\n\n");
        const text = [checkoutContext(view.checkout), words].filter(Boolean).join("\n\n");
        return { ticket, entry: { sessionId: ticket.sessionId, ticketId: ticket.ticketId, name: view.player.name, state: "classifying" as const }, text };
      });
    const customers = [...this.#tickets.values()]
      .filter(open)
      .map((ticket) => ({
        ticket,
        entry: { sessionId: ticket.sessionId, customerId: ticket.customer.id, name: ticket.customer.name, state: "classifying" as const },
        text: customerText(ticket) || ticket.customer.opening,
      }));
    return [...players, ...customers].filter((candidate) => candidate.text.trim());
  }

  /**
   * Answers a known issue's matching tickets: the decision model classifies every open ticket (the customer's words) as
   * about the issue or not, and each match's agent is sent the issue's update in a team note, so the reply comes from
   * the agent, in the customer's own conversation. Tickets an earlier answer reached aren't checked again. Each
   * ticket's outcome is published as it arrives; refunds and cancellations the agents ask for still wait for a person.
   */
  answerKnownIssue(id: string): KnownIssue {
    const issue = this.knownIssues.get(id);
    if (!issue) throw new HelpDeskError("not_found", "That known issue was resolved, or doesn't exist.", 404);
    this.#requireConnected();
    if (!this.#triage.enabled) {
      throw new HelpDeskError("classification_off", "Answering matching tickets needs the decision model, which isn't set up. Help Desk's README shows how to turn it on.", 409);
    }
    if (!this.#triage.connected) throw new HelpDeskError("classification_unavailable", "The decision model's environment isn't connected yet. Try again in a moment.", 503);
    if (this.#answering.has(id)) throw new HelpDeskError("busy", "Its matching tickets are being answered already.", 409);
    if (this.#run?.ending) throw new HelpDeskError("busy", "The simulation is ending. Try again in a moment.", 409);
    const onWall = new Set(this.#allTickets().map((ticket) => ticket.sessionId));
    const replied = (issue.answer?.tickets ?? []).filter((entry) => entry.state === "replied" && onWall.has(entry.sessionId));
    const done = new Set(replied.map((entry) => entry.sessionId));
    const open = this.#openTickets(issue).filter((candidate) => !done.has(candidate.ticket.sessionId));
    if (open.length === 0) {
      throw new HelpDeskError(
        "conflict",
        replied.length > 0 ? "Every open ticket about it was sent its update already." : "There are no open tickets to check. Simulate customers, or wait for a player to write.",
        409,
      );
    }
    const answer: KnownIssueAnswer = { startedAt: new Date().toISOString(), startedBy: this.#teamMember(), tickets: [...open.map((candidate) => candidate.entry), ...replied] };
    this.#answering.add(id);
    this.knownIssues.answer(id, answer);
    this.#publishKnownIssues();
    for (const { ticket } of open) this.changed(ticket);
    log.info("Answering a known issue's matching tickets", { title: issue.title, tickets: open.length });
    void this.#answerAll(issue, open).finally(() => this.#answering.delete(id));
    return this.knownIssues.get(id)!;
  }

  async #answerAll(issue: KnownIssue, open: readonly { readonly ticket: TicketSession; readonly text: string }[]): Promise<void> {
    const batch = this.#triage.batch(matchQuestions(issue), MATCH);
    try {
      await Promise.all(
        open.map(async ({ ticket, text }) => {
          let matches: boolean;
          try {
            matches = (await batch.ask(text.length > MAX_TRIAGE_TEXT ? text.slice(-MAX_TRIAGE_TEXT) : text)).matches;
          } catch (error) {
            return this.#answered(issue.id, ticket, { state: "failed", message: errorText(error) });
          }
          if (!matches) return this.#answered(issue.id, ticket, { state: "no-match" });
          if (!this.#onWall(ticket)) return this.#answered(issue.id, ticket, { state: "failed", matched: true, message: "This conversation ended before its update was sent." });
          this.#answered(issue.id, ticket, { state: "replying", matched: true });
          try {
            const waiting = ticket.status() === "approval";
            await ticket.sendTeamNote(updateNote(issue), HELP_DESK_AUTHOR, issue.id);
            this.#answered(issue.id, ticket, {
              state: "replied",
              ...(waiting ? { message: "Queued: the agent replies once you answer the request it's waiting on." } : {}),
            });
          } catch (error) {
            this.#answered(issue.id, ticket, { state: "failed", message: errorText(error) });
          }
        }),
      );
    } finally {
      batch.close();
    }
    const answer = this.knownIssues.get(issue.id)?.answer;
    if (!answer) return;
    this.knownIssues.answer(issue.id, { ...answer, finishedAt: new Date().toISOString() });
    this.#publishKnownIssues();
    const count = (state: KnownIssueTicket["state"]) => answer.tickets.filter((entry) => entry.state === state).length;
    log.info("Answered a known issue's matching tickets", { title: issue.title, checked: open.length, replied: count("replied"), failed: count("failed") });
  }

  /** One ticket's outcome in a known issue's answer. */
  #answered(issueId: string, ticket: TicketSession, outcome: Pick<KnownIssueTicket, "state" | "matched" | "message">): void {
    const answer = this.knownIssues.get(issueId)?.answer;
    if (!answer) return;
    const settled = outcome.state !== "classifying" && outcome.state !== "replying";
    const tickets = answer.tickets.map((entry): KnownIssueTicket => {
      if (entry.sessionId !== ticket.sessionId) return entry;
      const { message: _previous, at: _at, ...rest } = entry;
      return {
        ...rest,
        state: outcome.state,
        ...(outcome.matched ? { matched: true } : {}),
        ...(outcome.message ? { message: outcome.message } : {}),
        ...(settled ? { at: new Date().toISOString() } : {}),
      };
    });
    if (!this.knownIssues.answer(issueId, { ...answer, tickets })) return;
    if (outcome.state === "failed") log.warn("Couldn't answer a ticket about a known issue", { session: ticket.sessionId, error: outcome.message });
    this.#publishKnownIssues();
    this.changed(ticket);
  }

  // ─── Players ───────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Opens a live player's ticket when they open support in the game. It has no session yet: the player's first message
   * starts it. With the `ticketId` of an open ticket of the same rider, that ticket is reopened instead and takes the
   * context the game sent (`reopened`); so does the same opening sent twice (the game retried it).
   */
  openPlayerTicket(body: unknown): { readonly ticket: PlayerTicketCreated; readonly reopened: boolean } {
    const request = parsePlayerTicket(body);
    this.#requireConnected();
    const context = contextOf(request);
    const asked = request.ticketId ? this.#players.get(request.ticketId) : undefined;
    // The game reopening a ticket that isn't picked up yet: wait for it rather than open a second one.
    if (request.ticketId && !asked && this.#pickingUp) throw new HelpDeskError("platform_unavailable", RECONNECTING, 503);
    const open =
      asked && !asked.ending && asked.context?.player.rider === context.player.rider
        ? asked
        : [...this.#players.values()].find((ticket) => !ticket.ending && ticket.context !== undefined && sameOpening(ticket.context, context));
    if (open) {
      open.reopen(context);
      log.info("A player opened support again", { player: open.ticketId, opener: context.opener, checkout: context.checkout !== undefined });
      return { ticket: { ticketId: open.ticketId, chatPath: chatPath(open.ticketId) }, reopened: true };
    }
    if (this.#players.size >= MAX_PLAYER_TICKETS) {
      throw new HelpDeskError("too_many_tickets", `Help Desk has ${MAX_PLAYER_TICKETS} open player tickets already. End some on the wall, then try again.`, 429);
    }
    let ticketId = newTicketId();
    while (this.#players.has(ticketId)) ticketId = newTicketId();
    const ticket = new PlayerTicketSession(this, ticketId, context);
    this.#players.set(ticketId, ticket);
    // A new ticket has no work orders in Software Factory yet.
    this.#lookedUp.add(playerScope(ticketId));
    this.#publishPlayers();
    log.info("A player opened support", { player: ticketId, opener: context.opener, checkout: context.checkout !== undefined });
    return { ticket: { ticketId, chatPath: chatPath(ticketId) }, reopened: false };
  }

  #requirePlayer(ticketId: string): PlayerTicketSession {
    const ticket = this.#players.get(ticketId);
    if (ticket) return ticket;
    if (this.#unsure()) throw new HelpDeskError("platform_unavailable", RECONNECTING, 503);
    throw new HelpDeskError("not_found", "There's no such support chat. It may have ended.", 404);
  }

  playerTicket(ticketId: string): PlayerTicket {
    return this.#playerView(this.#requirePlayer(ticketId));
  }

  /** Sends a message as the player (from their chat page, or from the wall). The first one starts the session. */
  async sendAsPlayer(ticketId: string, text: unknown): Promise<void> {
    this.#requireConnected();
    const message = this.#message(text);
    const ticket = this.#requirePlayer(ticketId);
    if (ticket.ending) throw new HelpDeskError("not_found", "This support chat has ended.", 404);
    await ticket.send(message);
  }

  answerPlayer(ticketId: string, approvalId: string, approve: boolean): void {
    this.#requirePlayer(ticketId).answer(approvalId, approve);
  }

  /** Ends a player's ticket: deletes its session, if it has one. The player's chat page says it ended. */
  async endPlayer(ticketId: string): Promise<void> {
    this.#requireConnected();
    const ticket = this.#requirePlayer(ticketId);
    if (ticket.ending) throw new HelpDeskError("busy", "This ticket is being ended already.", 409);
    ticket.ending = true;
    this.#publish({ type: "player", ticket: this.#playerView(ticket) });
    try {
      // A create in flight finishes first, so its session is deleted too.
      await ticket.settled();
      ticket.close();
      if (ticket.created) await this.#delete(ticket.sessionId);
    } finally {
      this.#removePlayer(ticket);
    }
    log.info("Ended a player's ticket", { player: ticketId });
  }

  /**
   * Drops the player tickets that never got a message (no session, nothing to delete) once `playerIdleMs` passed since
   * the game last opened them, so stray opens don't clutter the wall. Tickets with a conversation stay until ended.
   */
  dropIdlePlayers(now = Date.now()): void {
    for (const ticket of [...this.#players.values()]) {
      if (ticket.created || ticket.ending || ticket.status() === "starting" || now - ticket.lastOpenedAt < this.#config.playerIdleMs) continue;
      this.#removePlayer(ticket);
      log.info("Dropped a player's ticket that never got a message", { player: ticket.ticketId });
    }
  }

  #removePlayer(ticket: PlayerTicketSession): void {
    ticket.close();
    if (this.#players.get(ticket.ticketId) === ticket) this.#players.delete(ticket.ticketId);
    this.#clearTimer(ticket);
    this.#records.delete(ticket.sessionId);
    this.#dropScope(playerScope(ticket.ticketId));
    this.#publishPlayers();
    this.#updateIssues();
    this.#updateCounters();
  }

  // ─── Software issues ───────────────────────────────────────────────────────────────────────────────────────

  /** The open player tickets that reported a problem in `area`, the first opened first. */
  #playerReporters(area: BugArea): PlayerTicketSession[] {
    return [...this.#players.values()].filter((ticket) => ticket.bug?.area === area).sort(firstOpened);
  }

  /**
   * Whose reports an area's issue goes to Software Factory with, its scope: the running simulation's (players' reports
   * join it), or with none running, the first opened player ticket's that reported it. An issue is sent once per scope.
   */
  #scopeOf(area: BugArea): string | undefined {
    if (this.#run) return this.#run.id;
    const first = this.#playerReporters(area)[0];
    return first ? playerScope(first.ticketId) : undefined;
  }

  /** The scopes whose work orders matter now: the simulation's, and each open player ticket's. */
  #scopes(): Set<string> {
    const scopes = new Set<string>();
    if (this.#run) scopes.add(this.#run.id);
    for (const ticketId of this.#players.keys()) scopes.add(playerScope(ticketId));
    return scopes;
  }

  #needsLookup(): boolean {
    return [...this.#scopes()].some((scope) => !this.#lookedUp.has(scope));
  }

  /** A simulation or player ticket ended: its issues' work orders no longer show (Software Factory keeps them). */
  #dropScope(scope: string): void {
    for (const [key, routing] of [...this.#routings]) if (routing.scope === scope) this.#routings.delete(key);
    this.#lookedUp.delete(scope);
    if (this.#scopes().size === 0) this.#stopFactoryPolls();
  }

  /**
   * Sends a software issue to Software Factory: a work order to fix the storefront's code, once per scope and area (see
   * `#scopeOf`). A failed send can be tried again. `appUrl` is Help Desk's address as the operator uses it, for the link
   * back.
   */
  async routeIssue(area: string, appUrl: string): Promise<SoftwareIssue> {
    if (!isBugArea(area)) throw new HelpDeskError("not_found", "There's no such software issue.", 404);
    if (!this.#factory.configured) throw new HelpDeskError("factory_unavailable", FACTORY_NOT_CONNECTED, 503);
    const run = this.#run;
    if (run?.ending) throw new HelpDeskError("busy", "The simulation is ending. Try again in a moment.", 409);
    const reports = this.#conversations(area);
    if (reports.length === 0) {
      const nobody = !run
        ? "No player has reported this problem, and no simulation is running."
        : this.#players.size > 0
          ? "No customer or player has reported this problem."
          : "No customer of this simulation has reported this problem.";
      throw new HelpDeskError("not_found", nobody, 404);
    }
    const scope = this.#scopeOf(area)!;
    const key = issueKey(scope, area);
    const sent = this.#routings.get(key)?.workOrder;
    if (sent) throw new HelpDeskError("conflict", `This issue was sent to Software Factory already, as ${workOrderName(sent.number)}.`, 409);
    if (this.#sending.has(key)) throw new HelpDeskError("conflict", "This issue is being sent to Software Factory right now.", 409);
    this.#sending.add(key);
    try {
      // Sent before Help Desk restarted, while Software Factory couldn't be asked: it isn't sent twice.
      const existing = (await this.#factory.list()).find((summary) => summary.origin?.app === "help-desk" && summary.origin.key === key);
      if (existing) {
        if (this.#scopeOf(area) === scope) this.#track(key, scope, existing);
        throw new HelpDeskError("conflict", `This issue was sent to Software Factory already, as ${workOrderName(existing.number)}.`, 409);
      }
      const request = issueWorkOrder({ area, scope, appUrl, reports, project: await readProject(this.#config.storefrontDir) });
      const created = await this.#factory.create(request);
      log.info("Sent a software issue to Software Factory", { area, scope, workOrder: workOrderName(created.number), reports: reports.length });
      if (this.#scopeOf(area) !== scope) {
        const what = run && scope === run.id ? "The simulation ended" : this.#run ? "A simulation started" : "The ticket that reported it first was ended";
        throw new HelpDeskError("conflict", `${what} while the issue was being sent. Software Factory has it as ${workOrderName(created.number)}.`, 409);
      }
      this.#track(key, scope, created);
      return this.issues().find((issue) => issue.area === area)!;
    } finally {
      this.#sending.delete(key);
    }
  }

  /** The tickets that reported a problem in `area`, with their conversations: the simulation's customers, and players. */
  #conversations(area: BugArea): ReportedConversation[] {
    const customers = [...this.#tickets.values()].flatMap((ticket): ReportedConversation[] => {
      const view = ticket.view();
      return view.bug?.area === area ? [{ customerId: ticket.customer.id, name: ticket.customer.name, bug: view.bug, items: view.items }] : [];
    });
    const players = [...this.#players.values()].flatMap((ticket): ReportedConversation[] => {
      const view = ticket.view();
      if (view.bug?.area !== area) return [];
      const shop = view.checkout ? { shop: { checkout: view.checkout, ...(view.gameVersion ? { gameVersion: view.gameVersion } : {}) } } : {};
      return [{ ticketId: ticket.ticketId, name: view.player.name, bug: view.bug, items: view.items, ...shop }];
    });
    return [...customers, ...players];
  }

  #routed(summary: WorkOrderSummary): RoutedWorkOrder {
    const url = workOrderUrl(this.#factory.publicUrl ?? "", summary.id);
    return { workOrderId: summary.id, number: summary.number, title: summary.title, status: summary.status, url, ...(summary.error ? { error: summary.error.message } : {}) };
  }

  /** Follows an issue's work order from now on. */
  #track(key: string, scope: string, summary: WorkOrderSummary): void {
    this.#routings.set(key, { workOrder: this.#routed(summary), scope, poll: this.#factoryPolls });
    this.#updateIssues();
    this.#scheduleFactoryPoll();
  }

  #anyActive(): boolean {
    return [...this.#routings.values()].some((routing) => ACTIVE.has(routing.workOrder.status));
  }

  /** Reads Software Factory's work orders: the status of the ones sent, and (after a restart) which issues were sent. */
  pollFactory(): Promise<void> {
    this.#factoryPolling ??= this.#pollFactory().finally(() => {
      this.#factoryPolling = undefined;
    });
    return this.#factoryPolling;
  }

  async #pollFactory(): Promise<void> {
    const scopes = this.#scopes();
    if (scopes.size === 0 || this.#closed || !this.#factory.configured) return;
    const poll = ++this.#factoryPolls;
    let summaries: WorkOrderSummary[];
    try {
      summaries = await this.#factory.list();
    } catch (error) {
      if (this.#factoryFailures++ === 0) log.warn("Couldn't read the work orders in Software Factory; trying again", { error: errorText(error) });
      if (this.#needsLookup() || this.#anyActive()) {
        this.#scheduleFactoryPoll(Math.min(MAX_FACTORY_BACKOFF_MS, this.#config.factoryPollMs * 2 ** Math.min(this.#factoryFailures, 4)));
      }
      return;
    }
    this.#factoryFailures = 0;
    // A simulation or ticket that ended while the list was read no longer counts.
    const current = this.#scopes();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    for (const [key, routing] of [...this.#routings]) {
      const summary = byId.get(routing.workOrder.workOrderId);
      if (!current.has(routing.scope)) this.#routings.delete(key);
      else if (summary) this.#routings.set(key, { ...routing, workOrder: this.#routed(summary), poll });
      else if (routing.poll < poll) {
        // Known before this poll started, and not listed: deleted in Software Factory. The issue can be sent again.
        this.#routings.delete(key);
        log.info("A software issue's work order is no longer in Software Factory", { key, workOrder: workOrderName(routing.workOrder.number) });
      }
    }
    // Newest first: a key's latest work order wins.
    for (const summary of summaries) {
      const parsed = summary.origin?.app === "help-desk" && summary.origin.key ? parseIssueKey(summary.origin.key) : undefined;
      if (!parsed || !current.has(parsed.scope)) continue;
      const key = issueKey(parsed.scope, parsed.area);
      if (!this.#routings.has(key)) this.#routings.set(key, { workOrder: this.#routed(summary), scope: parsed.scope, poll });
    }
    const found = [...scopes].filter((scope) => current.has(scope) && !this.#lookedUp.has(scope));
    for (const scope of found) this.#lookedUp.add(scope);
    const recovered = [...this.#routings.values()].filter((routing) => found.includes(routing.scope)).length;
    if (recovered > 0) log.info("Found sent issues' work orders in Software Factory", { workOrders: recovered });
    this.#updateIssues();
    if (this.#anyActive()) this.#scheduleFactoryPoll();
  }

  #scheduleFactoryPoll(delay = this.#config.factoryPollMs): void {
    if (this.#factoryTimer || this.#closed || !this.#factory.configured || this.#scopes().size === 0) return;
    this.#factoryTimer = setTimeout(() => {
      this.#factoryTimer = undefined;
      void this.pollFactory();
    }, delay);
    this.#factoryTimer.unref?.();
  }

  #stopFactoryPolls(): void {
    if (this.#factoryTimer) clearTimeout(this.#factoryTimer);
    this.#factoryTimer = undefined;
    this.#factoryFailures = 0;
  }

  // ─── The platform ──────────────────────────────────────────────────────────────────────────────────────────

  /** After every (re)connection: sessions on the previous client are gone, and Help Desk may have restarted. */
  sync(): Promise<void> {
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      do {
        this.#syncAgain = false;
        await this.#sync();
      } while (this.#syncAgain);
    })().finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    for (const ticket of this.#allTickets()) ticket.detach();
    let sessions: SessionInfo[];
    try {
      sessions = (await this.platform.listSessions()).filter((session) => !gone(session));
    } catch (error) {
      return log.warn("Couldn't list the help desk's sessions", { error: errorText(error) });
    }
    const adopting = !this.#run;
    if (adopting) this.#adopt(sessions);
    this.#adoptPlayers(sessions);
    this.#pickingUp = false;
    const run = this.#run;
    void this.#deleteLeftovers(sessions);
    const existing = new Set(sessions.map((session) => session.id));
    await eachLimited(this.#allTickets(), 6, async (ticket) => {
      // Being started right now: its start finishes on its own.
      if (ticket.pending) return;
      if (!existing.has(ticket.sessionId)) {
        if (ticket.created) this.#dropTicket(ticket);
        return;
      }
      if ((await ticket.attach()) === "gone") this.#dropTicket(ticket);
    });
    // Refunds and cancellations live in the sessions' histories: apply them to the store (each only once). A player's
    // ticket applies its own when its conversation is read.
    if (run && this.#run === run) {
      for (const ticket of this.#tickets.values()) {
        for (const effect of ticket.effects()) {
          if (effect.tool === "request_refund") this.shop.refund(ticket.customer.id, effect.args["orderId"], effect.args["amount"], effect.id);
          else this.shop.cancel(ticket.customer.id, effect.args["orderId"], effect.id);
        }
      }
    }
    this.#publishRun();
    if (adopting) for (const ticket of this.#tickets.values()) this.#classify(ticket, customerText(ticket) || ticket.customer.opening);
    this.#publishPlayers();
    // A picked-up simulation's or ticket's issues may have been sent to Software Factory before the restart.
    if (this.#needsLookup()) void this.pollFactory();
    await this.#poll();
  }

  /** Picks up the latest simulation left on the platform. */
  #adopt(sessions: readonly SessionInfo[]): void {
    const runs = new Map<string, string[]>();
    for (const session of sessions) {
      const parsed = parseSessionId(session.id);
      if (parsed && CUSTOMERS.some((customer) => customer.id === parsed.customerId)) runs.set(parsed.runId, [...(runs.get(parsed.runId) ?? []), parsed.customerId]);
    }
    const latest = [...runs.keys()].sort((a, b) => (runStartedAt(b)?.getTime() ?? 0) - (runStartedAt(a)?.getTime() ?? 0))[0];
    const startedAt = latest ? runStartedAt(latest) : undefined;
    if (!latest || !startedAt) return;
    const customers = new Set(runs.get(latest));
    this.shop.reset(startedAt);
    this.#run = { id: latest, size: customers.size, startedAt };
    for (const customer of CUSTOMERS) if (customers.has(customer.id)) this.#tickets.set(customer.id, new CustomerTicket(this, customer, sessionIdFor(latest, customer.id), true));
    log.info("Picked up the latest simulation from Managed Copilot", { run: latest, sessions: customers.size });
  }

  /** Picks up every player ticket left on the platform: their checkouts are read back from their conversations. */
  #adoptPlayers(sessions: readonly SessionInfo[]): void {
    let found = 0;
    for (const session of sessions) {
      const ticketId = parsePlayerSessionId(session.id);
      if (!ticketId || this.#players.has(ticketId)) continue;
      this.#players.set(ticketId, new PlayerTicketSession(this, ticketId));
      found += 1;
    }
    if (found > 0) log.info("Picked up player tickets from Managed Copilot", { tickets: found });
  }

  #dropTicket(ticket: TicketSession): void {
    if (ticket instanceof PlayerTicketSession) {
      log.info("A player's session no longer exists", { player: ticket.ticketId });
      this.#removePlayer(ticket);
      return;
    }
    ticket.close();
    if (ticket instanceof CustomerTicket) {
      if (this.#tickets.get(ticket.customer.id) === ticket) this.#tickets.delete(ticket.customer.id);
      log.info("A customer's session no longer exists", { customer: ticket.customer.id });
    }
  }

  /** Reads the tickets' session records (placement and sandbox) for the counters. */
  async #poll(): Promise<void> {
    if ((!this.#run && this.#players.size === 0) || this.platform.status.state !== "connected") return;
    try {
      const sessions = await this.platform.listSessions();
      const ids = new Set(this.#allTickets().map((ticket) => ticket.sessionId));
      this.#records = new Map(sessions.filter((session) => ids.has(session.id) && !gone(session)).map((session) => [session.id, session]));
      this.#updateCounters();
    } catch (error) {
      log.debug("Couldn't list sessions for the counters", { error: errorText(error) });
    }
  }

  /** The wall's counters: sessions and messages from the tickets, runtimes and sandboxes from the platform's records. */
  computeCounters(): Counters {
    const sessions = this.#allTickets().filter((ticket) => ticket.created);
    let shared = 0;
    let sandboxed = 0;
    let sandboxes = 0;
    for (const ticket of sessions) {
      const record = this.#records.get(ticket.sessionId);
      if ((record?.placement ?? this.platform.placement) === "sandbox") sandboxed += 1;
      else shared += 1;
      if (record?.sandbox) sandboxes += 1;
    }
    const premium = sessions.reduce((sum, ticket) => sum + (ticket.premiumRequests ?? 0), 0);
    return {
      sessions: sessions.length,
      runtimes: (shared > 0 ? 1 : 0) + sandboxed,
      sandboxes,
      messages: sessions.reduce((sum, ticket) => sum + ticket.messageCount, 0),
      premiumRequests: Math.round(premium * 100) / 100,
    };
  }

  #updateCounters(): void {
    const next = this.computeCounters();
    const current = this.#counters;
    if (Object.keys(next).every((key) => next[key as keyof Counters] === current[key as keyof Counters])) return;
    this.#counters = next;
    this.#publish({ type: "counters", counters: next });
  }

  /** Publishes the software issues when they changed. */
  #updateIssues(): void {
    const issues = this.issues();
    const json = JSON.stringify(issues);
    if (json === this.#issuesJson) return;
    this.#issuesJson = json;
    this.#publish({ type: "issues", issues });
  }

  #publishRun(): void {
    const run = this.#runInfo();
    const issues = this.issues();
    this.#issuesJson = JSON.stringify(issues);
    this.#publish({ type: "run", ...(run ? { run } : {}), tickets: this.#views(), issues });
  }

  #publishPlayers(): void {
    // The list would leave out tickets not picked up yet, and their chat pages would take that as ended.
    if (this.#pickingUp) return;
    this.#publish({ type: "players", players: this.#playerViews() });
  }

  #clearTimer(ticket: TicketSession): void {
    const timer = this.#ticketTimers.get(ticket.sessionId);
    if (timer) clearTimeout(timer);
    this.#ticketTimers.delete(ticket.sessionId);
  }

  // TicketHost

  knowledgePrompt(): string {
    return this.knowledge.prompt();
  }

  async remember(ticket: CustomerTicket, memory: StoredMemory): Promise<void> {
    let proposal: MemoryProposal | undefined;
    try {
      proposal = this.knowledge.propose({ ...memory, customerId: ticket.customer.id, customerName: ticket.customer.name, sessionId: ticket.sessionId });
    } catch (error) {
      // The runtime fails the agent's store_memory call: nothing was kept.
      log.error("Couldn't keep a proposed fact", { customer: ticket.customer.id, error: errorText(error) });
      throw error;
    }
    if (!proposal) return;
    log.info("An agent proposed a fact for the team knowledge base", { customer: ticket.customer.id, subject: proposal.subject });
    this.#publishKnowledge();
    this.changed(ticket);
  }

  knownIssuesPrompt(person: "customer" | "player"): string {
    return this.knownIssues.prompt(person);
  }

  proposeKnownIssue(ticket: CustomerTicket, report: KnownIssueReport): ToolResult {
    const known = this.knownIssues.titled(report.title);
    if (known) return { ok: true, alreadyKnown: true, update: known.update };
    let proposal: MemoryProposal | undefined;
    try {
      proposal = this.knowledge.propose({
        kind: "known-issue",
        subject: report.title,
        fact: report.update,
        symptoms: report.symptoms,
        customerId: ticket.customer.id,
        customerName: ticket.customer.name,
        sessionId: ticket.sessionId,
      });
    } catch (error) {
      log.error("Couldn't keep a proposed known issue", { customer: ticket.customer.id, error: errorText(error) });
      return { ok: false, error: "The known issue couldn't be kept right now." };
    }
    if (proposal) {
      log.info("An agent proposed a known issue", { customer: ticket.customer.id, title: proposal.subject });
      this.#publishKnowledge();
      this.changed(ticket);
    }
    return { ok: true, sentTo: "a support team member, who records it for the whole desk" };
  }

  proposal(ticket: CustomerTicket): MemoryProposal | undefined {
    return this.knowledge.proposals().find((proposal) => proposal.source.sessionId === ticket.sessionId);
  }

  changed(ticket: TicketSession): void {
    const key = ticket.sessionId;
    if (!this.#ticketTimers.has(key)) {
      const timer = setTimeout(() => {
        this.#ticketTimers.delete(key);
        if (ticket instanceof PlayerTicketSession) {
          if (this.#players.get(ticket.ticketId) === ticket) this.#publish({ type: "player", ticket: this.#playerView(ticket) });
        } else if (ticket instanceof CustomerTicket && this.#tickets.get(ticket.customer.id) === ticket) {
          this.#publish({ type: "ticket", ticket: this.#view(ticket) });
        }
      }, PUBLISH_MS);
      timer.unref?.();
      this.#ticketTimers.set(key, timer);
    }
    if (!this.#countersTimer) {
      // The counters and the issues follow the tickets, a little behind.
      this.#countersTimer = setTimeout(() => {
        this.#countersTimer = undefined;
        this.#updateCounters();
        this.#updateIssues();
      }, COUNTERS_MS);
      this.#countersTimer.unref?.();
    }
  }
}
