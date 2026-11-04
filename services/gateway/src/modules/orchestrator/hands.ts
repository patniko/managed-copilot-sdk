// The hands of a direct or mixed coordinator (proposal "direct execution", spec
// section 17): the stock shell and file tools' names and shapes (`bash`, `read_bash`, `write_bash`, `stop_bash`,
// `list_bash`, `view`, `create`, `edit`, `glob`, `grep`), registered as gateway platform tools that override the
// runtime's built-ins, so the coordinator and its stock sub-agents act in a workspace-only sandbox instead of the
// shared runtime's host. Commands run through the sandbox service's exec journal (as uid 10001 in /workspace); `view`,
// `glob`, and `grep` are commands too (they follow links only inside /workspace); `create` and `edit` go through the
// sandbox's file worker (which refuses links), `edit` as an atomic compare-and-replace.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { HANDS_TOOLS, isManagedCopilotError, ManagedCopilotError, type ExecInfo, type ExecResult } from "@managed-copilot/protocol";
import type { PlatformToolCallContext } from "../core/contracts.js";
import type { SandboxesService } from "../sandbox/contract.js";
import type { HandsSandbox, WorkerManager } from "./service.js";

/** `bash` waits this long by default for a sync command (seconds), and at most `BASH_MAX_WAIT_SECONDS`. */
export const BASH_DEFAULT_WAIT_SECONDS = 120;
export const BASH_MAX_WAIT_SECONDS = 1_800;
/** Core's own platform-tool path (no actions ledger) gives a call 10 minutes; waits stay under it there. */
const CORE_PATH_WAIT_MS = 9 * 60_000;
/** One sandboxd read waits at most this long. */
const READ_SLICE_MS = 25_000;
/** What a tool result shows of a command's output: its start and its end. */
const OUTPUT_HEAD = 4_000;
const OUTPUT_TAIL = 26_000;
/** `view` without `forceReadLargeFiles` or a range shows this much of a file, and at most `VIEW_MAX_BYTES` with it. */
const VIEW_BYTES = 20 * 1024;
const VIEW_MAX_BYTES = 256 * 1024;
const LISTING_LINES = 1_000;
/** `edit` reads and rewrites files up to this size. */
const EDIT_MAX_BYTES = 8 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 120_000;
const HELPER_WAIT_MS = 60_000;

const WORKSPACE = "/workspace";

export interface HandsToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Commands and writes ask the session's permission, once per call; reads and stops don't. */
  readonly skipPermission: boolean;
  /** Commands and input are never run again after a restart: they reattach or report that they may have run. */
  readonly replay: "always" | "never";
}

const STRING = { type: "string" } as const;
const PATHS = { anyOf: [STRING, { type: "array", items: STRING }], description: "One directory or an array of directories under /workspace; defaults to /workspace." } as const;

/** Parameters mirror the stock runtime 1.0.103 tools (`rpc.tools.list` on Linux), without `bash`'s `detach`. */
export const HANDS_TOOL_DEFINITIONS: readonly HandsToolDefinition[] = [
  {
    name: HANDS_TOOLS.bash,
    description: [
      "Runs a Bash command in your Linux sandbox (as an unprivileged user, in /workspace).",
      "* Each call runs in a fresh bash process in /workspace: cd and environment variables do not carry over between calls.",
      "* You can run Python and Node.js code with `python3` and `node`, and install packages with `pip` and `npm` when the sandbox has network access.",
      `* \`initial_wait\` defaults to ${BASH_DEFAULT_WAIT_SECONDS} seconds (at most ${BASH_MAX_WAIT_SECONDS}). A command still running then returns its output so far and a shellId, and keeps running: use \`read_bash\` for more output, \`write_bash\` for input, or \`stop_bash\` to stop it.`,
      '* `mode: "async"` starts the command and returns its shellId at once.',
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The Bash command and arguments to run." },
        description: {
          type: "string",
          description: 'A short human-readable description of what the command does, limited to 100 characters, for example "List files in the current directory", "Install dependencies with npm" or "Run RSpec tests".',
        },
        shellId: { type: "string", description: "(Optional) A name for this command to use with read_bash, write_bash, and stop_bash. The result also gives its ID." },
        mode: {
          type: "string",
          enum: ["sync", "async"],
          description: 'Execution mode: "sync" runs synchronously and waits for completion (default), "async" runs in the background. You can read output from "async" commands using the `read_bash` tool.',
        },
        initial_wait: {
          type: "number",
          description: `(Optional) Time in seconds to wait for the command when mode is "sync". The command continues running in the background after this time. Default is ${BASH_DEFAULT_WAIT_SECONDS} seconds, at most ${BASH_MAX_WAIT_SECONDS}.`,
        },
      },
      required: ["command", "description"],
    },
    skipPermission: false,
    replay: "never",
  },
  {
    name: HANDS_TOOLS.readBash,
    description: [
      "Reads output from a Bash command in your sandbox.",
      "* The shellId MUST be the one the bash call returned (or the name you gave it).",
      "* Waits up to `delay` seconds and returns the output the command printed since your last read; it returns sooner when the command ends.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        shellId: { type: "string", description: "The ID of the command, from its bash call." },
        delay: { type: "number", description: "The amount of time in seconds to wait for output." },
      },
      required: ["shellId", "delay"],
    },
    skipPermission: true,
    replay: "always",
  },
  {
    name: HANDS_TOOLS.writeBash,
    description: [
      "Sends input to a running Bash command in your sandbox, then reads its output.",
      "* Text is sent as typed; {enter} sends a newline, {tab} a tab, and {ctrl+d} closes its input. Use stop_bash to interrupt a command.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        shellId: { type: "string", description: "The ID of the command, from its bash call." },
        input: { type: "string", description: "The input to send." },
        delay: { type: "number", description: "(Optional) Seconds to wait for output after sending (default 10)." },
      },
      required: ["shellId", "input"],
    },
    skipPermission: false,
    replay: "never",
  },
  {
    name: HANDS_TOOLS.stopBash,
    description: "Stops a running Bash command in your sandbox by terminating its process group.",
    parameters: { type: "object", properties: { shellId: { type: "string", description: "The ID of the command, from its bash call." } }, required: ["shellId"] },
    skipPermission: true,
    replay: "always",
  },
  {
    name: HANDS_TOOLS.listBash,
    description: "Lists the Bash commands in your sandbox with their shellId, state, and command, newest last.",
    parameters: { type: "object", properties: {}, required: [] },
    skipPermission: true,
    replay: "always",
  },
  {
    name: HANDS_TOOLS.view,
    description: [
      "View files or directories in your sandbox.",
      "* Text files return their content with line numbers.",
      "* Directories list non-hidden entries up to 2 levels deep.",
      "* `path` must be absolute, under /workspace.",
      "* Files over 20KB are truncated; use `view_range` for sections.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Existing file or directory's absolute path." },
        view_range: { type: "array", items: { type: "integer" }, description: "Optional 1-based inclusive line range. [start,-1] reads through EOF. Prefer for files over 20KB, which are otherwise truncated." },
        forceReadLargeFiles: { type: "boolean", description: "Read an entire large file despite the size limit (up to 256KB); default false." },
      },
      required: ["path"],
    },
    skipPermission: true,
    replay: "always",
  },
  {
    name: HANDS_TOOLS.create,
    description: [
      "Tool for creating new files in your sandbox.",
      "* Creates a new file with the specified content at the given path, and its parent directories",
      "* Cannot be used if the specified path already exists",
      "* Path *MUST* be absolute, under /workspace",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full absolute path to file to create. File MUST not exist before creating." },
        file_text: { type: "string", description: "The content of the file to be created." },
      },
      required: ["path", "file_text"],
    },
    skipPermission: false,
    replay: "always",
  },
  {
    name: HANDS_TOOLS.edit,
    description: [
      "Tool for making string replacements in files in your sandbox.",
      "* Replaces exactly one occurrence of `old_str` with `new_str` in the specified file",
      "* The `old_str` parameter must match EXACTLY one or more consecutive lines from the original file",
      "* If `old_str` is not unique in the file, replacement will not be performed",
      "* If the file changed while the edit was made (another agent or a command wrote it), the edit fails: view it again and retry",
      "* Path *MUST* be absolute, under /workspace",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Full absolute path to file to edit. File MUST exist to edit." },
        old_str: { type: "string", description: "The string in the file to replace. Leading and ending whitespaces from file content should be preserved!" },
        new_str: { type: "string", description: "The new string to replace old_str with." },
      },
      required: ["path"],
    },
    skipPermission: false,
    // An edit applied twice can change a file twice (when new_str contains old_str): it is never rerun.
    replay: "never",
  },
  {
    name: HANDS_TOOLS.glob,
    description: "Find files in your sandbox quickly by glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob to match, e.g. "**/*.js", "src/**/*.ts", or "*.{ts,tsx}".' },
        paths: PATHS,
      },
      required: ["pattern"],
    },
    skipPermission: true,
    replay: "always",
  },
  {
    name: HANDS_TOOLS.grep,
    description: "Search file contents in your sandbox quickly and precisely with ripgrep.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for in file contents." },
        paths: PATHS,
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output: matching lines (content, with context/line-number options), matching file paths (files_with_matches, default), or per-file counts (count).",
        },
        glob: { type: "string", description: 'File glob filter, e.g. "*.js" or "*.{ts,tsx}".' },
        type: { type: "string", description: "File type filter, e.g. js, py, rust, go, or java; tsx/jsx normalize to ts/js." },
        "-i": { type: "boolean", description: "Case-insensitive search." },
        "-A": { type: "number", description: "Context lines after matches; requires content mode." },
        "-B": { type: "number", description: "Context lines before matches; requires content mode." },
        "-C": { type: "number", description: "Context lines around matches; requires content mode." },
        "-n": { type: "boolean", description: '"-n": true adds line numbers; requires content mode.' },
        head_limit: { type: "number", description: "Return first N results." },
        multiline: { type: "boolean", description: "Allow cross-line patterns; default false." },
      },
      required: ["pattern"],
    },
    skipPermission: true,
    replay: "always",
  },
];

type Handler = (args: unknown, context: PlatformToolCallContext) => Promise<string>;

/** The handlers of the hands tools, and the `recover` hooks of those that never run again. */
export class HandsTools {
  readonly #manager: WorkerManager;
  readonly #sandboxes: () => SandboxesService;
  /** Read offsets per command (`<sandbox session>:<exec ID>`): `read_bash` returns what is new since the last read. */
  readonly #offsets = new Map<string, number>();
  /** Names the model gave commands (`<sandbox session>:<name>` → exec ID). */
  readonly #aliases = new Map<string, string>();

  constructor(manager: WorkerManager, sandboxes: () => SandboxesService) {
    this.#manager = manager;
    this.#sandboxes = sandboxes;
  }

  handlers(): Record<string, Handler> {
    return {
      [HANDS_TOOLS.bash]: (args, context) => this.bash(args, context),
      [HANDS_TOOLS.readBash]: (args, context) => this.readBash(args, context),
      [HANDS_TOOLS.writeBash]: (args, context) => this.writeBash(args, context),
      [HANDS_TOOLS.stopBash]: (args, context) => this.stopBash(args, context),
      [HANDS_TOOLS.listBash]: (args, context) => this.listBash(args, context),
      [HANDS_TOOLS.view]: (args, context) => this.view(args, context),
      [HANDS_TOOLS.create]: (args, context) => this.create(args, context),
      [HANDS_TOOLS.edit]: (args, context) => this.edit(args, context),
      [HANDS_TOOLS.glob]: (args, context) => this.glob(args, context),
      [HANDS_TOOLS.grep]: (args, context) => this.grep(args, context),
    };
  }

  recoverers(): Record<string, Handler> {
    return {
      [HANDS_TOOLS.bash]: (args, context) => this.bash(args, context, { recovering: true }),
      [HANDS_TOOLS.edit]: async (args) => {
        const path = optionalString(record(args)["path"]) ?? "the file";
        return `The platform restarted while this edit of ${path} was being made, so it may or may not have been applied. It was not made again: view the file before editing it again.`;
      },
      [HANDS_TOOLS.writeBash]: async (args) => {
        const shellId = optionalString(record(args)["shellId"]) ?? "the command";
        return `The platform restarted while this input was being sent to ${shellId}, so it may or may not have been sent. It was not sent again: read the command's output with read_bash before sending it again.`;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Commands

  async bash(args: unknown, context: PlatformToolCallContext, options: { readonly recovering?: boolean } = {}): Promise<string> {
    const input = record(args);
    const command = requiredString(input["command"], "command");
    const mode = input["mode"] === "async" ? "async" : "sync";
    const requested = typeof input["initial_wait"] === "number" && Number.isFinite(input["initial_wait"]) ? input["initial_wait"] : BASH_DEFAULT_WAIT_SECONDS;
    const waitSeconds = Math.min(Math.max(requested, 1), BASH_MAX_WAIT_SECONDS);
    // Bound to this call before the command starts: a replay reattaches there, never starts it elsewhere.
    const hands = await this.#manager.handsForCall(context);
    const result = await this.#sandboxes().exec(hands.record.id, command, {
      // A replay of this call (after a restart) reattaches to the same command: it never runs twice.
      actionId: context.idempotencyKey,
      background: mode === "async",
      stdin: "open",
      waitMs: mode === "async" ? 0 : capWait(waitSeconds * 1000, context),
      // A cancelled sync call stops its command; an async one runs on until stop_bash, idle stop, or deletion.
      ...(mode === "sync" && context.signal ? { signal: context.signal } : {}),
      sandboxId: hands.sandboxId,
      caller: caller(HANDS_TOOLS.bash, context),
    });
    const name = optionalString(input["shellId"]);
    if (name && name !== result.id) this.#aliases.set(`${hands.record.id}:${name}`, result.id);
    this.#offsets.set(`${hands.record.id}:${result.id}`, result.offset);
    const note = options.recovering ? "The platform restarted while this command ran. This is the same command (it was not run again):\n" : "";
    if (mode === "async" && result.state === "running") {
      return `${note}${clipOutput(result)}<command started in the background with shellId: ${result.id}. Use read_bash to read its output, write_bash to send input, and stop_bash to stop it.>`;
    }
    return `${note}${clipOutput(result)}${statusLine(result, waitSeconds)}`;
  }

  async readBash(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const hands = await this.#manager.hands(context);
    const execId = this.#resolve(hands, requiredString(input["shellId"], "shellId"));
    const delay = typeof input["delay"] === "number" && Number.isFinite(input["delay"]) ? Math.min(Math.max(input["delay"], 0), BASH_MAX_WAIT_SECONDS) : 10;
    const result = await this.#readFor(hands, execId, capWait(delay * 1000, context), context.signal);
    return `${clipOutput(result)}${statusLine(result, delay, "after")}`;
  }

  async writeBash(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const hands = await this.#manager.hands(context);
    const execId = this.#resolve(hands, requiredString(input["shellId"], "shellId"));
    const raw = input["input"];
    if (typeof raw !== "string") throw new ManagedCopilotError("invalid_request", "input is required");
    if (/\{ctrl\+c\}/i.test(raw)) throw new ManagedCopilotError("invalid_request", "Ctrl+C can't be sent through the command's input; use stop_bash to stop it.");
    const eof = /\{ctrl\+d\}\s*$/i.test(raw);
    const data = translateKeys(raw.replace(/\{ctrl\+d\}\s*$/i, ""));
    try {
      await this.#sandboxes().writeExec(hands.record.id, execId, { ...(data ? { data } : {}), ...(eof ? { eof: true } : {}) }, { sandboxId: hands.sandboxId });
    } catch (error) {
      if (isManagedCopilotError(error, "conflict")) throw new ManagedCopilotError("conflict", `Command ${execId} takes no more input: it ended, or its input was closed.`);
      throw error;
    }
    const delay = typeof input["delay"] === "number" && Number.isFinite(input["delay"]) ? Math.min(Math.max(input["delay"], 0), 300) : 10;
    const result = await this.#readFor(hands, execId, capWait(delay * 1000, context), context.signal);
    return `${clipOutput(result)}${statusLine(result, delay, "after")}`;
  }

  async stopBash(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const hands = await this.#manager.hands(context);
    const execId = this.#resolve(hands, requiredString(record(args)["shellId"], "shellId"));
    const info = await this.#sandboxes().stopExec(hands.record.id, execId, { sandboxId: hands.sandboxId, reason: "Stopped with stop_bash." });
    return info.state === "stopped" ? `Stopped command ${execId}.` : `Command ${execId} had already ended (${describeState(info)}).`;
  }

  async listBash(_args: unknown, context: PlatformToolCallContext): Promise<string> {
    const hands = await this.#manager.hands(context);
    const commands = this.#sandboxes()
      .listExecs(hands.record.id, { sandboxId: hands.sandboxId })
      .filter((info) => info.caller?.kind === "platform" && info.caller.name === HANDS_TOOLS.bash);
    if (commands.length === 0) return "No commands in your sandbox yet.";
    const shown = commands.slice(-50);
    return [
      `Commands in your sandbox${commands.length > shown.length ? ` (the latest ${shown.length} of ${commands.length})` : ""}:`,
      ...shown.map((info) => `- shellId ${info.id} · ${describeState(info)} · started ${info.startedAt} · ${clipLine(info.command, 200)}`),
    ].join("\n");
  }

  async #readFor(hands: HandsSandbox, execId: string, waitMs: number, signal: AbortSignal | undefined): Promise<ExecResult> {
    const key = `${hands.record.id}:${execId}`;
    const start = this.#offsets.get(key) ?? 0;
    const deadline = Date.now() + waitMs;
    let offset = start;
    // Keeps what the result can show (its start and end), however long the command prints.
    let head = "";
    let tail = "";
    let omitted = 0;
    const append = (text: string) => {
      if (head.length < OUTPUT_HEAD) {
        const room = OUTPUT_HEAD - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      tail += text;
      if (tail.length > OUTPUT_TAIL) {
        omitted += tail.length - OUTPUT_TAIL;
        tail = tail.slice(-OUTPUT_TAIL);
      }
    };
    let skipped = 0;
    let result: ExecResult;
    for (;;) {
      try {
        result = await this.#sandboxes().readExec(hands.record.id, execId, {
          offset,
          waitMs: Math.max(0, Math.min(READ_SLICE_MS, deadline - Date.now())),
          sandboxId: hands.sandboxId,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isManagedCopilotError(error, "not_found")) throw new ManagedCopilotError("not_found", `Your sandbox has no command ${execId}. list_bash shows its commands.`);
        throw error;
      }
      append(result.output);
      skipped += result.skippedBytes ?? 0;
      const advanced = result.offset > offset;
      offset = result.offset;
      // An ended command's output is read to its end (one read returns at most a slice of it).
      if (result.state !== "running") {
        if (!advanced || offset >= result.outputBytes) break;
        continue;
      }
      if (Date.now() >= deadline || signal?.aborted) break;
    }
    this.#offsets.set(key, offset);
    const output = omitted > 0 ? `${head}\n[… ${omitted} characters of output omitted …]\n${tail}` : head + tail;
    return { ...result, output, offset, ...(skipped > 0 ? { skippedBytes: skipped } : {}) };
  }

  #resolve(hands: HandsSandbox, shellId: string): string {
    return this.#aliases.get(`${hands.record.id}:${shellId}`) ?? shellId;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Files

  async view(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const path = absolutePath(requiredString(input["path"], "path"));
    const range = viewRange(input["view_range"]);
    const force = input["forceReadLargeFiles"] === true;
    const limit = range || force ? VIEW_MAX_BYTES : VIEW_BYTES;
    const script = [
      ROOT_CHECK,
      `r=$(mc_root ${quote(path)}) || { printf "%s\\n" "$r"; exit 0; }`,
      'if [ -d "$r" ]; then',
      '  echo "__MC_DIR__"',
      `  cd "$r" && find . -mindepth 1 -maxdepth 2 -not -path '*/.*' | sed 's|^\\./||' | LC_ALL=C sort | head -n ${LISTING_LINES + 1}`,
      'elif [ ! -f "$r" ]; then',
      '  echo "__MC_SPECIAL__"',
      'elif [ -s "$r" ] && ! head -c 65536 -- "$r" | grep -qI . ; then',
      '  echo "__MC_BINARY__ $(stat -c %s -- "$r")"',
      "else",
      '  echo "__MC_FILE__ $(stat -c %s -- "$r")"',
      range
        ? `  awk -v a=${range[0]} -v b=${range[1]} 'NR>=a && (b<0 || NR<=b) { print NR". "$0 } b>=0 && NR>b { exit }' "$r" | head -c ${limit}`
        : `  head -c ${limit} -- "$r" | awk '{ print NR". "$0 }'`,
      "fi",
    ].join("\n");
    const { output } = await this.#helper(HANDS_TOOLS.view, script, context);
    const [header = "", ...rest] = output.split("\n");
    const body = rest.join("\n").replace(/\n$/, "");
    const fail = rootFailure(header, path);
    if (fail) throw fail;
    if (header === "__MC_DIR__") {
      const entries = body ? body.split("\n") : [];
      if (entries.length === 0) return `${path} is an empty directory.`;
      const shown = entries.slice(0, LISTING_LINES);
      return [...shown, ...(entries.length > LISTING_LINES ? [`… more entries not shown; use glob to narrow it down.`] : [])].join("\n");
    }
    if (header === "__MC_SPECIAL__") throw new ManagedCopilotError("invalid_request", `${path} is not a regular file or directory.`);
    if (header.startsWith("__MC_BINARY__")) return `${path} is a binary file (${header.split(" ")[1] ?? "?"} bytes). Inspect it with bash, for example with \`xxd\` or \`file\`.`;
    if (!header.startsWith("__MC_FILE__")) throw new ManagedCopilotError("internal", "The sandbox could not read the file.");
    const size = Number(header.split(" ")[1] ?? 0);
    const truncated = !range && size > limit;
    if (!body && size === 0) return `${path} is empty.`;
    return `${body}${truncated ? `\n[File truncated: showing the first ${limit} of ${size} bytes. Use view_range to read other sections${force ? "" : ", or forceReadLargeFiles"}.]` : ""}`;
  }

  async create(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const path = absolutePath(requiredString(input["path"], "path"));
    const text = input["file_text"];
    if (typeof text !== "string") throw new ManagedCopilotError("invalid_request", "file_text is required");
    const relative = workspaceRelative(path);
    const hands = await this.#manager.hands(context);
    const content = Buffer.from(text, "utf8");
    try {
      await this.#sandboxes().writeFile(hands.record.id, relative, Readable.from([content]), { overwrite: false, size: content.length, sandboxId: hands.sandboxId });
    } catch (error) {
      if (!isManagedCopilotError(error, "conflict")) throw error;
      // The same call again (a replay after a restart) finds the file it created.
      const existing = await this.#readText(hands, relative).catch(() => undefined);
      if (existing && existing.bytes.equals(content)) return `Created file ${path} with ${content.length} characters.`;
      throw new ManagedCopilotError("conflict", `Path already exists: ${path}. Use edit to change it, or bash to replace it.`);
    }
    return `Created file ${path} with ${content.length} characters.`;
  }

  async edit(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const path = absolutePath(requiredString(input["path"], "path"));
    const oldStr = input["old_str"];
    const newStr = input["new_str"] ?? "";
    if (typeof oldStr !== "string" || oldStr.length === 0) throw new ManagedCopilotError("invalid_request", "old_str is required: the exact text to replace.");
    if (typeof newStr !== "string") throw new ManagedCopilotError("invalid_request", "new_str must be a string");
    const relative = workspaceRelative(path);
    const hands = await this.#manager.hands(context);
    const { bytes, text } = await this.#readText(hands, relative);
    const first = text.indexOf(oldStr);
    if (first < 0) throw new ManagedCopilotError("invalid_request", `No match found for old_str in ${path}. View the file and copy the text exactly.`);
    if (text.indexOf(oldStr, first + 1) >= 0) throw new ManagedCopilotError("invalid_request", `Multiple matches found for old_str in ${path}. Include more context to make it unique.`);
    const updated = Buffer.from(text.slice(0, first) + newStr + text.slice(first + oldStr.length), "utf8");
    const ifMatch = createHash("sha256").update(bytes).digest("hex");
    try {
      await this.#sandboxes().writeFile(hands.record.id, relative, Readable.from([updated]), { ifMatch, size: updated.length, sandboxId: hands.sandboxId });
    } catch (error) {
      if (isManagedCopilotError(error, "conflict")) throw new ManagedCopilotError("conflict", `${path} changed while it was being edited (another agent or a command wrote it). View it again and retry the edit.`);
      throw error;
    }
    return `File ${path} updated with changes.`;
  }

  async glob(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const pattern = requiredString(input["pattern"], "pattern");
    const roots = rootsOf(input["paths"]);
    const script = [
      ROOT_CHECK,
      "roots=()",
      ...roots.map((root) => `r=$(mc_root ${quote(root)}) || { printf "%s\\n" "$r"; exit 0; }; roots+=("$r")`),
      `rg --files --no-messages --glob ${quote(pattern)} -- "\${roots[@]}" | head -n ${LISTING_LINES + 1}`,
      'code=${PIPESTATUS[0]}',
      'if [ "$code" != 0 ] && [ "$code" != 1 ] && [ "$code" != 141 ]; then echo "__MC_ERROR__ $code"; fi',
    ].join("\n");
    const { output } = await this.#helper(HANDS_TOOLS.glob, script, context);
    const lines = output.split("\n").filter(Boolean);
    const fail = lines[0] ? rootFailure(lines[0], roots.join(", ")) : undefined;
    if (fail) throw fail;
    if (lines.some((line) => line.startsWith("__MC_ERROR__"))) {
      throw new ManagedCopilotError("invalid_request", `ripgrep failed: ${clipLine(lines.filter((line) => !line.startsWith("__MC_ERROR__")).join(" ") || "check the pattern", 500)}`);
    }
    if (lines.length === 0) return "No files matched the pattern.";
    return [...lines.slice(0, LISTING_LINES), ...(lines.length > LISTING_LINES ? ["… more files matched; narrow the pattern."] : [])].join("\n");
  }

  async grep(args: unknown, context: PlatformToolCallContext): Promise<string> {
    const input = record(args);
    const pattern = requiredString(input["pattern"], "pattern");
    const roots = rootsOf(input["paths"]);
    const mode = input["output_mode"] === "content" || input["output_mode"] === "count" ? input["output_mode"] : "files_with_matches";
    const flags: string[] = ["--no-messages", "--color", "never"];
    if (mode === "files_with_matches") flags.push("--files-with-matches");
    if (mode === "count") flags.push("--count");
    if (mode === "content") {
      flags.push(input["-n"] === true ? "--line-number" : "--no-line-number");
      for (const [option, flag] of [["-A", "--after-context"], ["-B", "--before-context"], ["-C", "--context"]] as const) {
        const value = input[option];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) flags.push(flag, String(Math.min(Math.floor(value), 100)));
      }
    }
    if (input["-i"] === true) flags.push("--ignore-case");
    if (input["multiline"] === true) flags.push("--multiline", "--multiline-dotall");
    const glob = optionalString(input["glob"]);
    if (glob) flags.push("--glob", glob);
    const type = optionalString(input["type"]);
    if (type) flags.push("--type", type === "tsx" ? "ts" : type === "jsx" ? "js" : type);
    const limit = typeof input["head_limit"] === "number" && Number.isFinite(input["head_limit"]) && input["head_limit"] > 0 ? Math.min(Math.floor(input["head_limit"]), LISTING_LINES) : LISTING_LINES;
    const script = [
      ROOT_CHECK,
      "set -o pipefail",
      `roots=()`,
      ...roots.map((root) => `r=$(mc_root ${quote(root)}) || { printf "%s\\n" "$r"; exit 0; }; roots+=("$r")`),
      `rg ${flags.map(quote).join(" ")} --regexp ${quote(pattern)} -- "\${roots[@]}" | head -n ${limit + 1}`,
      'code=${PIPESTATUS[0]}',
      'if [ "$code" = 1 ]; then echo "__MC_NOMATCH__"; elif [ "$code" != 0 ] && [ "$code" != 141 ]; then echo "__MC_ERROR__ $code"; fi',
    ].join("\n");
    const { output } = await this.#helper(HANDS_TOOLS.grep, script, context);
    const lines = output.replace(/\n$/, "").split("\n");
    const fail = lines[0] ? rootFailure(lines[0], roots.join(", ")) : undefined;
    if (fail) throw fail;
    // The status line comes after the results; ripgrep's own errors (stderr) may come before or after it.
    if (lines.some((line) => line.startsWith("__MC_ERROR__"))) {
      const message = lines.filter((line) => !line.startsWith("__MC_ERROR__")).join(" ");
      throw new ManagedCopilotError("invalid_request", `ripgrep failed: ${clipLine(message || "check the pattern and options", 500)}`);
    }
    if (lines.includes("__MC_NOMATCH__")) return "No matches found.";
    const shown = lines.slice(0, limit);
    return [...shown, ...(lines.length > limit ? [`… more results; showing the first ${limit}.`] : [])].join("\n");
  }

  /** Runs a read-only helper command (view, glob, grep) as the workload identity, attributed to its tool. */
  async #helper(name: string, script: string, context: PlatformToolCallContext): Promise<ExecResult> {
    const hands = await this.#manager.hands(context);
    const result = await this.#sandboxes().exec(hands.record.id, script, {
      actionId: context.idempotencyKey,
      timeoutMs: HELPER_TIMEOUT_MS,
      waitMs: HELPER_WAIT_MS,
      stdin: "closed",
      ...(context.signal ? { signal: context.signal } : {}),
      sandboxId: hands.sandboxId,
      caller: caller(name, context),
    });
    if (result.state === "running") {
      await this.#sandboxes().stopExec(hands.record.id, result.id, { sandboxId: hands.sandboxId, reason: `${name} took too long.` }).catch(() => undefined);
      throw new ManagedCopilotError("timeout", `${name} took longer than ${HELPER_WAIT_MS / 1000} seconds; narrow it down.`);
    }
    if (result.state !== "completed") throw new ManagedCopilotError(result.state === "uncertain" ? "needs_reconciliation" : "internal", `${name} could not run in the sandbox (${describeState(result)}).`);
    return result;
  }

  async #readText(hands: HandsSandbox, relative: string): Promise<{ readonly bytes: Buffer; readonly text: string }> {
    const download = await this.#sandboxes().readFile(hands.record.id, relative, { sandboxId: hands.sandboxId });
    try {
      if (download.entry.size > EDIT_MAX_BYTES) throw new ManagedCopilotError("invalid_request", `${WORKSPACE}/${relative} is larger than ${EDIT_MAX_BYTES / (1024 * 1024)} MiB; change it with bash instead.`);
      const chunks: Buffer[] = [];
      for await (const chunk of download.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      const bytes = Buffer.concat(chunks);
      if (bytes.includes(0)) throw new ManagedCopilotError("invalid_request", `${WORKSPACE}/${relative} is a binary file; change it with bash instead.`);
      return { bytes, text: bytes.toString("utf8") };
    } finally {
      download.body.destroy();
    }
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Helpers

/** Resolves a path for view, glob, and grep: it must exist and resolve (following links) inside /workspace. */
const ROOT_CHECK = [
  "mc_root() {",
  '  local r; r=$(realpath -e -- "$1" 2>/dev/null) || { echo "__MC_NOTFOUND__"; return 1; }',
  '  case "$r" in /workspace|/workspace/*) printf "%s" "$r" ;; *) echo "__MC_OUTSIDE__"; return 1 ;; esac',
  "}",
].join("\n");

function rootFailure(line: string, path: string): ManagedCopilotError | undefined {
  if (line.startsWith("__MC_NOTFOUND__")) return new ManagedCopilotError("not_found", `Path does not exist: ${path}`);
  if (line.startsWith("__MC_OUTSIDE__")) return new ManagedCopilotError("forbidden", `${path} leads outside /workspace (through a symbolic link); only /workspace is yours.`);
  return undefined;
}

function caller(name: string, context: PlatformToolCallContext) {
  return { kind: "platform" as const, name, ...(context.agentId ? { agentId: context.agentId } : {}) };
}

/** On core's own path a call has 10 minutes; waits stay under that there. */
function capWait(ms: number, context: PlatformToolCallContext): number {
  return context.actionId === undefined ? Math.min(ms, CORE_PATH_WAIT_MS) : ms;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ManagedCopilotError("invalid_request", `${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** An absolute path under /workspace (a relative one is taken as relative to /workspace), normalized. */
export function absolutePath(value: string): string {
  const raw = value.replace(/\\/g, "/");
  const absolute = raw.startsWith("/") ? raw : `${WORKSPACE}/${raw}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const path = `/${segments.join("/")}`;
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) throw new ManagedCopilotError("forbidden", `${value} is outside /workspace; your sandbox's files are under /workspace.`);
  return path;
}

function workspaceRelative(path: string): string {
  if (path === WORKSPACE) throw new ManagedCopilotError("invalid_request", "A file path is required, not /workspace itself.");
  return path.slice(WORKSPACE.length + 1);
}

function rootsOf(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const roots = list.map((item) => item.trim()).filter(Boolean);
  if (roots.length > 20) throw new ManagedCopilotError("invalid_request", "paths can name at most 20 directories");
  return roots.length === 0 ? [WORKSPACE] : roots.map(absolutePath);
}

function viewRange(value: unknown): readonly [number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isInteger(item))) {
    throw new ManagedCopilotError("invalid_request", "view_range must be two integers: [start, end], with end -1 for the end of the file");
  }
  const [start, end] = value as [number, number];
  if (start < 1 || (end !== -1 && end < start)) throw new ManagedCopilotError("invalid_request", "view_range must start at line 1 or later and end at or after its start (or -1)");
  return [start, end];
}

/** A shell word for `value` (single-quoted). */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function translateKeys(input: string): string {
  const keys: Record<string, string> = { enter: "\n", tab: "\t", backspace: "\x7f", escape: "\x1b", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", space: " " };
  return input.replace(/\{([a-z]+)\}/gi, (match, key: string) => keys[key.toLowerCase()] ?? match);
}

function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The command's output for the model: all of it, or its start and end around a note. */
function clipOutput(result: ExecResult): string {
  let text = result.output;
  const notes: string[] = [];
  if (result.skippedBytes) notes.push(`[${result.skippedBytes} earlier bytes of output are no longer kept]`);
  if (text.length > OUTPUT_HEAD + OUTPUT_TAIL) {
    text = `${text.slice(0, OUTPUT_HEAD)}\n[… ${text.length - OUTPUT_HEAD - OUTPUT_TAIL} characters of output omitted …]\n${text.slice(-OUTPUT_TAIL)}`;
  }
  const body = `${notes.length > 0 ? `${notes.join(" ")}\n` : ""}${text}`;
  return body && !body.endsWith("\n") ? `${body}\n` : body;
}

function describeState(info: ExecInfo): string {
  switch (info.state) {
    case "running":
      return "running";
    case "completed":
      return info.signal ? `killed by ${info.signal}` : `exited with exit code ${info.exitCode ?? "?"}`;
    case "timed_out":
      return "timed out";
    case "stopped":
      return `stopped${info.reason ? `: ${info.reason}` : ""}`;
    case "failed":
      return `could not start${info.reason ? `: ${info.reason}` : ""}`;
    case "uncertain":
      return "outcome unknown: the platform lost track of it, so it may or may not have run";
  }
}

function statusLine(result: ExecResult, seconds: number, phrase: "after" | "initial" = "initial"): string {
  if (result.state === "running") {
    const waited = phrase === "after" ? `after waiting ${Math.round(seconds)} more seconds` : `after ${Math.round(seconds)} seconds`;
    return `<command with shellId: ${result.id} is still running ${waited}. It keeps running: use read_bash to wait for more output, write_bash to send input, or stop_bash to stop it.>`;
  }
  return `<${describeState(result)}; shellId: ${result.id}>`;
}
