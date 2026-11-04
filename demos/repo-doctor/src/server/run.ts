import { STEP_IDS, type AllowedHost, type BlockedHost, type LogLine, type RunView, type StepId, type StepLogs, type StepStatus, type StepView } from "../shared/types.js";
import { isRuntimeHost, matchesAllowed } from "./inference.js";
import type { BlockedRequest } from "./platform.js";

/** Lines kept per step; older ones are dropped first. */
const MAX_LOG_LINES = 500;
/** Characters kept per line; longer output keeps its end, where test runners print their summary. */
const MAX_LINE_CHARS = 8_000;

export interface RunSink {
  changed(run: Run): void;
  logged(run: Run, step: StepId, line: LogLine): void;
}

export function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

/** Drops keys whose value is undefined, so records and events stay small. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function emptyLogs(): Record<StepId, LogLine[]> {
  return Object.fromEntries(STEP_IDS.map((id) => [id, [] as LogLine[]])) as Record<StepId, LogLine[]>;
}

/** One run's state: its view, its steps' logs, and how to stop it. Every change goes to the sink. */
export class Run {
  #view: RunView;
  readonly #logs: Record<StepId, LogLine[]>;
  readonly #sink: RunSink;
  #seq = 0;
  readonly controller = new AbortController();
  /** The step that receives Copilot's activity and the network's blocks. */
  current: StepId | undefined;

  constructor(view: RunView, logs: StepLogs | undefined, sink: RunSink) {
    this.#view = view;
    this.#logs = emptyLogs();
    for (const id of STEP_IDS) this.#logs[id].push(...(logs?.[id] ?? []));
    this.#seq = Math.max(0, ...STEP_IDS.flatMap((id) => this.#logs[id].map((line) => line.seq ?? 0)));
    this.#sink = sink;
  }

  get id(): string {
    return this.#view.id;
  }

  get view(): RunView {
    return this.#view;
  }

  get logs(): StepLogs {
    return this.#logs;
  }

  get stopping(): boolean {
    return this.controller.signal.aborted;
  }

  update(patch: Partial<RunView>): void {
    this.#view = compact({ ...this.#view, ...patch });
    this.#sink.changed(this);
  }

  step(id: StepId, patch: Partial<StepView>): void {
    this.#view = { ...this.#view, steps: this.#view.steps.map((step) => (step.id === id ? compact({ ...step, ...patch }) : step)) };
    this.#sink.changed(this);
  }

  stepView(id: StepId): StepView {
    return this.#view.steps.find((step) => step.id === id)!;
  }

  start(id: StepId): void {
    this.current = id;
    this.step(id, { status: "running", startedAt: new Date().toISOString() });
  }

  finish(id: StepId, status: StepStatus, summary?: string): void {
    this.step(id, { status, finishedAt: new Date().toISOString(), activity: undefined, ...(summary ? { summary } : {}) });
    if (this.current === id) this.current = undefined;
  }

  log(step: StepId, line: Omit<LogLine, "at" | "seq">): void {
    const entry: LogLine = compact({ ...line, seq: ++this.#seq, text: tail(line.text, MAX_LINE_CHARS), at: new Date().toISOString() });
    const lines = this.#logs[step];
    lines.push(entry);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    this.#sink.logged(this, step, entry);
  }

  /** Allowed hosts that `hosts` match are marked used by `by`, unless something used them already. */
  used(hosts: readonly string[], by: string): void {
    if (hosts.length === 0) return;
    let changed = false;
    const at = new Date().toISOString();
    const allowed = this.#view.network.allowed.map((entry): AllowedHost => {
      if (entry.used || !hosts.some((host) => matchesAllowed(host, entry.host))) return entry;
      changed = true;
      return { ...entry, used: { at, by: tail(by, 160) } };
    });
    if (changed) this.update({ network: { ...this.#view.network, allowed } });
  }

  /** A blocked request from this run's sandbox: counted per host, and noted once in the current step's log. */
  blocked(request: BlockedRequest): void {
    const host = request.host ?? "(unknown host)";
    const existing = this.#view.network.blocked.find((entry) => entry.host === host && entry.reason === request.reason);
    const entry: BlockedHost = existing
      ? { ...existing, count: existing.count + 1, lastAt: request.at }
      : { host, ...(request.port !== undefined ? { port: request.port } : {}), reason: request.reason, count: 1, firstAt: request.at, lastAt: request.at, runtime: isRuntimeHost(host) };
    const blocked = existing ? this.#view.network.blocked.map((item) => (item === existing ? entry : item)) : [...this.#view.network.blocked, entry];
    this.update({ network: { ...this.#view.network, blocked } });
    const step = this.current;
    if (!existing && step) this.log(step, { kind: "blocked", text: `${host}${request.port && request.port !== 443 ? `:${request.port}` : ""} (${request.reason.replace(/_/g, " ")})` });
  }
}
