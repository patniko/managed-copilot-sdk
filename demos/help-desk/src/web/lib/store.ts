import { useSyncExternalStore } from "react";
import {
  SIMULATION_SIZES,
  type BugArea,
  type ClassificationRun,
  type Counters,
  type CustomerCard,
  type DeskInfo,
  type KnowledgeEntry,
  type MemoryProposal,
  type PlatformStatus,
  type RunInfo,
  type ServerEvent,
  type SimulationSize,
  type SoftwareIssue,
  type Ticket,
} from "../../shared/types.js";
import { api, errorMessage } from "./api.js";

export type Connection = "connecting" | "open" | "reconnecting";

export interface Toast {
  readonly id: number;
  readonly title: string;
  readonly detail?: string;
}

export interface StoreState {
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly connection: Connection;
  readonly platform?: PlatformStatus;
  readonly desk?: DeskInfo;
  readonly customers: readonly CustomerCard[];
  readonly run?: RunInfo;
  /** The current simulation's tickets, by customer ID. */
  readonly tickets: Readonly<Record<string, Ticket>>;
  /** The latest Classify, when there's no simulation since. */
  readonly classification?: ClassificationRun;
  /** The current simulation's software issues. */
  readonly issues: readonly SoftwareIssue[];
  readonly counters: Counters;
  /** The team knowledge base, newest first. */
  readonly knowledge: readonly KnowledgeEntry[];
  /** Facts agents proposed that no one has decided yet, oldest first. */
  readonly proposals: readonly MemoryProposal[];
  /** Facts being removed from the knowledge base from this page, by ID. */
  readonly forgetting: Readonly<Record<string, true>>;
  /** How many customers the next simulation starts (remembered in this browser). */
  readonly size: SimulationSize;
  /** A simulation is being started or ended from this page. */
  readonly working?: "simulate" | "end" | "classify";
  /** Approvals being answered from this page, by approval ID. */
  readonly answering: Readonly<Record<string, true>>;
  /** Issues being sent to Software Factory from this page, by area. */
  readonly routing: Readonly<Partial<Record<BugArea, true>>>;
  readonly toasts: readonly Toast[];
}

const SIZE_KEY = "help-desk.size";
const ZERO: Counters = { sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 };

function savedSize(): SimulationSize {
  try {
    const value = Number(globalThis.localStorage?.getItem(SIZE_KEY));
    return (SIMULATION_SIZES as readonly number[]).includes(value) ? (value as SimulationSize) : 25;
  } catch {
    return 25;
  }
}

let state: StoreState = {
  phase: "loading",
  connection: "connecting",
  customers: [],
  tickets: {},
  issues: [],
  counters: ZERO,
  knowledge: [],
  proposals: [],
  forgetting: {},
  size: savedSize(),
  answering: {},
  routing: {},
  toasts: [],
};
const listeners = new Set<() => void>();

function setState(update: (current: StoreState) => StoreState): void {
  const next = update(state);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribes to a slice of the store. Selectors must return existing references (no new objects or arrays). */
export function useStore<T>(selector: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const byCustomer = (tickets: readonly Ticket[]): Record<string, Ticket> => Object.fromEntries(tickets.map((ticket) => [ticket.customerId, ticket]));

/** Applies one server event. Exported for tests. */
export function reduce(current: StoreState, event: ServerEvent): StoreState {
  switch (event.type) {
    case "platform":
      return { ...current, platform: event.platform, desk: event.desk };
    case "run": {
      const { run: _previous, ...rest } = current;
      return { ...(event.run ? { ...rest, run: event.run } : rest), tickets: byCustomer(event.tickets), issues: event.issues };
    }
    case "ticket":
      // Only the current simulation's customers: a late update of an ended one is dropped.
      if (!current.run || !(event.ticket.customerId in current.tickets)) return current;
      return { ...current, tickets: { ...current.tickets, [event.ticket.customerId]: event.ticket } };
    case "issues":
      return current.run ? { ...current, issues: event.issues } : current;
    case "counters":
      return { ...current, counters: event.counters };
    case "knowledge":
      return { ...current, knowledge: event.knowledge, proposals: event.proposals };
    case "classification": {
      const { classification: _previous, ...rest } = current;
      return event.classification ? { ...rest, classification: event.classification } : rest;
    }
  }
}

async function loadState(): Promise<void> {
  try {
    const loaded = await api.state();
    setState((current) => {
      const { run: _previous, classification: _classification, ...rest } = current;
      return {
        ...(loaded.run ? { ...rest, run: loaded.run } : rest),
        ...(loaded.classification ? { classification: loaded.classification } : {}),
        phase: "ready",
        platform: loaded.platform,
        desk: loaded.desk,
        customers: loaded.customers,
        tickets: byCustomer(loaded.tickets),
        issues: loaded.issues,
        counters: loaded.counters,
        knowledge: loaded.knowledge,
        proposals: loaded.proposals,
      };
    });
  } catch (error) {
    setState((current) => (current.phase === "ready" ? current : { ...current, phase: "error", loadError: errorMessage(error) }));
  }
}

// ─── Server-sent events ──────────────────────────────────────────────────────────────────────────────────────

const EVENT_TYPES: readonly ServerEvent["type"][] = ["platform", "run", "ticket", "issues", "counters", "knowledge", "classification"];
let source: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 1_000;

function connectEvents(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  source?.close();
  const events = new EventSource("/api/events");
  source = events;
  events.onopen = () => {
    backoffMs = 1_000;
    setState((current) => (current.connection === "open" ? current : { ...current, connection: "open" }));
    // Anything may have changed while the page wasn't listening.
    void loadState();
  };
  events.onerror = () => {
    if (source !== events) return;
    setState((current) => (current.connection === "reconnecting" ? current : { ...current, connection: "reconnecting" }));
    if (events.readyState === EventSource.CLOSED) scheduleReconnect();
  };
  const onMessage = (message: MessageEvent): void => {
    try {
      const event = JSON.parse(String(message.data)) as ServerEvent;
      if (typeof event?.type === "string") setState((current) => reduce(current, event));
    } catch {
      // Ignore malformed messages.
    }
  };
  for (const type of EVENT_TYPES) events.addEventListener(type, onMessage as EventListener);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  const delay = backoffMs + Math.round(Math.random() * 400);
  backoffMs = Math.min(backoffMs * 2, 15_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectEvents();
  }, delay);
}

let started = false;

/** Loads `/api/state` and opens the event stream. Safe to call more than once. */
export function startHelpDesk(): void {
  if (started) return;
  started = true;
  connectEvents();
  void loadState();
}

// ─── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────

let toastId = 0;

export function showToast(title: string, detail?: string): void {
  const toast: Toast = { id: ++toastId, title, ...(detail ? { detail } : {}) };
  setState((current) => ({ ...current, toasts: [...current.toasts, toast].slice(-3) }));
  setTimeout(() => dismissToast(toast.id), 6_000);
}

export function dismissToast(id: number): void {
  setState((current) => (current.toasts.some((toast) => toast.id === id) ? { ...current, toasts: current.toasts.filter((toast) => toast.id !== id) } : current));
}

export function chooseSize(size: SimulationSize): void {
  try {
    globalThis.localStorage?.setItem(SIZE_KEY, String(size));
  } catch {
    // Private browsing: the choice lasts for this page only.
  }
  setState((current) => ({ ...current, size }));
}

export async function simulate(): Promise<void> {
  if (state.working) return;
  setState((current) => ({ ...current, working: "simulate" }));
  try {
    await api.simulate(state.size);
  } catch (error) {
    showToast("Couldn't start the simulation", errorMessage(error));
  } finally {
    setState((current) => ({ ...current, working: undefined }));
  }
}

/** Classifies the chosen number of customers' first messages, without starting their sessions. */
export async function classify(): Promise<void> {
  if (state.working) return;
  setState((current) => ({ ...current, working: "classify" }));
  try {
    await api.classify(state.size);
  } catch (error) {
    showToast("Couldn't classify the customers' messages", errorMessage(error));
  } finally {
    setState((current) => ({ ...current, working: undefined }));
  }
}

export async function endSimulation(): Promise<void> {
  if (state.working) return;
  setState((current) => ({ ...current, working: "end" }));
  try {
    await api.end();
  } catch (error) {
    showToast("Couldn't end the simulation", errorMessage(error));
  } finally {
    setState((current) => ({ ...current, working: undefined }));
  }
}

export async function answer(customerId: string, approvalId: string, approve: boolean): Promise<void> {
  if (state.answering[approvalId]) return;
  setState((current) => ({ ...current, answering: { ...current.answering, [approvalId]: true } }));
  try {
    await api.answer(customerId, approvalId, approve);
  } catch (error) {
    showToast("Couldn't answer the request", errorMessage(error));
  } finally {
    setState((current) => {
      const { [approvalId]: _done, ...answering } = current.answering;
      return { ...current, answering };
    });
  }
}

export async function sendAsCustomer(customerId: string, text: string): Promise<boolean> {
  try {
    await api.send(customerId, text);
    return true;
  } catch (error) {
    showToast("The message wasn't sent", errorMessage(error));
    return false;
  }
}

/** Adds a fact an agent proposed to the team knowledge base, or declines it. */
export async function decide(id: string, approve: boolean): Promise<void> {
  if (state.answering[id]) return;
  setState((current) => ({ ...current, answering: { ...current.answering, [id]: true } }));
  try {
    await api.decide(id, approve);
  } catch (error) {
    showToast(approve ? "Couldn't add the fact" : "Couldn't decline the fact", errorMessage(error));
  } finally {
    setState((current) => {
      const { [id]: _done, ...answering } = current.answering;
      return { ...current, answering };
    });
  }
}

/** Removes a fact from the team knowledge base. */
export async function forget(id: string): Promise<void> {
  if (state.forgetting[id]) return;
  setState((current) => ({ ...current, forgetting: { ...current.forgetting, [id]: true } }));
  try {
    await api.forget(id);
    setState((current) => ({ ...current, knowledge: current.knowledge.filter((entry) => entry.id !== id) }));
  } catch (error) {
    showToast("Couldn't remove the fact", errorMessage(error));
  } finally {
    setState((current) => {
      const { [id]: _done, ...forgetting } = current.forgetting;
      return { ...current, forgetting };
    });
  }
}

/** Sends a software issue to Software Factory as a work order. */
export async function routeIssue(area: BugArea): Promise<void> {
  if (state.routing[area]) return;
  setState((current) => ({ ...current, routing: { ...current.routing, [area]: true } }));
  try {
    const issue = await api.routeIssue(area);
    setState((current) => ({ ...current, issues: current.issues.map((candidate) => (candidate.area === issue.area ? issue : candidate)) }));
  } catch (error) {
    showToast("Couldn't send the issue to Software Factory", errorMessage(error));
  } finally {
    setState((current) => {
      const { [area]: _done, ...routing } = current.routing;
      return { ...current, routing };
    });
  }
}
