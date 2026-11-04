// The help desk: the current simulation's tickets, one session per customer on the shared runtime, and the counters
// the wall shows. Sessions are named after their simulation and customer, so after a restart Help Desk adopts the
// latest simulation from the platform, rebuilds each conversation from its history, and deletes older leftovers.
import type { SessionInfo } from "@managed-copilot/sdk";
import { SIMULATION_SIZES, type Counters, type DeskInfo, type HelpDeskState, type RunInfo, type ServerEvent, type Ticket } from "../shared/types.js";
import type { HelpDeskConfig } from "./config.js";
import { HelpDeskError, errorText, isMissingSession } from "./errors.js";
import { log } from "./log.js";
import type { DeskPlatform } from "./platform.js";
import { CUSTOMERS } from "./seed.js";
import { Shop } from "./shop.js";
import { parseSessionId, sessionIdFor, TicketSession, type TicketHost } from "./ticket.js";
import { TOOLS } from "./tools.js";

const PUBLISH_MS = 150;
const COUNTERS_MS = 300;
const MAX_MESSAGE = 2_000;

interface Run {
  readonly id: string;
  readonly size: number;
  readonly startedAt: Date;
  ending?: boolean;
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

const gone = (session: SessionInfo) => session.state === "deleting" || session.state === "deleted";

export class HelpDesk implements TicketHost {
  readonly platform: DeskPlatform;
  readonly shop = new Shop();
  readonly #config: HelpDeskConfig;
  readonly #publish: (event: ServerEvent) => void;
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

  constructor(platform: DeskPlatform, config: HelpDeskConfig, publish: (event: ServerEvent) => void) {
    this.platform = platform;
    this.#config = config;
    this.#publish = publish;
  }

  start(): void {
    this.#unsubscribe.push(
      this.platform.onConnected(() => void this.sync()),
      this.platform.onStatus(() => this.#publish({ type: "platform", platform: this.platform.status, desk: this.desk() })),
    );
    this.#pollTimer = setInterval(() => void this.#poll(), this.#config.countersIntervalMs);
    this.#pollTimer.unref?.();
  }

  /** Lets go of every session (Help Desk is shutting down); the sessions stay on the platform. */
  close(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    for (const timer of [...this.#ticketTimers.values(), ...this.#startTimers]) clearTimeout(timer);
    this.#ticketTimers.clear();
    this.#startTimers.clear();
    if (this.#countersTimer) clearTimeout(this.#countersTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    for (const ticket of this.#tickets.values()) ticket.close();
  }

  desk(): DeskInfo {
    return { environment: this.#config.environment, ...(this.platform.model ? { model: this.platform.model } : {}), tools: TOOLS };
  }

  #runInfo(): RunInfo | undefined {
    const run = this.#run;
    return run ? { id: run.id, size: run.size, startedAt: run.startedAt.toISOString(), ...(run.ending ? { ending: true } : {}) } : undefined;
  }

  #views(): Ticket[] {
    return [...this.#tickets.values()].map((ticket) => ticket.view());
  }

  state(): HelpDeskState {
    const run = this.#runInfo();
    return {
      platform: this.platform.status,
      desk: this.desk(),
      customers: this.shop.customers(),
      ...(run ? { run } : {}),
      tickets: this.#views(),
      counters: this.#counters,
    };
  }

  /** What a browser gets when it connects to the event stream. */
  initialEvents(): ServerEvent[] {
    const run = this.#runInfo();
    return [
      { type: "platform", platform: this.platform.status, desk: this.desk() },
      { type: "run", ...(run ? { run } : {}), tickets: this.#views() },
      { type: "counters", counters: this.#counters },
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

  /** Ends the current simulation, then starts `size` customers' sessions in a quick wave. */
  simulate(size: number): Promise<RunInfo> {
    if (!(SIMULATION_SIZES as readonly number[]).includes(size)) throw new HelpDeskError("invalid_request", `Simulate ${SIMULATION_SIZES.join(", ")} customers.`);
    this.#requireConnected();
    return this.#exclusive(async () => {
      await this.#endRun();
      const startedAt = new Date();
      const run: Run = { id: runIdAt(startedAt), size, startedAt };
      this.shop.reset(startedAt);
      this.#run = run;
      this.#records = new Map();
      const customers = CUSTOMERS.slice(0, size);
      for (const customer of customers) this.#tickets.set(customer.id, new TicketSession(this, customer, sessionIdFor(run.id, customer.id)));
      this.#publishRun();
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
    this.#records = new Map();
    this.#run = undefined;
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
    return this.#require(customerId).view();
  }

  async send(customerId: string, text: unknown): Promise<void> {
    this.#requireConnected();
    const message = typeof text === "string" ? text.trim() : "";
    if (!message) throw new HelpDeskError("invalid_request", "Write a message first.");
    if (message.length > MAX_MESSAGE) throw new HelpDeskError("invalid_request", `Keep messages under ${MAX_MESSAGE.toLocaleString("en-US")} characters.`);
    await this.#require(customerId).send(message);
  }

  answer(customerId: string, approvalId: string, approve: boolean): void {
    this.#require(customerId).answer(approvalId, approve);
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
    if (!this.#run) this.#adopt(sessions);
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

  #publishRun(): void {
    const run = this.#runInfo();
    this.#publish({ type: "run", ...(run ? { run } : {}), tickets: this.#views() });
  }

  // TicketHost

  changed(ticket: TicketSession): void {
    const id = ticket.customer.id;
    if (!this.#ticketTimers.has(id)) {
      const timer = setTimeout(() => {
        this.#ticketTimers.delete(id);
        if (this.#tickets.get(id) === ticket) this.#publish({ type: "ticket", ticket: ticket.view() });
      }, PUBLISH_MS);
      timer.unref?.();
      this.#ticketTimers.set(id, timer);
    }
    if (!this.#countersTimer) {
      this.#countersTimer = setTimeout(() => {
        this.#countersTimer = undefined;
        this.#updateCounters();
      }, COUNTERS_MS);
      this.#countersTimer.unref?.();
    }
  }
}
