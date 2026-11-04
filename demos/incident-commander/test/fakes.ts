// Fakes for unit tests: a platform whose coordinator sessions record what the app does with them.
import { fileURLToPath } from "node:url";
import type { MessageOptions, PermissionRequest, PermissionRequestResult, ResumeSessionConfig, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import type { ExecInfo, SessionInfo, WorkerInfo } from "@managed-copilot/sdk";
import type { PlatformStatus } from "../src/shared/types.js";
import type { AppConfig } from "../src/server/config.js";
import type { CoordinatorSession, IncidentPlatform } from "../src/server/platform.js";

type Config = SessionConfig | ResumeSessionConfig;

export class FakeSession implements CoordinatorSession {
  readonly sent: MessageOptions[] = [];
  disconnected = 0;

  constructor(
    readonly sessionId: string,
    readonly config: Config,
  ) {}

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    return `message-${this.sent.length}`;
  }

  async disconnect(): Promise<void> {
    this.disconnected++;
  }

  emit(event: Partial<SessionEvent> & { type: string; data?: unknown }): void {
    this.config.onEvent?.({ id: `event-${Math.random()}`, timestamp: new Date().toISOString(), parentId: null, ephemeral: false, data: {}, ...event } as unknown as SessionEvent);
  }

  permission(request: PermissionRequest): Promise<PermissionRequestResult> {
    return Promise.resolve(this.config.onPermissionRequest!(request, { sessionId: this.sessionId }) as PermissionRequestResult);
  }

  tool(name: string): Tool<unknown> {
    const tool = (this.config.tools ?? []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool as Tool<unknown>;
  }

  /** Runs one of the app's tools the way the runtime would. */
  async call(name: string, args: unknown, toolCallId = "call-1"): Promise<unknown> {
    return this.tool(name).handler!(args, { sessionId: this.sessionId, toolCallId, toolName: name, arguments: args });
  }
}

export function deployRequest(args: Record<string, unknown>, toolCallId = "deploy-call"): PermissionRequest {
  return { kind: "custom-tool", toolName: "deploy_fix", toolCallId, toolDescription: "Deploys the verified fix", args } as PermissionRequest;
}

export function worker(overrides: Partial<WorkerInfo> & Pick<WorkerInfo, "id" | "name">): WorkerInfo {
  const now = new Date().toISOString();
  return { coordinatorId: "coordinator", environment: "incident-commander-node", state: "working", task: "", messages: 1, createdAt: now, updatedAt: now, role: "worker", ...overrides };
}

export class FakePlatform implements IncidentPlatform {
  status: PlatformStatus = {
    state: "connected",
    url: "http://gateway.test",
    mode: "local",
    deployment: "copilot",
    account: { login: "octocat" },
    environments: [
      { name: "incident-commander", role: "coordinator", network: "Off" },
      { name: "incident-commander-triage", role: "own", network: "Off" },
      { name: "incident-commander-node", role: "worker", network: "registry.npmjs.org only" },
    ],
  };
  readonly url = "http://gateway.test";
  readonly sessions: FakeSession[] = [];
  readonly files = new Map<string, string>();
  readonly deleted: string[] = [];
  workerList: WorkerInfo[] = [];
  execList: ExecInfo[] = [];
  lastTurn: SessionInfo["lastTurn"] = { turnId: "turn-1", status: "running" };
  /** Runs right after a resume, while the resume is still "in flight" (where the platform replays waiting requests). */
  onResume: ((session: FakeSession) => Promise<void> | void) | undefined;
  #created = 0;

  onStatus(): () => void {
    return () => undefined;
  }

  onConnected(): () => void {
    return () => undefined;
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    this.#requireConnected();
    const session = new FakeSession(`coordinator-${++this.#created}`, config);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<FakeSession> {
    this.#requireConnected();
    const session = new FakeSession(sessionId, config);
    this.sessions.push(session);
    await this.onResume?.(session);
    return session;
  }

  #requireConnected(): void {
    if (this.status.state !== "connected") throw new Error("Managed Copilot isn't connected yet.");
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    return {
      id: sessionId,
      environment: "incident-commander",
      type: "orchestrator",
      placement: "shared",
      state: "running",
      owner: { id: 1, login: "octocat" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingActions: [],
      ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
    };
  }

  async workers(): Promise<WorkerInfo[]> {
    return this.workerList;
  }

  async execs(): Promise<ExecInfo[]> {
    return this.execList;
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    this.files.set(`${sandboxId}:${path}`, content);
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const content = this.files.get(`${sandboxId}:${path}`);
    if (content === undefined) throw new Error(`No such file: ${path}`);
    return content;
  }

  /** The most recent session object. */
  get session(): FakeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("No session yet");
    return session;
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 7445,
    host: "127.0.0.1",
    dataDir: "",
    dev: false,
    packageRoot: "",
    webRoot: "",
    environment: "incident-commander",
    model: "claude-sonnet-5",
    publicUrl: "http://localhost:7445",
    alertSecret: "alert-secret",
    webhookSecret: "webhook-secret",
    demoServicesDir: fileURLToPath(new URL("../demo-services", import.meta.url)),
    healthIntervalMs: 60_000,
    pollIntervalMs: 60_000,
    ...overrides,
  };
}

/** Lets queued callbacks (setImmediate, resolved promises) run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
