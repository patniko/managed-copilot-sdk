// The app's own tools on the coordinator session (stock `defineTool`). They run in this server: live while the app is
// attached, or through the platform's webhook while it isn't. Only deploy_fix asks a person first. Incidents whose fix
// goes through Software Factory also get route_fix_to_factory and apply_factory_fix.
import { defineTool, type Tool } from "@github/copilot-sdk";
import { TOOLS } from "./runbook.js";

export interface UpdateInput {
  readonly note: string;
  readonly rootCause?: string;
  readonly evidence: readonly string[];
}

export interface RouteFixInput {
  readonly summary: string;
  readonly rootCause: string;
  readonly failingPath: string;
  readonly expected: string;
  /** The service files the fix likely touches, as the model gave them. */
  readonly files: readonly string[];
}

export interface DeployInput {
  readonly summary: string;
  readonly files: readonly string[];
  readonly tests?: string;
}

export interface PostmortemInput {
  readonly summary: string;
  readonly impact: string;
  readonly rootCause: string;
  readonly fix: string;
  readonly followUps: readonly string[];
}

export type ToolOutcome = string | { readonly textResultForLlm: string; readonly resultType: "failure" };

export const failure = (text: string): ToolOutcome => ({ textResultForLlm: text, resultType: "failure" });

/** What the tools act on: one incident. */
export interface ToolHost {
  openWorkspace(): Promise<ToolOutcome>;
  update(input: UpdateInput): ToolOutcome;
  routeFix(input: RouteFixInput): Promise<ToolOutcome>;
  applyFactoryFix(): Promise<ToolOutcome>;
  deploy(input: DeployInput, toolCallId: string): Promise<ToolOutcome>;
  postmortem(input: PostmortemInput): ToolOutcome;
}

/** Arguments the model got wrong come back as a failed tool result it can read and fix. */
export class ToolInputError extends Error {}

type Args = Record<string, unknown>;

function args(value: unknown): Args {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolInputError("Pass the arguments as an object.");
  return value as Args;
}

function text(input: Args, key: string, max: number, required: true): string;
function text(input: Args, key: string, max: number, required?: false): string | undefined;
function text(input: Args, key: string, max: number, required = false): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    if (required) throw new ToolInputError(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolInputError(`${key} must be a string.`);
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function texts(input: Args, key: string, maxItems: number, maxLength: number): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ToolInputError(`${key} must be a list of strings.`);
  return value
    .map((item: string) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength - 1)}…` : item));
}

export function parseUpdate(value: unknown): UpdateInput {
  const input = args(value);
  const rootCause = text(input, "rootCause", 400);
  return { note: text(input, "note", 400, true), ...(rootCause ? { rootCause } : {}), evidence: texts(input, "evidence", 6, 240) };
}

export function parseRouteFix(value: unknown): RouteFixInput {
  const input = args(value);
  return {
    summary: text(input, "summary", 200, true),
    rootCause: text(input, "rootCause", 600, true),
    failingPath: text(input, "failingPath", 400, true),
    expected: text(input, "expected", 600, true),
    files: texts(input, "files", 20, 300),
  };
}

export function parseDeploy(value: unknown): DeployInput {
  const input = args(value);
  const files = texts(input, "files", 20, 300);
  if (files.length === 0) throw new ToolInputError("files must list the changed files, relative to the service's folder.");
  const tests = text(input, "tests", 200);
  return { summary: text(input, "summary", 200, true), files, ...(tests ? { tests } : {}) };
}

export function parsePostmortem(value: unknown): PostmortemInput {
  const input = args(value);
  return {
    summary: text(input, "summary", 600, true),
    impact: text(input, "impact", 600, true),
    rootCause: text(input, "rootCause", 600, true),
    fix: text(input, "fix", 600, true),
    followUps: texts(input, "followUps", 6, 240),
  };
}

async function guarded(run: () => ToolOutcome | Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolInputError) return failure(error.message);
    throw error;
  }
}

const listOf = (description: string) => ({ type: "array", items: { type: "string" }, description });

/** Software Factory's tools: only on incidents whose fix goes through it. */
function factoryTools(host: ToolHost): Tool<unknown>[] {
  return [
    defineTool(TOOLS.routeFix, {
      description:
        "Routes the incident's fix to Software Factory as a work order, with the service's code and tests and what you found. The factory plans the fix, builds it in its own sandboxes, reviews it, and releases it with tests; Incident Commander messages you when it's released. Call it once, after triage.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One line: what's broken, for example: Uploads over 10 MB time out." },
          rootCause: { type: "string", description: "The root cause: one or two sentences." },
          failingPath: { type: "string", description: "The failing code path, with file:line, for example: POST /uploads → saveUpload (src/uploads.js:42) → writeChunk (src/storage.js:17)." },
          expected: { type: "string", description: "What the code should do instead." },
          files: listOf("The service files the fix likely touches, relative to the service's folder, for example src/storage.js."),
        },
        required: ["summary", "rootCause", "failingPath", "expected", "files"],
      },
      skipPermission: true,
      handler: (input: unknown) => guarded(() => host.routeFix(parseRouteFix(input))),
    }),
    defineTool(TOOLS.applyFix, {
      description:
        "Copies the fix Software Factory released (its added and changed files) into /workspace/<service> in your own sandbox, and lists them. Call it when Incident Commander says the factory released the fix.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      skipPermission: true,
      handler: () => guarded(() => host.applyFactoryFix()),
    }),
  ];
}

/** The app's tools for one incident. `factory`: its fix goes through Software Factory. */
export function incidentTools(host: ToolHost, options: { readonly factory?: boolean } = {}): Tool<unknown>[] {
  return [
    defineTool(TOOLS.openWorkspace, {
      description:
        "Copies the incident's service (code, tests, production logs, and deploy history) into /workspace/<service> in your own sandbox. Your sandbox must have started: run any command first.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      skipPermission: true,
      handler: () => guarded(() => host.openWorkspace()),
    }),
    defineTool(TOOLS.update, {
      description: "Records a step of the incident on its page: a short note, and what you know about the root cause and its evidence.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "One sentence: what you did or found." },
          rootCause: { type: "string", description: "The root cause, once you know it: one sentence." },
          evidence: listOf("With the root cause: two to four short lines backing it (counts, the error, file:line, the deploy)."),
        },
        required: ["note"],
      },
      skipPermission: true,
      handler: (input: unknown) => guarded(() => host.update(parseUpdate(input))),
    }),
    ...(options.factory ? factoryTools(host) : []),
    defineTool(TOOLS.deploy, {
      description:
        "Deploys the verified fix to production from your own sandbox's copy of the service. A person reviews the change and approves it first; that can take hours.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One line: what the fix changes." },
          files: listOf("The changed and added files, relative to the service's folder, for example src/storage.js and test/storage.test.js."),
          tests: { type: "string", description: "The test result in your sandbox, for example: 10 passed, 0 failed." },
        },
        required: ["summary", "files"],
      },
      handler: (input: unknown, invocation) => guarded(() => host.deploy(parseDeploy(input), invocation.toolCallId)),
    }),
    defineTool(TOOLS.postmortem, {
      description: "Publishes the incident's blameless postmortem on its page. Call it once the fix is deployed.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What happened, in a sentence or two." },
          impact: { type: "string", description: "Who was affected, how much, and for how long." },
          rootCause: { type: "string", description: "Why it happened." },
          fix: { type: "string", description: "What was changed and deployed." },
          followUps: listOf("Follow-up actions that prevent a repeat."),
        },
        required: ["summary", "impact", "rootCause", "fix"],
      },
      skipPermission: true,
      handler: (input: unknown) => guarded(() => host.postmortem(parsePostmortem(input))),
    }),
  ];
}
