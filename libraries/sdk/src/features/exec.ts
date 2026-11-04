// Workspace-only sandboxes (`managed.sandboxes`) and commands run directly in any sandbox the caller owns (`managed.exec`).
import { randomBytes } from "node:crypto";
import { isManagedCopilotError, ManagedCopilotError, ROUTES, type ExecInfo, type ExecResult, type SessionInfo } from "@managed-copilot/protocol";
import type { HttpClient } from "../http.js";
import type { ExecHandle, ExecOptions, ManagedContext, ManagedSandbox, ManagedSandboxes } from "../types.js";
import { requireActor } from "../identity.js";
import { checkEnvironment, toEnvironmentRequest } from "./client.js";

/** One long poll: the gateway answers within 30 s. */
const POLL_MS = 25_000;
/** How long an answer may take: a stopped sandbox starts again first. */
const ANSWER_MS = 5 * 60_000;
/** Creating a sandbox runs its environment's setup. */
const CREATE_MS = 20 * 60_000;
/** Output one result keeps (the newest bytes), like the gateway's journal. */
const RESULT_BYTES = 1024 * 1024;
/** Waits for the end without reading output (offsets past the end wait for new output or the end). */
const END_ONLY = Number.MAX_SAFE_INTEGER;

function turnedOff(environment: string): ManagedCopilotError {
  return new ManagedCopilotError("policy_violation", `Running commands directly is turned off for environment ${environment}.`, { environment });
}

export function createSandboxesApi(ctx: ManagedContext): ManagedSandboxes {
  return {
    async create(options) {
      if (!options || options.environment === undefined) throw new ManagedCopilotError("invalid_request", "Pass environment: the name of an isolated environment.");
      requireActor(ctx.identity, "managed.sandboxes.create(...)");
      const request = toEnvironmentRequest(options.environment);
      checkEnvironment(ctx.info, request);
      const declared = request.name !== undefined ? ctx.info.environments.find((environment) => environment.name === request.name) : undefined;
      if (declared && declared.type !== "isolated") {
        throw new ManagedCopilotError("invalid_request", `Environment "${declared.name}" is ${declared.type}; workspace-only sandboxes need an isolated environment.`);
      }
      if (declared?.exec === false) throw turnedOff(declared.name);
      const info = await ctx.http.post<SessionInfo>(
        ROUTES.sandboxes,
        { environment: typeof options.environment === "string" ? options.environment : request, ...(options.sessionId ? { sessionId: options.sessionId } : {}) },
        { timeoutMs: CREATE_MS, ...(options.signal ? { signal: options.signal } : {}) },
      );
      return { ...info, sessionId: info.id };
    },

    async list() {
      const sessions = await ctx.http.get<SessionInfo[]>(ROUTES.sessions, { query: { limit: 1000 } });
      return sessions.filter((session) => session.kind === "workspace").map((session): ManagedSandbox => ({ ...session, sessionId: session.id }));
    },
  };
}

/** Appends output, keeping the newest `RESULT_BYTES` and counting what it dropped. */
class Collected {
  #parts: string[] = [];
  #bytes = 0;
  skipped = 0;

  add(output: string, skipped = 0): void {
    this.skipped += skipped;
    if (!output) return;
    this.#parts.push(output);
    this.#bytes += Buffer.byteLength(output, "utf8");
    if (this.#bytes > RESULT_BYTES * 2) this.#trim();
  }

  #trim(): void {
    const kept = Buffer.from(this.#parts.join(""), "utf8").subarray(-RESULT_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
    const bytes = Buffer.byteLength(kept, "utf8");
    this.skipped += this.#bytes - bytes;
    this.#parts = [kept];
    this.#bytes = bytes;
  }

  text(): string {
    if (this.#bytes > RESULT_BYTES) this.#trim();
    return this.#parts.join("");
  }
}

function read(http: HttpClient, sessionId: string, execId: string, offset: number, waitMs: number, signal?: AbortSignal): Promise<ExecResult> {
  return http.get<ExecResult>(ROUTES.execItem(sessionId, execId), { query: { offset, waitMs }, timeoutMs: ANSWER_MS, ...(signal ? { signal } : {}) });
}

/** Reads from `offset` to the end of the command's output (it ended), adding to `collected`. */
async function drain(http: HttpClient, sessionId: string, execId: string, from: ExecResult, collected: Collected): Promise<ExecResult> {
  let last = from;
  let offset = from.offset;
  for (;;) {
    if (last.state === "running" || offset >= last.outputBytes) return { ...last, offset };
    const next = await read(http, sessionId, execId, offset, 0);
    collected.add(next.output, next.skippedBytes);
    if (next.output === "" && next.offset === offset) return next;
    offset = next.offset;
    last = next;
  }
}

/** Starts the command; a start whose answer was lost is found again by its ID (it never runs twice). */
async function start(http: HttpClient, sessionId: string, command: string, id: string, options: ExecOptions, background: boolean): Promise<ExecResult> {
  const body = {
    command,
    id,
    ...(background ? { background: true, waitMs: 0 } : { waitMs: POLL_MS }),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  };
  try {
    return await http.post<ExecResult>(ROUTES.exec(sessionId), body, { timeoutMs: ANSWER_MS, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    if (!isManagedCopilotError(error, "timeout") && !isManagedCopilotError(error, "capability_unavailable")) throw error;
    try {
      return await read(http, sessionId, id, 0, 0);
    } catch {
      throw error;
    }
  }
}

export async function runExec(ctx: ManagedContext, sessionId: string, command: string, options: ExecOptions = {}): Promise<ExecResult | ExecHandle> {
  if (typeof command !== "string" || command.trim() === "") throw new ManagedCopilotError("invalid_request", "Pass the command to run, e.g. managed.exec(sandbox, \"ls -la\").");
  const http = ctx.httpFor(sessionId);
  const id = options.id ?? `ex_${randomBytes(12).toString("hex")}`;
  const background = options.background === true;
  let first: ExecResult;
  let stopped = false;
  try {
    first = await start(http, sessionId, command, id, options, background);
  } catch (error) {
    // Cancelled while starting: the command may have started anyway, so it is stopped by its ID and its record returned.
    if (background || !options.signal?.aborted) throw error;
    stopped = true;
    await http.post<ExecInfo>(ROUTES.execStop(sessionId, id), {}, { timeoutMs: ANSWER_MS }).catch(() => undefined);
    try {
      first = await read(http, sessionId, id, 0, 0);
    } catch {
      throw error;
    }
  }
  if (background) return backgroundHandle(http, sessionId, first);

  const collected = new Collected();
  collected.add(first.output, first.skippedBytes);
  let last = first;
  while (last.state === "running") {
    if (options.signal?.aborted && !stopped) {
      stopped = true;
      await http.post<ExecInfo>(ROUTES.execStop(sessionId, id), {}, { timeoutMs: ANSWER_MS }).catch(() => undefined);
    }
    const next = await read(http, sessionId, id, last.offset, stopped ? 0 : POLL_MS, stopped ? undefined : options.signal).catch((error: unknown) => {
      if (options.signal?.aborted) return undefined;
      throw error;
    });
    if (!next) continue;
    collected.add(next.output, next.skippedBytes);
    last = next;
  }
  last = await drain(http, sessionId, id, last, collected);
  const output = collected.text();
  const { skippedBytes: _skipped, ...info } = last;
  return { ...info, output, ...(collected.skipped > 0 ? { skippedBytes: collected.skipped } : {}) };
}

function backgroundHandle(http: HttpClient, sessionId: string, started: ExecResult): ExecHandle {
  const id = started.id;
  let result: Promise<ExecResult> | undefined;
  return {
    id,
    sessionId,
    command: started.command,
    output: {
      async *[Symbol.asyncIterator]() {
        let offset = 0;
        for (;;) {
          const next = await read(http, sessionId, id, offset, POLL_MS);
          if (next.output) yield next.output;
          const moved = next.offset !== offset;
          offset = next.offset;
          if (next.state !== "running" && (!moved || offset >= next.outputBytes)) return;
        }
      },
    },
    get result() {
      result ??= (async () => {
        let last = await read(http, sessionId, id, END_ONLY, POLL_MS);
        while (last.state === "running") last = await read(http, sessionId, id, END_ONLY, POLL_MS);
        const collected = new Collected();
        const first = await read(http, sessionId, id, 0, 0);
        collected.add(first.output, first.skippedBytes);
        const final = await drain(http, sessionId, id, first, collected);
        const { skippedBytes: _skipped, ...info } = final;
        return { ...info, output: collected.text(), ...(collected.skipped > 0 ? { skippedBytes: collected.skipped } : {}) };
      })();
      return result;
    },
    async write(data: string) {
      await http.post<ExecInfo>(ROUTES.execInput(sessionId, id), { data }, { timeoutMs: ANSWER_MS });
    },
    async end(data?: string) {
      await http.post<ExecInfo>(ROUTES.execInput(sessionId, id), { ...(data !== undefined ? { data } : {}), eof: true }, { timeoutMs: ANSWER_MS });
    },
    stop() {
      return http.post<ExecInfo>(ROUTES.execStop(sessionId, id), {}, { timeoutMs: ANSWER_MS });
    },
    info() {
      return read(http, sessionId, id, END_ONLY, 0).then(({ output: _output, offset: _offset, skippedBytes: _skipped, ...info }) => info);
    },
  };
}

/** The commands run in a session's sandbox, oldest first. */
export function listExecs(ctx: ManagedContext, sessionId: string): Promise<ExecInfo[]> {
  return ctx.httpFor(sessionId).get<ExecInfo[]>(ROUTES.exec(sessionId));
}
