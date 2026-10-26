/**
 * UI preview for development: `vite` + `http://localhost:<port>/?preview` (or `?preview=<variant>`).
 * Replaces `fetch('/api/...')` and `EventSource` with an in-memory fixture server that streams simulated activity,
 * so the real store, SSE handling, and views run unchanged. Loaded only when `import.meta.env.DEV` is true.
 */
import { TEMPLATES } from "../../shared/templates.js";
import {
  TEST_SUMMARY_MARKER,
  type ActivityItem,
  type ArtifactIndex,
  type AttachResponse,
  type FactoryState,
  type ServerEvent,
  type Station,
  type TestSummary,
  type WorkOrder,
  type WorkOrderSummary,
} from "../../shared/types.js";
import { createFixtures, ENVIRONMENTS, PREVIEW_FILE_CONTENTS, type FixtureFile, type Fixtures } from "./fixtures.js";

const VARIANTS = ["", "empty", "offline", "platform-down", "misconfigured", "connecting", "flaky"] as const;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function toSummary(workOrder: WorkOrder): WorkOrderSummary {
  const { id, number, title, status, createdAt, updatedAt, startedAt, completedAt, taskCount, tests, error } = workOrder;
  return { id, number, title, status, createdAt, updatedAt, startedAt, completedAt, taskCount, tests, error };
}

const ACTIVE = new Set(["queued", "planning", "building", "releasing"]);

interface PreviewSource {
  readyState: number;
  open(): void;
  fail(permanent: boolean): void;
  deliver(event: ServerEvent): void;
}

class PreviewServer {
  private readonly sources = new Set<PreviewSource>();
  private readonly workOrders: WorkOrder[];
  private readonly activity: Map<string, ActivityItem[]>;
  private readonly files: Map<string, FixtureFile[]>;
  private readonly platform: Fixtures["platform"];
  private nextNumber = 12;
  private counter = 0;
  private attachCalls = 0;
  private outage = false;

  constructor(
    fixtures: Fixtures,
    private readonly variant: string,
  ) {
    this.workOrders = fixtures.workOrders;
    this.activity = fixtures.activity;
    this.files = fixtures.files;
    this.platform = fixtures.platform;
  }

  // ─── Event stream ─────────────────────────────────────────────────────────────────────────────────────────

  attach(source: PreviewSource): void {
    this.sources.add(source);
    setTimeout(() => (this.outage ? source.fail(false) : source.open()), 150);
  }

  detach(source: PreviewSource): void {
    this.sources.delete(source);
  }

  private emit(event: ServerEvent): void {
    for (const source of this.sources) source.deliver(event);
  }

  // ─── REST ─────────────────────────────────────────────────────────────────────────────────────────────────

  async handle(url: URL, method: string, body: unknown): Promise<Response> {
    await delay(140 + Math.random() * 260);
    if (this.variant === "offline") throw new TypeError("Failed to fetch");
    const path = url.pathname;
    if (method === "GET" && path === "/api/state") return json(this.state());
    if (method === "POST" && path === "/api/work-orders") return this.create(body);
    const attach = /^\/api\/sessions\/([^/]+)\/attach$/.exec(path);
    if (attach && method === "POST") return json(this.attachResponse(decodeURIComponent(attach[1] ?? "")));
    const match = /^\/api\/work-orders\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match) return failure(404, "not_found", "The preview server doesn't know this endpoint.");
    const id = decodeURIComponent(match[1] ?? "");
    const rest = match[2] ?? "";
    const workOrder = this.workOrders.find((candidate) => candidate.id === id);
    if (!workOrder) return failure(404, "not_found", "That work order doesn't exist.");

    if (rest === "" && method === "GET") return json(workOrder);
    if (rest === "" && method === "DELETE") {
      if (ACTIVE.has(workOrder.status)) return failure(409, "work_order_active", "Cancel the work order before deleting it.");
      this.workOrders.splice(this.workOrders.indexOf(workOrder), 1);
      this.emit({ type: "workOrderDeleted", workOrderId: id });
      return new Response(null, { status: 204 });
    }
    if (rest === "cancel" && method === "POST") return this.cancel(workOrder);
    if (rest === "retry" && method === "POST") return this.retry(workOrder);
    if (rest === "activity" && method === "GET") {
      const stationId = url.searchParams.get("stationId");
      const items = (this.activity.get(id) ?? []).filter((item) => !stationId || item.stationId === stationId);
      return json(items);
    }
    if (rest === "artifacts" && method === "GET") return json(this.artifactIndex(id));
    if (rest === "artifacts/content" && method === "GET") {
      const file = (this.files.get(id) ?? []).find(
        (candidate) => candidate.stationId === url.searchParams.get("stationId") && candidate.path === url.searchParams.get("path"),
      );
      const requested = Number(url.searchParams.get("version"));
      const version = file?.versions.find((candidate) => candidate.version === requested) ?? file?.versions[file.versions.length - 1];
      if (!file || !version) return failure(404, "not_found", "That artifact doesn't exist.");
      return new Response(version.content, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return failure(404, "not_found", "The preview server doesn't know this endpoint.");
  }

  private state(): FactoryState {
    return {
      platform: this.platform,
      workOrders: [...this.workOrders].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(toSummary),
      templates: TEMPLATES,
      attachCommand: "npx managed-copilot attach {sessionId}",
      canLaunchTerminal: false,
    };
  }

  private artifactIndex(id: string): ArtifactIndex {
    return {
      workOrderId: id,
      files: (this.files.get(id) ?? []).map((file) => ({
        stationId: file.stationId,
        path: file.path,
        contentType: file.contentType,
        viewable: file.viewable,
        versions: [...file.versions].reverse().map((version) => ({
          version: version.version,
          round: version.round,
          size: version.content.length || 4821,
          digest: `sha256:${(version.version * 7919 + file.path.length * 104729).toString(16).padStart(12, "0")}`,
          publishedAt: version.publishedAt,
          viewable: file.viewable,
        })),
      })),
    };
  }

  private attachResponse(sessionId: string): AttachResponse {
    this.attachCalls += 1;
    const command = `npx managed-copilot attach ${sessionId}`;
    return this.attachCalls % 2 === 1
      ? { command, launched: false, message: "The preview can't open a terminal window. Run this command in a terminal to attach:" }
      : { command, launched: true, message: "Opened Copilot CLI in a new terminal window, attached to this session." };
  }

  private create(body: unknown): Response {
    const request = typeof body === "string" ? (JSON.parse(body) as { title?: string; brief?: string; templateId?: string; maxReviewRounds?: number }) : {};
    const title = request.title?.trim() ?? "";
    const brief = request.brief?.trim() ?? "";
    if (!title) return failure(400, "invalid_request", "Give the work order a title.");
    if (brief.length < 40) return failure(400, "invalid_request", "The brief is too short. Describe what to build in a few sentences.");
    const now = new Date().toISOString();
    const workOrder: WorkOrder = {
      id: `wo_${Date.now().toString(36)}`,
      number: this.nextNumber++,
      title,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      taskCount: 0,
      brief,
      source: request.templateId ? { kind: "template", templateId: request.templateId } : { kind: "brief" },
      maxReviewRounds: request.maxReviewRounds ?? 2,
      owner: { login: "mona" },
      stations: [],
    };
    this.workOrders.push(workOrder);
    this.emit({ type: "workOrder", workOrder });
    void this.startPlanning(workOrder.id, 1500);
    return json(workOrder, 201);
  }

  private cancel(workOrder: WorkOrder): Response {
    if (!ACTIVE.has(workOrder.status)) return failure(409, "not_active", "Only running work orders can be cancelled.");
    const now = new Date().toISOString();
    const updated = this.replace(workOrder.id, (current) => ({
      ...current,
      status: "cancelled",
      completedAt: now,
      stations: current.stations.map((station) =>
        ["starting", "working", "collecting"].includes(station.status)
          ? { ...station, status: "cancelled", finishedAt: now, detail: "Cancelled by mona" }
          : station.status === "waiting" || station.status === "changes_requested"
            ? { ...station, status: "skipped" }
            : station,
      ),
    }));
    return json(updated);
  }

  private retry(workOrder: WorkOrder): Response {
    if (workOrder.status !== "failed" && workOrder.status !== "cancelled") {
      return failure(409, "not_retryable", "Only failed or cancelled work orders can be retried.");
    }
    const updated = this.replace(workOrder.id, (current) => ({
      ...current,
      status: current.plan ? "building" : "planning",
      completedAt: undefined,
      error: undefined,
      stations: current.stations.map((station, index) =>
        ["failed", "cancelled", "skipped"].includes(station.status)
          ? {
              ...station,
              status: index === 1 ? "starting" : "waiting",
              error: undefined,
              finishedAt: undefined,
              detail: index === 1 ? "Creating a fresh sandbox" : undefined,
              previousSessionIds: station.sessionId ? [...(station.previousSessionIds ?? []), station.sessionId] : station.previousSessionIds,
              sessionId: undefined,
              sessionState: undefined,
              turn: index === 1 ? { kind: "retry", round: Math.max(station.round, 1), sentAt: new Date().toISOString() } : undefined,
              startedAt: index === 1 ? new Date().toISOString() : undefined,
            }
          : station,
      ),
    }));
    return json(updated);
  }

  // ─── Mutation helpers ─────────────────────────────────────────────────────────────────────────────────────

  private replace(id: string, update: (current: WorkOrder) => WorkOrder): WorkOrder | undefined {
    const index = this.workOrders.findIndex((candidate) => candidate.id === id);
    const current = this.workOrders[index];
    if (!current) return undefined;
    const next = { ...update(current), updatedAt: new Date().toISOString() };
    this.workOrders[index] = next;
    this.emit({ type: "workOrder", workOrder: next });
    return next;
  }

  private updateStation(id: string, stationId: string, patch: Partial<Station>): void {
    this.replace(id, (current) => ({
      ...current,
      stations: current.stations.map((station) => (station.id === stationId ? { ...station, ...patch } : station)),
    }));
  }

  private isActive(id: string): boolean {
    const workOrder = this.workOrders.find((candidate) => candidate.id === id);
    return Boolean(workOrder && ACTIVE.has(workOrder.status));
  }

  private push(workOrderId: string, stationId: string, item: Omit<ActivityItem, "id" | "workOrderId" | "stationId" | "at">, id?: string): ActivityItem {
    this.counter += 1;
    const full: ActivityItem = { ...item, id: id ?? `live:${this.counter}`, workOrderId, stationId, at: new Date().toISOString() };
    const list = this.activity.get(workOrderId) ?? [];
    const existing = list.findIndex((candidate) => candidate.id === full.id);
    if (existing >= 0) list[existing] = full;
    else list.push(full);
    this.activity.set(workOrderId, list);
    this.emit({ type: "activity", item: full });
    return full;
  }

  private async tool(workOrderId: string, stationId: string, name: string, summary: string, ms: number, result?: { output?: string; exitCode?: number; failed?: boolean }): Promise<void> {
    this.counter += 1;
    const callId = `call_live_${this.counter}`;
    const id = `tool:${callId}`;
    this.push(workOrderId, stationId, { kind: "tool", tool: { callId, name, summary, status: "running" } }, id);
    await delay(ms);
    if (!this.isActive(workOrderId)) return;
    this.push(
      workOrderId,
      stationId,
      {
        kind: "tool",
        tool: {
          callId,
          name,
          summary,
          status: result?.failed ? "failed" : "succeeded",
          durationMs: ms + Math.round(Math.random() * 40),
          output: result?.output,
          exitCode: result?.exitCode,
        },
      },
      id,
    );
  }

  private async stream(workOrderId: string, stationId: string, text: string): Promise<void> {
    this.counter += 1;
    const messageId = `m${this.counter}`;
    const words = text.split(/(\s+)/);
    let chunk = "";
    for (const word of words) {
      chunk += word;
      if (chunk.length >= 10) {
        if (!this.isActive(workOrderId)) return;
        this.emit({ type: "delta", workOrderId, stationId, messageId, text: chunk });
        chunk = "";
        await delay(45 + Math.random() * 70);
      }
    }
    if (chunk) this.emit({ type: "delta", workOrderId, stationId, messageId, text: chunk });
    await delay(250);
    this.push(workOrderId, stationId, { kind: "message", text }, `msg:${messageId}`);
  }

  // ─── Simulation ───────────────────────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.variant === "offline" || this.variant === "empty" || this.platform.state !== "connected") return;
    void this.builderLoop();
    void this.collectingLoop();
    void this.plannerScenario();
    void this.startPlanning("wo_queued", 9000);
    if (this.variant === "flaky") void this.flakyLoop();
  }

  private async flakyLoop(): Promise<void> {
    for (;;) {
      await delay(25_000);
      this.outage = true;
      for (const source of this.sources) source.fail(false);
      await delay(5000);
      this.outage = false;
      for (const source of this.sources) source.open();
    }
  }

  private summary(passed: number, failed: number, durationMs: number): TestSummary {
    return { total: passed + failed, passed, failed, skipped: 0, durationMs, at: new Date().toISOString() };
  }

  private harness(passed: number, failed: number, durationMs: number): string {
    return [
      "> node --test --test-reporter=spec",
      "▶ csv parser",
      "  ✔ parses a header row and records (1.9ms)",
      "  ✔ keeps commas inside quotes (0.8ms)",
      "  ✔ handles CRLF line endings (0.7ms)",
      "  ✔ keeps newlines inside quoted fields (0.9ms)",
      "  ✔ rejects an unterminated quote (0.5ms)",
      "▶ csv parser (6.2ms)",
      `ℹ tests ${passed + failed}`,
      `ℹ pass ${passed}`,
      `ℹ fail ${failed}`,
      `ℹ duration_ms ${durationMs}`,
      `${TEST_SUMMARY_MARKER} ${JSON.stringify({ total: passed + failed, passed, failed, skipped: 0, durationMs })}`,
    ].join("\n");
  }

  private async builderLoop(): Promise<void> {
    const id = "wo_csvjson";
    const station = "build:csv-parser";
    await delay(2500);
    for (let cycle = 0; this.isActive(id); cycle += 1) {
      this.updateStation(id, station, { detail: "Reading the reviewer's findings" });
      this.push(id, station, { kind: "intent", text: cycle === 0 ? "Tracking quote state across line breaks" : "Tightening edge cases before the next review" });
      await delay(1200);
      await this.tool(id, station, "view", "src/csv.js", 700, { output: PREVIEW_FILE_CONTENTS.CSV_V2.slice(0, 900) });
      await delay(500);
      await this.stream(
        id,
        station,
        cycle === 0
          ? "The reviewer is right: splitting on `\\n` first cuts quoted fields in half and leaves a stray `\\r` on CRLF input. I'll parse **character by character**, keep the quote state across line breaks, and add regression tests:\n\n- CRLF and LF produce identical rows\n- newlines inside quotes are preserved\n- an unterminated quote throws a `SyntaxError`"
          : "Adding a test for a trailing delimiter so `a,b,` yields three fields, then re-running the harness.",
      );
      if (!this.isActive(id)) return;
      this.updateStation(id, station, { detail: "Editing src/csv.js" });
      await this.tool(id, station, "edit", "src/csv.js", 1500);
      await this.tool(id, station, "edit", "test/csv.test.js", 900);
      this.push(id, station, { kind: "skill", text: "factory-check" });
      this.updateStation(id, station, { detail: "Running tests" });
      const passed = 12 + cycle;
      await this.tool(id, station, "bash", "node .factory/check.mjs --task csv-parser", 2600, { output: this.harness(passed, 0, 1290) });
      if (!this.isActive(id)) return;
      const tests = this.summary(passed, 0, 1290);
      this.push(id, station, { kind: "test", tests });
      this.updateStation(id, station, { tests, detail: `All ${passed} tests pass` });
      if (cycle === 0) this.publishRoundTwo(id);
      await delay(1500);
      await this.tool(id, station, "bash", "git diff --stat", 400, { output: " src/csv.js       | 58 +++++++++++++++++++++++++++++-----------\n test/csv.test.js | 12 ++++++++\n 2 files changed, 52 insertions(+), 18 deletions(-)" });
      this.push(id, station, { kind: "status", text: "Waiting for the harness to publish outputs", level: "info" });
      await delay(6000);
    }
  }

  private publishRoundTwo(id: string): void {
    const files = this.files.get(id);
    if (!files) return;
    const now = new Date().toISOString();
    const bump = (path: string, content: string): void => {
      const file = files.find((candidate) => candidate.stationId === "build:csv-parser" && candidate.path === path);
      if (file && file.versions.length < 2) file.versions.push({ version: 2, round: 2, content, publishedAt: now });
    };
    bump("files/src/csv.js", PREVIEW_FILE_CONTENTS.CSV_V2);
    bump("changes.patch", PREVIEW_FILE_CONTENTS.CSV_PATCH_V2);
    this.push(id, "build:csv-parser", { kind: "artifact", text: "Published 2 updated files for round 2" });
    this.emit({ type: "artifacts", workOrderId: id });
  }

  private async collectingLoop(): Promise<void> {
    const id = "wo_csvjson";
    const station = "build:json-writer";
    await delay(4000);
    while (this.isActive(id)) {
      this.push(id, station, { kind: "status", text: "Collected `outputs/test-report.json` (9 passed)" });
      await delay(9000);
      this.push(id, station, { kind: "status", text: "Uploading 4 artifacts to the artifact store…" });
      await delay(11_000);
    }
  }

  private async startPlanning(id: string, after: number): Promise<void> {
    await delay(after);
    const workOrder = this.workOrders.find((candidate) => candidate.id === id);
    if (!workOrder || workOrder.status !== "queued") return;
    const planner = ENVIRONMENTS.find((environment) => environment.role === "planner");
    const now = new Date().toISOString();
    const plan: Station = {
      id: "plan",
      kind: "plan",
      title: "Plan",
      status: "starting",
      role: "planner",
      environment: planner?.name ?? "factory-planner",
      placement: "shared",
      agent: "planner",
      model: planner?.model,
      round: 1,
      startedAt: now,
      detail: "Starting the planner session",
    };
    this.replace(id, (current) => ({ ...current, status: "planning", startedAt: now, stations: [plan] }));
    await delay(1600);
    this.updateStation(id, "plan", {
      status: "working",
      sessionId: `ses_${Date.now().toString(16)}`,
      sessionState: "running",
      turn: { kind: "work", round: 1, sentAt: new Date().toISOString() },
      detail: "Reading the brief",
    });
    this.push(id, "plan", { kind: "status", text: "Session started on `factory-planner` (shared, network off)" });
    this.push(id, "plan", { kind: "skill", text: "task-decomposition" });
    await delay(1200);
    await this.stream(id, "plan", "Reading the brief to find independent pieces of work. I'll keep each task small enough for one sandbox and spell out the interfaces between them.");
  }

  private async plannerScenario(): Promise<void> {
    const id = "wo_logsum";
    await delay(3000);
    await this.tool(id, "plan", "view", "/workspace/WORK_ORDER.md", 600, { output: "# Log line summarizer\n\nBuild `logsum`..." });
    await this.stream(
      id,
      "plan",
      "I'll split **logsum** into two tasks:\n\n1. `log-parser` — parse NDJSON lines, skip and count invalid ones, apply `--since`.\n2. `summary-cli` — aggregate counts by level, the top 5 messages, and the time range, and print them.\n\nThe CLI depends on the parser's interface, so it waits for it.",
    );
    await delay(1500);
    if (!this.isActive(id)) return;
    this.push(id, "plan", { kind: "status", text: "Plan submitted: 2 tasks", level: "success" });
    const now = new Date().toISOString();
    const builder = ENVIRONMENTS.find((environment) => environment.role === "builder");
    const reviewer = ENVIRONMENTS.find((environment) => environment.role === "reviewer");
    const release = ENVIRONMENTS.find((environment) => environment.role === "release");
    const make = (stationId: string, kind: Station["kind"], title: string, taskId: string | undefined, status: Station["status"]): Station => {
      const environment = kind === "build" ? builder : kind === "review" ? reviewer : release;
      return {
        id: stationId,
        kind,
        title,
        taskId,
        status,
        role: kind === "build" ? "builder" : kind === "review" ? "reviewer" : "release",
        environment: environment?.name ?? "",
        placement: environment?.type === "shared" ? "shared" : "sandbox",
        agent: environment?.agents[0] ?? kind,
        model: environment?.model,
        round: status === "waiting" ? 0 : 1,
        startedAt: status === "waiting" ? undefined : now,
        detail: status === "starting" ? "Creating sandbox (small, restricted network)" : status === "waiting" ? "Waiting for Log parser" : undefined,
      };
    };
    this.replace(id, (current) => ({
      ...current,
      status: "building",
      taskCount: 2,
      plan: {
        summary: "Two tasks: an NDJSON **log parser** and the **summary CLI** that prints counts, top messages, and the time range.",
        projectName: "logsum",
        packageDescription: "Summarize newline-delimited JSON logs.",
        bin: { logsum: "bin/logsum.js" },
        integration: "Pipe a sample log through `logsum` and compare the summary with a hand-written expectation.",
        tasks: [
          {
            id: "log-parser",
            title: "Log parser",
            description: "Parse NDJSON lines into records, count invalid lines, and filter by `--since`.",
            files: ["src/parse.js", "test/parse.test.js"],
            interface: "export function parseLines(text: string, options?: { since?: Date }): { records: LogRecord[]; invalid: number };",
            acceptance: ["Invalid JSON lines are counted and skipped", "`since` filters older records"],
            dependsOn: [],
          },
          {
            id: "summary-cli",
            title: "Summary CLI",
            description: "Aggregate and print the summary.",
            files: ["bin/logsum.js", "src/summary.js", "test/cli.test.js"],
            acceptance: ["Prints counts by level", "Prints the top 5 messages"],
            dependsOn: ["log-parser"],
          },
        ],
      },
      stations: [
        ...current.stations.map((station) => (station.id === "plan" ? { ...station, status: "done" as const, finishedAt: now, detail: "Planned 2 tasks" } : station)),
        make("build:log-parser", "build", "Build · Log parser", "log-parser", "starting"),
        make("review:log-parser", "review", "Review · Log parser", "log-parser", "waiting"),
        make("build:summary-cli", "build", "Build · Summary CLI", "summary-cli", "waiting"),
        make("review:summary-cli", "review", "Review · Summary CLI", "summary-cli", "waiting"),
        make("release", "release", "Release", undefined, "waiting"),
      ],
    }));
    await delay(3500);
    if (!this.isActive(id)) return;
    this.updateStation(id, "build:log-parser", {
      status: "working",
      detail: "Writing src/parse.js",
      sessionId: `ses_${(Date.now() + 1).toString(16)}`,
      sessionState: "running",
      turn: { kind: "work", round: 1, sentAt: now },
      sandbox: {
        id: "sbx_01JB9LOGPARSER7Q3K9W2D5M8X",
        size: "small",
        state: "running",
        image: "ghcr.io/contoso/factory-workshop@sha256:4f0c9e2b7d1a6e3f5c8b2a9d0e7f1c3b5a6d8e9f0a1b2c3d4e5f6a7b8c9d0e1f",
        network: builder?.network ?? { access: "restricted", allowedDomains: [] },
        startedAt: now,
      },
    });
    this.push(id, "build:log-parser", { kind: "status", text: "Sandbox ready (small · 1 vCPU · 2 GiB, restricted network)" });
    while (this.isActive(id)) {
      await this.tool(id, "build:log-parser", "create", "src/parse.js", 1400);
      await this.tool(id, "build:log-parser", "bash", "node --test test/parse.test.js", 1800, { output: "ℹ tests 6\nℹ pass 6\nℹ fail 0" });
      await delay(7000);
    }
  }
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
  if (window.innerWidth < 720) {
    document.body.appendChild(banner);
    document.documentElement.style.setProperty("--preview-offset", "30px");
    return;
  }
  const links = document.createElement("span");
  links.style.cssText = "display:flex;gap:12px";
  for (const name of VARIANTS) {
    const link = document.createElement("a");
    link.href = `?preview${name ? `=${name}` : ""}${location.hash}`;
    link.textContent = name || "default";
    link.style.cssText =
      name === variant ? "color:var(--fgColor-default);font-weight:600;text-decoration:none" : "color:var(--fgColor-accent);text-decoration:none";
    links.appendChild(link);
  }
  banner.appendChild(links);
  document.body.appendChild(banner);
  document.documentElement.style.setProperty("--preview-offset", "30px");
}

export function installPreview(): void {
  const variant = new URLSearchParams(window.location.search).get("preview") ?? "";
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
  showBanner(variant);
  server.start();
}
