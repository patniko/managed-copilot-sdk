// The help desk: the current simulation's tickets, one session per customer on the shared runtime, and the counters
// the wall shows. Sessions are named after their simulation and customer, so after a restart Help Desk adopts the
// latest simulation from the platform, rebuilds each conversation from its history, and deletes older leftovers.
// Problems with the store's website the agents report are grouped into software issues, which the operator sends to
// Software Factory; each work order's origin carries the simulation and area, so a restart finds them again.
// Facts the agents propose wait in the team knowledge base until the operator adds or declines them, outside the agents'
// turns; added facts outlive simulations and are part of every later session's instructions.
import type { StoredMemory } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import {
  SIMULATION_SIZES,
  type BugArea,
  type ClassificationRun,
  type Counters,
  type DeskInfo,
  type HelpDeskState,
  type KnowledgeEntry,
  type MemoryProposal,
  type RoutedWorkOrder,
  type RunInfo,
  type ServerEvent,
  type SoftwareIssue,
  type Ticket,
  type TicketTriage,
  type WorkOrderStatus,
} from "../shared/types.js";
import type { HelpDeskConfig } from "./config.js";
import { HelpDeskError, errorText, isMissingSession } from "./errors.js";
import { FACTORY_NOT_CONNECTED, readProject, SoftwareFactory, workOrderName, workOrderUrl, type FactoryClient, type WorkOrderSummary } from "./factory.js";
import { KnowledgeBase } from "./knowledge.js";
import { groupIssues, isBugArea, issueKey, issueWorkOrder, type Reported, type ReportedConversation } from "./issues.js";
import { log } from "./log.js";
import type { DeskPlatform } from "./platform.js";
import { CUSTOMERS } from "./seed.js";
import { Shop } from "./shop.js";
import { parseSessionId, sessionIdFor, TicketSession, type TicketHost } from "./ticket.js";
import { TOOLS } from "./tools.js";
import { Triage } from "./triage.js";

const PUBLISH_MS = 150;
const COUNTERS_MS = 300;
const MAX_MESSAGE = 2_000;
/** What classification reads of a conversation: the customer's messages, the latest last, up to this many characters. */
const MAX_TRIAGE_TEXT = 4_000;
/** Work orders Software Factory is still working on. */
const ACTIVE: ReadonlySet<WorkOrderStatus> = new Set(["queued", "planning", "building", "releasing"]);
const MAX_FACTORY_BACKOFF_MS = 60_000;

interface Run {
  readonly id: string;
  readonly size: number;
  readonly startedAt: Date;
  ending?: boolean;
}

/** An issue's work order, and the factory poll it was known by (a later poll that doesn't list it means it's gone). */
interface Routing {
  readonly workOrder: RoutedWorkOrder;
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
function customerText(ticket: TicketSession): string {
  return ticket
    .view()
    .items.flatMap((item) => (item.kind === "message" && item.from === "customer" ? [item.text] : []))
    .join("\n\n");
}

const gone = (session: SessionInfo) => session.state === "deleting" || session.state === "deleted";

/** The area of the simulation's issue a work order was made of, if it's one of Help Desk's for that simulation. */
function areaOf(summary: WorkOrderSummary, runId: string): BugArea | undefined {
  const key = summary.origin?.app === "help-desk" ? summary.origin.key : undefined;
  const area = key?.startsWith(`${runId}:`) ? key.slice(runId.length + 1) : undefined;
  return area && isBugArea(area) ? area : undefined;
}

export class HelpDesk implements TicketHost {
  readonly platform: DeskPlatform;
  readonly shop = new Shop();
  readonly knowledge: KnowledgeBase;
  readonly #config: HelpDeskConfig;
  readonly #publish: (event: ServerEvent) => void;
  readonly #factory: FactoryClient;
  #run: Run | undefined;
  /** By customer ID, in the store's customer order. */
  readonly #tickets = new Map<string, TicketSession>();
  /** The platform's records of the run's sessions: placement and sandbox. */
  #records = new Map<string, SessionInfo>();
  #counters: Counters = { sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 };
  readonly #ticketTimers = new Map<string, NodeJS.Timeout>();
  readonly #startTimers = new Set<NodeJS.Timeout>();
  #countersTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #operation: Promise<unknown> | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  readonly #unsubscribe: (() => void)[] = [];
  /** The run's issues sent to Software Factory, by area. */
  readonly #routings = new Map<BugArea, Routing>();
  /** Issues being sent right now, by issue key. */
  readonly #sending = new Set<string>();
  /** The issues as last published. */
  #issuesJson = "[]";
  /** Polls of Software Factory started so far. */
  #factoryPolls = 0;
  #factoryPolling: Promise<void> | undefined;
  #factoryTimer: NodeJS.Timeout | undefined;
  #factoryFailures = 0;
  /** The run whose work orders were looked up in Software Factory: a new run has none, an adopted one may. */
  #lookedUp: string | undefined;
  #closed = false;
  readonly #triage: Triage;
  /** The run's classifications, by customer ID. */
  readonly #triaged = new Map<string, TicketTriage>();
  /** The latest Classify, until a simulation starts. */
  #classification: ClassificationRun | undefined;

  constructor(
    platform: DeskPlatform,
    config: HelpDeskConfig,
    publish: (event: ServerEvent) => void,
    factory: FactoryClient = new SoftwareFactory(config.factoryUrl, config.factoryPublicUrl),
    triage: Triage = new Triage(),
  ) {
    this.platform = platform;
    this.#config = config;
    this.#publish = publish;
    this.#factory = factory;
    this.knowledge = new KnowledgeBase(config.dataDir);
    this.#triage = triage;
  }

  start(): void {
    this.#unsubscribe.push(
      this.platform.onConnected(() => void this.sync()),
      this.platform.onStatus(() => this.#publish({ type: "platform", platform: this.platform.status, desk: this.desk() })),
      this.#triage.onChange(() => this.#publish({ type: "platform", platform: this.platform.status, desk: this.desk() })),
    );
    this.#pollTimer = setInterval(() => void this.#poll(), this.#config.countersIntervalMs);
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
    for (const ticket of this.#tickets.values()) ticket.close();
  }

  desk(): DeskInfo {
    const factory = { configured: this.#factory.configured, ...(this.#factory.configured && this.#factory.publicUrl ? { url: this.#factory.publicUrl } : {}) };
    return { environment: this.#config.environment, ...(this.platform.model ? { model: this.platform.model } : {}), tools: TOOLS, factory, triage: this.#triage.status };
  }

  #runInfo(): RunInfo | undefined {
    const run = this.#run;
    return run ? { id: run.id, size: run.size, startedAt: run.startedAt.toISOString(), ...(run.ending ? { ending: true } : {}) } : undefined;
  }

  #views(): Ticket[] {
    return [...this.#tickets.values()].map((ticket) => this.#view(ticket));
  }

  /** A ticket as the wall shows it: its conversation, and its classification. */
  #view(ticket: TicketSession): Ticket {
    const triage = this.#triaged.get(ticket.customer.id);
    return { ...ticket.view(), ...(triage ? { triage } : {}) };
  }

  /** Classifies a customer's conversation (`text`: the customer's messages), when classification is set up. */
  #classify(ticket: TicketSession, text: string): void {
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

  /** The run's software issues: its tickets' bug reports by area, and the work orders sent for them. */
  issues(): SoftwareIssue[] {
    const reports: Reported[] = [];
    for (const ticket of this.#tickets.values()) {
      const bug = ticket.bug;
      if (bug) reports.push({ customerId: ticket.customer.id, name: ticket.customer.name, bug });
    }
    return groupIssues(reports, new Map([...this.#routings].map(([area, routing]) => [area, routing.workOrder])));
  }

  state(): HelpDeskState {
    const run = this.#runInfo();
    return {
      platform: this.platform.status,
      desk: this.desk(),
      customers: this.shop.customers(),
      ...(run ? { run } : {}),
      tickets: this.#views(),
      ...(this.#classification ? { classification: this.#classification } : {}),
      issues: this.issues(),
      counters: this.#counters,
      knowledge: this.knowledge.list(),
      proposals: this.knowledge.proposals(),
    };
  }

  /** What a browser gets when it connects to the event stream. */
  initialEvents(): ServerEvent[] {
    const run = this.#runInfo();
    return [
      { type: "platform", platform: this.platform.status, desk: this.desk() },
      { type: "run", ...(run ? { run } : {}), tickets: this.#views(), issues: this.issues() },
      { type: "classification", ...(this.#classification ? { classification: this.#classification } : {}) },
      { type: "counters", counters: this.#counters },
      this.#knowledgeEvent(),
    ];
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

  /**
   * Classifies the first `size` customers' opening messages without starting their sessions, all at once, publishing
   * each result as it arrives and the time the whole lot took. Replaces the previous Classify; not during a simulation.
   */
  classifyOpenings(size: number): ClassificationRun {
    if (!(SIMULATION_SIZES as readonly number[]).includes(size)) throw new HelpDeskError("invalid_request", `Classify ${SIMULATION_SIZES.join(", ")} customers.`);
    if (!this.#triage.enabled) throw new HelpDeskError("classification_off", "Ticket classification isn't set up. Help Desk's README shows how to turn it on.", 409);
    if (this.#run || this.#operation) throw new HelpDeskError("busy", "End the simulation first: Classify reads the customers' first messages without starting their sessions.", 409);
    if (!this.#triage.connected) throw new HelpDeskError("classification_unavailable", "The triage environment isn't connected yet.", 503);
    const startedAt = new Date();
    const started = performance.now();
    const customers = CUSTOMERS.slice(0, size);
    let current: ClassificationRun = {
      id: runIdAt(startedAt),
      size,
      startedAt: startedAt.toISOString(),
      results: Object.fromEntries(customers.map((customer) => [customer.id, { state: "classifying" } satisfies TicketTriage])),
    };
    this.#classification = current;
    this.#publish({ type: "classification", classification: current });
    for (const customer of customers) {
      void this.#triage.classify(customer.opening).then(
        (result): TicketTriage => ({ state: "done", category: result.category, urgent: result.urgent }),
        (error: unknown): TicketTriage => ({ state: "failed", message: errorText(error) }),
      ).then((triage) => {
        // A simulation or a newer Classify replaced this one.
        if (this.#classification !== current) return;
        const results = { ...current.results, [customer.id]: triage };
        const finished = Object.values(results).every((result) => result.state !== "classifying");
        current = { ...current, results, ...(finished ? { elapsedMs: Math.round(performance.now() - started) } : {}) };
        this.#classification = current;
        if (finished) log.info("Classified the customers' first messages", { customers: size, ms: current.elapsedMs });
        this.#publish({ type: "classification", classification: current });
      });
    }
    return current;
  }

  /** Ends the current simulation, then starts `size` customers' sessions in a quick wave. */
  simulate(size: number): Promise<RunInfo> {
    if (!(SIMULATION_SIZES as readonly number[]).includes(size)) throw new HelpDeskError("invalid_request", `Simulate ${SIMULATION_SIZES.join(", ")} customers.`);
    this.#requireConnected();
    return this.#exclusive(async () => {
      await this.#endRun();
      if (this.#classification) {
        this.#classification = undefined;
        this.#publish({ type: "classification" });
      }
      const startedAt = new Date();
      const run: Run = { id: runIdAt(startedAt), size, startedAt };
      this.shop.reset(startedAt);
      this.#run = run;
      this.#records = new Map();
      // A new simulation has no work orders in Software Factory yet.
      this.#lookedUp = run.id;
      const customers = CUSTOMERS.slice(0, size);
      for (const customer of customers) this.#tickets.set(customer.id, new TicketSession(this, customer, sessionIdFor(run.id, customer.id)));
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

  /** Ends the simulation: deletes its sessions. */
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
    for (const timer of this.#ticketTimers.values()) clearTimeout(timer);
    this.#ticketTimers.clear();
    this.#tickets.clear();
    this.#triaged.clear();
    this.#records = new Map();
    this.#run = undefined;
    // Software Factory keeps the work orders; the next simulation starts with no issues.
    this.#routings.clear();
    this.#lookedUp = undefined;
    this.#stopFactoryPolls();
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

  /** Sessions of earlier simulations that weren't deleted (Help Desk stopped while they ran). */
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

  #require(customerId: string): TicketSession {
    const ticket = this.#tickets.get(customerId);
    if (!ticket) throw new HelpDeskError("not_found", "That customer isn't in the current simulation.", 404);
    return ticket;
  }

  ticket(customerId: string): Ticket {
    return this.#view(this.#require(customerId));
  }

  async send(customerId: string, text: unknown): Promise<void> {
    this.#requireConnected();
    const message = typeof text === "string" ? text.trim() : "";
    if (!message) throw new HelpDeskError("invalid_request", "Write a message first.");
    if (message.length > MAX_MESSAGE) throw new HelpDeskError("invalid_request", `Keep messages under ${MAX_MESSAGE.toLocaleString("en-US")} characters.`);
    const ticket = this.#require(customerId);
    const said = customerText(ticket);
    await ticket.send(message);
    this.#classify(ticket, said ? `${said}\n\n${message}` : message);
  }

  /** The operator's answer to a refund, a cancellation, or a fact the customer's agent proposed. */
  answer(customerId: string, approvalId: string, approve: boolean): void {
    const ticket = this.#require(customerId);
    const proposal = this.knowledge.proposal(approvalId);
    if (proposal && proposal.source.sessionId === ticket.sessionId) this.decide(approvalId, approve);
    else ticket.answer(approvalId, approve);
  }

  /** Adds a proposed fact to the team knowledge base, or declines it. The agent that proposed it is never told. */
  decide(id: string, add: boolean): void {
    const proposal = this.knowledge.proposal(id);
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

  /**
   * Sends a software issue to Software Factory: a work order to fix the storefront, once per simulation and area. A
   * failed send can be tried again. `appUrl` is Help Desk's address as the operator uses it, for the link back.
   */
  async routeIssue(area: string, appUrl: string): Promise<SoftwareIssue> {
    if (!isBugArea(area)) throw new HelpDeskError("not_found", "There's no such software issue.", 404);
    if (!this.#factory.configured) throw new HelpDeskError("factory_unavailable", FACTORY_NOT_CONNECTED, 503);
    const run = this.#run;
    if (!run || run.ending) throw new HelpDeskError("not_found", "No simulation is running: software issues come from its conversations.", 404);
    const reports = this.#conversations(area);
    if (reports.length === 0) throw new HelpDeskError("not_found", "No customer of this simulation has reported this problem.", 404);
    const sent = this.#routings.get(area)?.workOrder;
    if (sent) throw new HelpDeskError("conflict", `This issue was sent to Software Factory already, as ${workOrderName(sent.number)}.`, 409);
    const key = issueKey(run.id, area);
    if (this.#sending.has(key)) throw new HelpDeskError("conflict", "This issue is being sent to Software Factory right now.", 409);
    this.#sending.add(key);
    try {
      // Sent before Help Desk restarted, while Software Factory couldn't be asked: it isn't sent twice.
      const existing = (await this.#factory.list()).find((summary) => areaOf(summary, run.id) === area);
      if (existing) {
        if (this.#run === run) this.#track(area, existing);
        throw new HelpDeskError("conflict", `This issue was sent to Software Factory already, as ${workOrderName(existing.number)}.`, 409);
      }
      const request = issueWorkOrder({ area, runId: run.id, appUrl, reports, project: await readProject(this.#config.storefrontDir) });
      const created = await this.#factory.create(request);
      log.info("Sent a software issue to Software Factory", { area, workOrder: workOrderName(created.number), reports: reports.length });
      if (this.#run !== run) throw new HelpDeskError("conflict", `The simulation ended while the issue was being sent. Software Factory has it as ${workOrderName(created.number)}.`, 409);
      this.#track(area, created);
      return this.issues().find((issue) => issue.area === area)!;
    } finally {
      this.#sending.delete(key);
    }
  }

  /** The run's tickets that reported a problem in `area`, with their conversations. */
  #conversations(area: string): ReportedConversation[] {
    return [...this.#tickets.values()].flatMap((ticket) => {
      const view = ticket.view();
      return view.bug?.area === area ? [{ customerId: ticket.customer.id, name: ticket.customer.name, bug: view.bug, items: view.items }] : [];
    });
  }

  #routed(summary: WorkOrderSummary): RoutedWorkOrder {
    const url = workOrderUrl(this.#factory.publicUrl ?? "", summary.id);
    return { workOrderId: summary.id, number: summary.number, title: summary.title, status: summary.status, url, ...(summary.error ? { error: summary.error.message } : {}) };
  }

  /** Follows an issue's work order from now on. */
  #track(area: BugArea, summary: WorkOrderSummary): void {
    this.#routings.set(area, { workOrder: this.#routed(summary), poll: this.#factoryPolls });
    this.#updateIssues();
    this.#scheduleFactoryPoll();
  }

  #anyActive(): boolean {
    return [...this.#routings.values()].some((routing) => ACTIVE.has(routing.workOrder.status));
  }

  /** Reads Software Factory's work orders: the status of the run's own, and (after a restart) which issues were sent. */
  pollFactory(): Promise<void> {
    this.#factoryPolling ??= this.#pollFactory().finally(() => {
      this.#factoryPolling = undefined;
    });
    return this.#factoryPolling;
  }

  async #pollFactory(): Promise<void> {
    const run = this.#run;
    if (!run || this.#closed || !this.#factory.configured) return;
    const poll = ++this.#factoryPolls;
    let summaries: WorkOrderSummary[];
    try {
      summaries = await this.#factory.list();
    } catch (error) {
      if (this.#factoryFailures++ === 0) log.warn("Couldn't read the work orders in Software Factory; trying again", { error: errorText(error) });
      if (this.#run === run && (this.#lookedUp !== run.id || this.#anyActive())) {
        this.#scheduleFactoryPoll(Math.min(MAX_FACTORY_BACKOFF_MS, this.#config.factoryPollMs * 2 ** Math.min(this.#factoryFailures, 4)));
      }
      return;
    }
    this.#factoryFailures = 0;
    if (this.#run !== run) return;
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    for (const [area, routing] of [...this.#routings]) {
      const summary = byId.get(routing.workOrder.workOrderId);
      if (summary) this.#routings.set(area, { workOrder: this.#routed(summary), poll });
      else if (routing.poll < poll) {
        // Known before this poll started, and not listed: deleted in Software Factory. The issue can be sent again.
        this.#routings.delete(area);
        log.info("A software issue's work order is no longer in Software Factory", { area, workOrder: workOrderName(routing.workOrder.number) });
      }
    }
    // Newest first: an area's latest work order wins.
    for (const summary of summaries) {
      const area = areaOf(summary, run.id);
      if (area && !this.#routings.has(area)) this.#routings.set(area, { workOrder: this.#routed(summary), poll });
    }
    if (this.#lookedUp !== run.id) {
      this.#lookedUp = run.id;
      if (this.#routings.size > 0) log.info("Found the simulation's work orders in Software Factory", { run: run.id, workOrders: this.#routings.size });
    }
    this.#updateIssues();
    if (this.#anyActive()) this.#scheduleFactoryPoll();
  }

  #scheduleFactoryPoll(delay = this.#config.factoryPollMs): void {
    if (this.#factoryTimer || this.#closed || !this.#factory.configured || !this.#run) return;
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
    for (const ticket of this.#tickets.values()) ticket.detach();
    let sessions: SessionInfo[];
    try {
      sessions = (await this.platform.listSessions()).filter((session) => !gone(session));
    } catch (error) {
      return log.warn("Couldn't list the help desk's sessions", { error: errorText(error) });
    }
    const adopting = !this.#run;
    if (adopting) this.#adopt(sessions);
    const run = this.#run;
    void this.#deleteLeftovers(sessions);
    if (!run) return;
    const existing = new Set(sessions.map((session) => session.id));
    await eachLimited([...this.#tickets.values()], 6, async (ticket) => {
      // Being started right now: its start finishes on its own.
      if (ticket.pending) return;
      if (!existing.has(ticket.sessionId)) {
        if (ticket.created) this.#dropTicket(ticket);
        return;
      }
      if ((await ticket.attach()) === "gone") this.#dropTicket(ticket);
    });
    // Refunds and cancellations live in the sessions' histories: apply them to the store (each only once).
    for (const ticket of this.#tickets.values()) {
      for (const effect of ticket.effects()) {
        if (effect.tool === "request_refund") this.shop.refund(ticket.customer.id, effect.args["orderId"], effect.args["amount"], effect.id);
        else this.shop.cancel(ticket.customer.id, effect.args["orderId"], effect.id);
      }
    }
    this.#publishRun();
    if (adopting) for (const ticket of this.#tickets.values()) this.#classify(ticket, customerText(ticket) || ticket.customer.opening);
    // An adopted simulation's issues may have been sent to Software Factory before the restart.
    if (this.#lookedUp !== run.id) void this.pollFactory();
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
    for (const customer of CUSTOMERS) if (customers.has(customer.id)) this.#tickets.set(customer.id, new TicketSession(this, customer, sessionIdFor(latest, customer.id), true));
    log.info("Picked up the latest simulation from Managed Copilot", { run: latest, sessions: customers.size });
  }

  #dropTicket(ticket: TicketSession): void {
    ticket.close();
    if (this.#tickets.get(ticket.customer.id) === ticket) this.#tickets.delete(ticket.customer.id);
    log.info("A customer's session no longer exists", { customer: ticket.customer.id });
  }

  /** Reads the run's session records (placement and sandbox) for the counters. */
  async #poll(): Promise<void> {
    if (!this.#run || this.platform.status.state !== "connected") return;
    try {
      const sessions = await this.platform.listSessions();
      const ids = new Set([...this.#tickets.values()].map((ticket) => ticket.sessionId));
      this.#records = new Map(sessions.filter((session) => ids.has(session.id) && !gone(session)).map((session) => [session.id, session]));
      this.#updateCounters();
    } catch (error) {
      log.debug("Couldn't list sessions for the counters", { error: errorText(error) });
    }
  }

  /** The wall's counters: sessions and messages from the tickets, runtimes and sandboxes from the platform's records. */
  computeCounters(): Counters {
    const sessions = [...this.#tickets.values()].filter((ticket) => ticket.created);
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

  /** Publishes the run's software issues when they changed. */
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

  // TicketHost

  knowledgePrompt(): string {
    return this.knowledge.prompt();
  }

  async remember(ticket: TicketSession, memory: StoredMemory): Promise<void> {
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

  proposal(ticket: TicketSession): MemoryProposal | undefined {
    return this.knowledge.proposals().find((proposal) => proposal.source.sessionId === ticket.sessionId);
  }

  changed(ticket: TicketSession): void {
    const id = ticket.customer.id;
    if (!this.#ticketTimers.has(id)) {
      const timer = setTimeout(() => {
        this.#ticketTimers.delete(id);
        if (this.#tickets.get(id) === ticket) this.#publish({ type: "ticket", ticket: this.#view(ticket) });
      }, PUBLISH_MS);
      timer.unref?.();
      this.#ticketTimers.set(id, timer);
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
