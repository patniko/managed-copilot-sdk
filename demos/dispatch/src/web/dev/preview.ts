/**
 * UI preview for development: `pnpm --filter @managed-copilot/demo-dispatch exec vite` then `http://localhost:<port>/?preview`
 * (or `?preview=<variant>`). Replaces `fetch('/api/...')` and `EventSource` with an in-memory fixture server, so the
 * real store, event handling, and views run unchanged. New conversations and follow-ups play a short simulated run.
 * Loaded only when `import.meta.env.DEV` is true (see `main.tsx`); production builds never include it.
 */
import type {
  Approval,
  ApprovalAnswer,
  AttachResponse,
  ChatMessage,
  Command,
  CommandRecord,
  ConversationSummary,
  ConversationView,
  CreateConversationRequest,
  Decision,
  DispatchState,
  ExecutionStyle,
  ServerEvent,
  WorkerView,
} from "../../shared/types.js";
import { createFixtures, PREVIEW_STYLES, type Fixtures } from "./fixtures.js";

const VARIANTS = ["", "empty", "azure", "connecting", "unavailable", "offline"] as const;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = (): string => new Date().toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function toSummary(view: ConversationView): ConversationSummary {
  const { id, style, environment, title, createdAt, updatedAt, status, messageCount, sandboxCount, liveSandboxes } = view;
  return { id, style, environment, title, createdAt, updatedAt, status, messageCount, sandboxCount, liveSandboxes };
}

interface PreviewSource {
  readyState: number;
  open(): void;
  fail(permanent: boolean): void;
  deliver(event: ServerEvent): void;
}

type Answer = { readonly approve: boolean; readonly reason?: string };

class PreviewServer {
  private readonly sources = new Set<PreviewSource>();
  private readonly state: Fixtures["state"];
  private readonly views: ConversationView[];
  private readonly contents: Fixtures["contents"];
  private readonly waiting = new Map<string, (answer: Answer) => void>();
  private counter = 0;
  private attachCalls = 0;

  constructor(
    fixtures: Fixtures,
    private readonly variant: string,
  ) {
    this.state = fixtures.state;
    this.views = fixtures.conversations;
    this.contents = fixtures.contents;
  }

  // ─── Event stream ─────────────────────────────────────────────────────────────────────────────────────────

  attach(source: PreviewSource): void {
    this.sources.add(source);
    setTimeout(() => source.open(), 120);
  }

  detach(source: PreviewSource): void {
    this.sources.delete(source);
  }

  private emit(event: ServerEvent): void {
    for (const source of this.sources) source.deliver(event);
  }

  private publish(view: ConversationView): void {
    this.emit({ type: "conversation", conversation: view });
    this.emit({ type: "conversations", conversations: this.summaries() });
  }

  private summaries(): ConversationSummary[] {
    return [...this.views].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(toSummary);
  }

  // ─── REST ─────────────────────────────────────────────────────────────────────────────────────────────────

  async handle(url: URL, method: string, body: unknown): Promise<Response> {
    await delay(80 + Math.random() * 160);
    if (this.variant === "offline") throw new TypeError("Failed to fetch");
    const path = url.pathname;
    if (method === "GET" && path === "/api/state") return json(this.dispatchState());
    if (method === "POST" && path === "/api/conversations") return this.create(parse<CreateConversationRequest>(body));
    const attach = /^\/api\/sessions\/([^/]+)\/attach$/.exec(path);
    if (attach && method === "POST") return json(this.attachResponse(decodeURIComponent(attach[1] ?? "")));
    const match = /^\/api\/conversations\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match) return failure(404, "not_found", "The preview server doesn't know this endpoint.");
    const id = decodeURIComponent(match[1] ?? "");
    const rest = match[2] ?? "";
    const view = this.views.find((candidate) => candidate.id === id);
    if (!view) return failure(404, "not_found", "That conversation doesn't exist.");

    if (rest === "" && method === "GET") return json(view);
    if (rest === "" && method === "DELETE") {
      this.views.splice(this.views.indexOf(view), 1);
      this.emit({ type: "removed", id });
      this.emit({ type: "conversations", conversations: this.summaries() });
      return new Response(null, { status: 204 });
    }
    if (rest === "messages" && method === "POST") return this.send(view, parse<{ prompt?: string }>(body).prompt ?? "");
    if (rest === "settings" && method === "PUT") {
      const approvals = parse<{ approvals?: string }>(body).approvals;
      if (approvals !== "ask" && approvals !== "auto") return failure(400, "invalid_request", "Choose ask or auto.");
      return json(this.update(id, (current) => ({ ...current, settings: { approvals } })));
    }
    const approval = /^approvals\/([^/]+)$/.exec(rest);
    if (approval && method === "POST") return this.answer(view, decodeURIComponent(approval[1] ?? ""), parse<ApprovalAnswer>(body));
    const workerMatch = /^workers\/([^/]+)\/(files|commands|file)$/.exec(rest);
    if (workerMatch && method === "GET") {
      const worker = view.workers.find((candidate) => candidate.id === decodeURIComponent(workerMatch[1] ?? ""));
      if (!worker) return failure(404, "not_found", "That sandbox doesn't exist.");
      if (workerMatch[2] === "files") return json({ files: worker.files ?? [], at: nowIso() });
      if (workerMatch[2] === "commands") return json(commandRecords(view, worker));
      const filePath = url.searchParams.get("path") ?? "";
      const content = this.contents[filePath] ?? `Preview content for ${filePath}.\n`;
      return json({ path: filePath, content, truncated: false, binary: false });
    }
    return failure(404, "not_found", "The preview server doesn't know this endpoint.");
  }

  private dispatchState(): DispatchState {
    return { ...this.state, conversations: this.summaries() };
  }

  private attachResponse(sessionId: string): AttachResponse {
    this.attachCalls += 1;
    const command = `npx managed-copilot attach ${sessionId}`;
    return this.attachCalls % 2 === 1
      ? { command, launched: false, message: "The preview can't open a terminal. Run this command to attach:" }
      : { command, launched: true, message: "Opened Copilot CLI in a new terminal window, attached to this session." };
  }

  // ─── Conversations ────────────────────────────────────────────────────────────────────────────────────────

  private update(id: string, change: (view: ConversationView) => ConversationView): ConversationView {
    const index = this.views.findIndex((candidate) => candidate.id === id);
    const current = this.views[index];
    if (!current) throw new Error(`Unknown conversation ${id}`);
    const changed = change(current);
    const workers = changed.workers;
    const next: ConversationView = {
      ...changed,
      updatedAt: nowIso(),
      messageCount: changed.messages.filter((message) => message.role === "user").length,
      sandboxCount: workers.length,
      liveSandboxes: workers.filter((worker) => worker.state !== "stopped").length,
      status: changed.approvals.length ? "asking" : changed.busy ? "working" : "idle",
    };
    this.views[index] = next;
    this.publish(next);
    return next;
  }

  private create(request: Partial<CreateConversationRequest>): Response {
    const prompt = request.prompt?.trim() ?? "";
    if (!prompt) return failure(400, "invalid_request", "Write a message first.");
    const style: ExecutionStyle = request.style ?? "delegate";
    const info = PREVIEW_STYLES.find((candidate) => candidate.style === style)!;
    const at = nowIso();
    const id = `c-new-${(++this.counter).toString(36)}`;
    const view: ConversationView = {
      id,
      style,
      environment: info.environment,
      title: prompt.split(/\r?\n/)[0]!.slice(0, 80),
      createdAt: at,
      updatedAt: at,
      status: "working",
      messageCount: 1,
      sandboxCount: 0,
      liveSandboxes: 0,
      messages: [{ id: `${id}-m1`, role: "user", index: 1, at, content: prompt, via: "dispatch", messageId: `${id}-m1-runtime` }],
      workers: [],
      approvals: [],
      settings: { approvals: request.approvals ?? "ask" },
      agents: {},
      approvedRest: [],
      busy: true,
      attachCommand: `npx managed-copilot attach ${id}`,
    };
    this.views.push(view);
    this.publish(view);
    void this.run(id, 1);
    return json(view);
  }

  private send(view: ConversationView, prompt: string): Response {
    if (!prompt.trim()) return failure(400, "invalid_request", "Write a message first.");
    const index = view.messageCount + 1;
    const id = `${view.id}-m${index}`;
    const messageId = `${id}-runtime`;
    setTimeout(() => {
      this.update(view.id, (current) => ({
        ...current,
        busy: true,
        messages: [...current.messages, { id, role: "user", index, at: nowIso(), content: prompt.trim(), via: "dispatch", messageId }],
      }));
      void this.run(view.id, index);
    }, 300);
    return json({ messageId });
  }

  private answer(view: ConversationView, approvalId: string, answer: Partial<ApprovalAnswer>): Response {
    const approval = view.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) return failure(404, "approval_not_found", "That request was already answered.");
    this.update(view.id, (current) => ({ ...current, approvals: current.approvals.filter((candidate) => candidate.id !== approvalId) }));
    const resume = this.waiting.get(approvalId);
    this.waiting.delete(approvalId);
    if (resume) resume({ approve: answer.approve === true, ...(answer.reason ? { reason: answer.reason } : {}) });
    else this.settleFixture(view.id, approval, answer.approve === true);
    return new Response(null, { status: 204 });
  }

  /** Answers to the fixtures' own requests: mark the step and finish it a moment later. */
  private settleFixture(id: string, approval: Approval, approve: boolean): void {
    const status = approve ? "running" : "denied";
    this.update(id, (current) => mapSteps(current, approval.decisionId, status));
    if (!approve) return;
    setTimeout(() => {
      this.update(id, (current) => {
        const done = mapSteps(current, approval.decisionId, "done");
        return { ...done, busy: done.approvals.length > 0 };
      });
    }, 2500);
  }

  private ask(id: string, approval: Approval): Promise<Answer> {
    this.update(id, (current) => ({ ...current, approvals: [...current.approvals, approval] }));
    return new Promise((resolve) => this.waiting.set(approval.id, resolve));
  }

  // ─── Simulated runs ───────────────────────────────────────────────────────────────────────────────────────

  private async run(id: string, index: number): Promise<void> {
    const view = this.views.find((candidate) => candidate.id === id);
    if (!view) return;
    const ask = view.settings.approvals === "ask";
    await delay(900);
    this.reply(id, view.style === "delegate" ? "On it: one worker in a Python sandbox." : view.style === "direct" ? "On it, in my sandbox." : "I'll compute here and start a worker for the rest.");
    if (view.style !== "delegate") await this.runCommand(id, index, ask);
    if (view.style !== "direct") await this.runWorker(id, index, ask);
    await this.stream(id, "Done. The results are in `outputs/`, and the sandboxes are kept for follow-ups.");
  }

  private async runCommand(id: string, index: number, ask: boolean): Promise<void> {
    const commandId = `cmd-${++this.counter}`;
    const command: Command = { id: commandId, tool: "bash", kind: "run", status: ask ? "asking" : "running", at: nowIso(), command: "python3 -c \"print(sum(range(10**6)))\"" };
    this.update(id, (current) => withStep(current, index, { commands: [command] }));
    if (ask) {
      const answer = await this.ask(id, { id: `q-${commandId}`, kind: "command", decisionId: commandId, tool: "bash", command: command.command ?? "", requestedAt: command.at, messageIndex: index });
      if (!answer.approve) {
        this.update(id, (current) => mapSteps(current, commandId, "denied"));
        return;
      }
      this.update(id, (current) => mapSteps(current, commandId, "running", { approvedAt: nowIso() }));
    }
    this.update(id, (current) => {
      const hands = current.workers.find((worker) => worker.role === "hands");
      const workers = hands
        ? current.workers.map((worker) => (worker === hands ? { ...worker, state: "working" as const, sentWorkBy: worker.createdBy === index ? worker.sentWorkBy : [...new Set([...worker.sentWorkBy, index])] } : worker))
        : [...current.workers, handsSandbox(index)];
      return { ...current, workers };
    });
    await delay(2200);
    this.update(id, (current) => {
      const finished = mapSteps(current, commandId, "done", { exitCode: 0, outcome: "exit code 0", output: "499999500000" });
      return { ...finished, workers: finished.workers.map((worker) => (worker.role === "hands" ? { ...worker, state: "idle" as const } : worker)) };
    });
  }

  private async runWorker(id: string, index: number, ask: boolean): Promise<void> {
    const view = this.views.find((candidate) => candidate.id === id)!;
    const existing = view.workers.find((worker) => worker.role === "worker" && worker.state !== "stopped");
    const decisionId = `dec-${++this.counter}`;
    if (existing) {
      // A follow-up goes to the sandbox it already has: no approval needed.
      const decision: Decision = { id: decisionId, kind: "message", status: "running", at: nowIso(), worker: existing.name, workerId: existing.id, task: "Run it again with ten times the data." };
      this.update(id, (current) => ({
        ...withStep(current, index, { decisions: [decision] }),
        workers: current.workers.map((worker) => (worker.id === existing.id ? withState({ ...worker, tasks: worker.tasks + 1, sentWorkBy: [...worker.sentWorkBy, index] }, "working") : worker)),
      }));
      await delay(600);
      this.update(id, (current) => mapSteps(current, decisionId, "done"));
      await this.waitFor(id, index, existing.id, existing.name);
      return;
    }
    const name = `worker-${this.counter}`;
    const environment = view.style === "mixed" ? "dispatch-web" : "dispatch-python";
    const task = "Compute the first 1,000 primes and save them to outputs/primes.txt.";
    const decision: Decision = { id: decisionId, kind: "create", status: ask ? "asking" : "running", at: nowIso(), worker: name, environment, task };
    this.update(id, (current) => withStep(current, index, { decisions: [decision] }));
    if (ask) {
      const answer = await this.ask(id, { id: `p-${decisionId}`, kind: "sandbox", decisionId, worker: name, environment, task, requestedAt: decision.at, messageIndex: index });
      if (!answer.approve) {
        this.update(id, (current) => mapSteps(current, decisionId, "denied", { detail: `declined this sandbox: ${answer.reason ?? "no reason given"}` }));
        return;
      }
      this.update(id, (current) => mapSteps(current, decisionId, "running"));
    }
    const workerId = `w-${this.counter}`;
    const at = nowIso();
    this.update(id, (current) => ({
      ...current,
      workers: [
        ...current.workers,
        {
          id: workerId,
          role: "worker",
          name,
          environment,
          state: "starting",
          task,
          tasks: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: index,
          sentWorkBy: [],
          outputs: [],
          model: "claude-sonnet-5",
          timeline: [{ state: "starting", at }],
        },
      ],
    }));
    await delay(1600);
    this.update(id, (current) => ({
      ...mapSteps(current, decisionId, "done", { workerId }),
      workers: current.workers.map((worker) => (worker.id === workerId ? withState({ ...worker, sandbox: { id: `sbx_${Math.random().toString(16).slice(2, 18)}`, state: "running" } }, "working") : worker)),
    }));
    await this.waitFor(id, index, workerId, name);
  }

  private async waitFor(id: string, index: number, workerId: string, name: string): Promise<void> {
    const waitId = `wait-${++this.counter}`;
    const since = nowIso();
    this.update(id, (current) => ({ ...withStep(current, index, { decisions: [{ id: waitId, kind: "wait", status: "running", at: since, workers: [name] }] }), waiting: { workers: [name], since } }));
    await delay(4200);
    this.update(id, (current) => {
      const { waiting: _waiting, ...rest } = mapSteps(current, waitId, "done");
      return {
        ...rest,
        workers: rest.workers.map((worker) =>
          worker.id === workerId ? withState({ ...worker, result: "Saved 1,000 primes to `outputs/primes.txt`.", outputs: ["primes.txt"], files: [{ path: "outputs/primes.txt", size: 4783, modifiedAt: nowIso() }], filesAt: nowIso() }, "idle") : worker,
        ),
      };
    });
  }

  private reply(id: string, content: string): void {
    this.update(id, (current) => ({ ...current, messages: [...current.messages, { id: `r-${++this.counter}`, role: "assistant", at: nowIso(), content }] }));
  }

  private async stream(id: string, content: string): Promise<void> {
    const replyId = `r-${++this.counter}`;
    const words = content.split(" ");
    for (let shown = 3; shown < words.length + 3; shown += 3) {
      const text = words.slice(0, shown).join(" ");
      const streaming = shown < words.length;
      this.update(id, (current) => {
        const others = current.messages.filter((message) => message.id !== replyId);
        const message: ChatMessage = { id: replyId, role: "assistant", at: nowIso(), content: text, ...(streaming ? { streaming: true } : {}) };
        return { ...current, messages: [...others, message], busy: streaming || current.approvals.length > 0 };
      });
      await delay(220);
    }
  }
}

function parse<T>(body: unknown): Partial<T> {
  if (typeof body !== "string") return {};
  try {
    return JSON.parse(body) as Partial<T>;
  } catch {
    return {};
  }
}

function handsSandbox(index: number): WorkerView {
  const at = nowIso();
  return {
    id: `h-${index}-${Math.random().toString(16).slice(2, 8)}`,
    role: "hands",
    name: "dispatch-python",
    environment: "dispatch-python",
    state: "working",
    task: "",
    tasks: 0,
    createdAt: at,
    updatedAt: at,
    createdBy: index,
    sentWorkBy: [],
    outputs: [],
    sandbox: { id: `sbx_${Math.random().toString(16).slice(2, 18)}`, state: "running" },
    timeline: [{ state: "working", at }],
  };
}

function withState(worker: WorkerView, state: WorkerView["state"]): WorkerView {
  const at = nowIso();
  return { ...worker, state, updatedAt: at, timeline: [...worker.timeline, { state, at }] };
}

/** Appends decisions or commands to user message `index`. */
function withStep(view: ConversationView, index: number, step: { decisions?: readonly Decision[]; commands?: readonly Command[] }): ConversationView {
  return {
    ...view,
    messages: view.messages.map((message) =>
      message.role === "user" && message.index === index
        ? {
            ...message,
            ...(step.decisions ? { decisions: [...(message.decisions ?? []), ...step.decisions] } : {}),
            ...(step.commands ? { commands: [...(message.commands ?? []), ...step.commands] } : {}),
          }
        : message,
    ),
  };
}

/** Sets the status of the decision or command with this ID, wherever it is. */
function mapSteps(view: ConversationView, stepId: string | undefined, status: Decision["status"], extra: Partial<Decision & Command> = {}): ConversationView {
  if (!stepId) return view;
  const ended = status === "done" || status === "failed" || status === "denied" ? { endedAt: nowIso() } : {};
  return {
    ...view,
    messages: view.messages.map((message) =>
      message.role !== "user"
        ? message
        : {
            ...message,
            ...(message.decisions ? { decisions: message.decisions.map((decision) => (decision.id === stepId ? { ...decision, status, ...ended, ...pick(extra, ["workerId", "detail"]) } : decision)) } : {}),
            ...(message.commands
              ? { commands: message.commands.map((command) => (command.id === stepId ? { ...command, status, ...ended, ...pick(extra, ["approvedAt", "exitCode", "outcome", "output"]) } : command)) }
              : {}),
          },
    ),
  };
}

function pick<T extends object>(source: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key))) as Partial<T>;
}

/** What `managed.exec.list` would report for a hands sandbox: its finished and running commands. */
function commandRecords(view: ConversationView, worker: WorkerView): CommandRecord[] {
  if (worker.role !== "hands") return [];
  return view.messages
    .flatMap((message) => message.commands ?? [])
    .filter((command) => command.kind === "run" && command.status !== "asking" && command.status !== "denied")
    .map((command) => ({
      id: command.id,
      command: command.command ?? "",
      state: command.status === "running" ? "running" : "exited",
      ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
      startedAt: command.approvedAt ?? command.at,
      ...(command.endedAt ? { finishedAt: command.endedAt } : {}),
      background: false,
      tool: "bash",
      ...(command.agentId ? { agentId: command.agentId } : {}),
    }));
}

function createEventSourceClass(server: PreviewServer) {
  return class PreviewEventSource extends EventTarget implements PreviewSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      server.attach(this);
    }

    open(): void {
      if (this.readyState === 2) return;
      this.readyState = 1;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    }

    fail(permanent: boolean): void {
      if (this.readyState === 2) return;
      this.readyState = permanent ? 2 : 0;
      const event = new Event("error");
      this.onerror?.(event);
      this.dispatchEvent(event);
    }

    deliver(event: ServerEvent): void {
      if (this.readyState !== 1) return;
      this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }

    close(): void {
      this.readyState = 2;
      server.detach(this);
    }
  };
}

function showBanner(variant: string): void {
  const banner = document.createElement("div");
  banner.setAttribute("role", "note");
  banner.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "bottom:0",
    "z-index:2147483000",
    "height:30px",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "gap:12px",
    "padding:0 16px",
    "font:12px/1.5 var(--fontStack-sansSerif)",
    "color:var(--fgColor-default)",
    "background:var(--bgColor-attention-muted)",
    "border-top:1px solid var(--borderColor-attention-muted)",
  ].join(";");
  const label = document.createElement("span");
  label.textContent = `UI preview · fixture data, not a live run${variant ? ` · ${variant}` : ""}`;
  label.style.cssText = "font-weight:600;white-space:nowrap";
  banner.appendChild(label);
  if (window.innerWidth >= 720) {
    const links = document.createElement("span");
    links.style.cssText = "display:flex;gap:12px";
    for (const name of VARIANTS) {
      const link = document.createElement("a");
      link.href = `?preview${name ? `=${name}` : ""}${location.hash}`;
      link.textContent = name || "default";
      link.style.cssText = name === variant ? "color:var(--fgColor-default);font-weight:600;text-decoration:none" : "color:var(--fgColor-accent);text-decoration:none";
      links.appendChild(link);
    }
    banner.appendChild(links);
  }
  document.body.appendChild(banner);
  document.documentElement.style.setProperty("--preview-offset", "30px");
}

export function installPreview(): void {
  const params = new URLSearchParams(window.location.search);
  const variant = params.get("preview") ?? "";
  const server = new PreviewServer(createFixtures(Date.now(), variant), variant);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      return server.handle(url, method, init?.body);
    }
    return realFetch(input, init);
  };
  Object.defineProperty(window, "EventSource", { configurable: true, writable: true, value: createEventSourceClass(server) });
  // `&banner=0` hides the banner, for regression screenshots.
  if (params.get("banner") !== "0") showBanner(variant);
}
