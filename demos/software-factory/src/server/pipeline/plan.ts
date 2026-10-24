import { z } from "zod";
import type { Plan, PlanTask, ReviewFinding, ReviewVerdict } from "../../shared/types.js";

export const MAX_TASKS = 4;

const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const TEST_FILE = /\.(test|spec)\.(js|mjs|cjs)$/;
const RESERVED_PREFIXES = [".factory/", "outputs/", "node_modules/", ".git/"];

export const PlanTaskInputSchema = z.object({
  id: z.string().describe("Unique kebab-case id, e.g. `csv2json`"),
  title: z.string().describe("Short human title"),
  description: z.string().describe("What to build, in a few sentences"),
  files: z.array(z.string()).describe("Workspace-relative files this task owns, including its test files (test/<name>.test.js)"),
  interface: z.string().optional().describe("Exports, CLI usage, output formats, and exit codes other tasks or the release rely on"),
  acceptance: z.array(z.string()).describe("3-6 concrete, testable acceptance criteria"),
  dependsOn: z.array(z.string()).optional().describe("Ids of tasks whose files this task needs at build time; usually empty"),
});

export const PlanInputSchema = z.object({
  summary: z.string().describe("How the work is split and any assumptions"),
  projectName: z.string().describe("npm package name, lowercase, e.g. `csvjson`"),
  packageDescription: z.string().describe("One-line package description"),
  bin: z.record(z.string(), z.string()).optional().describe("Command name → bin/<name>.js for command-line entry points"),
  tasks: z.array(PlanTaskInputSchema).describe(`1 to ${MAX_TASKS} tasks that own disjoint files`),
  integration: z.string().describe("What the release agent must verify end to end and cover in the README"),
});
export type PlanInput = z.infer<typeof PlanInputSchema>;

export const ReviewInputSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]).describe("approve, or request_changes for blocker/major findings"),
  summary: z.string().describe("One paragraph: what works and what doesn't"),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        message: z.string().describe("What is wrong and what to change"),
      }),
    )
    .describe("At most 6 findings, most severe first; empty when there is nothing to report"),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

/** Normalizes a model-supplied path to a workspace-relative POSIX path, or returns undefined when unsafe. */
export function normalizeWorkspacePath(path: string): string | undefined {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/workspace\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  return normalized;
}

function findCycle(tasks: readonly PlanTask[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Validates and normalizes a submitted plan. Problems are phrased for the planner model to fix. */
export function validatePlan(input: unknown): Validation<Plan> {
  const parsed = PlanInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`) };
  }
  const raw = parsed.data;
  const problems: string[] = [];
  const projectName = raw.projectName.trim().toLowerCase().replace(/\s+/g, "-");
  if (!PROJECT_NAME.test(projectName)) problems.push(`projectName "${raw.projectName}" is not a valid npm package name.`);
  if (raw.tasks.length === 0 || raw.tasks.length > MAX_TASKS) problems.push(`Plan 1 to ${MAX_TASKS} tasks (got ${raw.tasks.length}).`);

  const owners = new Map<string, string>();
  const ids = new Set<string>();
  const tasks: PlanTask[] = raw.tasks.map((task, index) => {
    const id = task.id.trim();
    const label = `tasks[${index}] (${id || "no id"})`;
    if (!TASK_ID.test(id)) problems.push(`${label}: id must be kebab-case (letters, digits, hyphens; up to 40 characters).`);
    if (ids.has(id)) problems.push(`${label}: duplicate task id "${id}".`);
    ids.add(id);
    if (!task.title.trim()) problems.push(`${label}: title is empty.`);
    if (!task.description.trim()) problems.push(`${label}: description is empty.`);
    const files: string[] = [];
    for (const file of task.files) {
      const path = normalizeWorkspacePath(file);
      if (!path) {
        problems.push(`${label}: "${file}" is not a safe workspace-relative path.`);
        continue;
      }
      if (path === "package.json") {
        problems.push(`${label}: package.json is generated by the factory; remove it from files.`);
        continue;
      }
      if (RESERVED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        problems.push(`${label}: "${path}" is inside a reserved folder.`);
        continue;
      }
      const owner = owners.get(path);
      if (owner && owner !== id) problems.push(`${label}: "${path}" is already owned by task "${owner}"; tasks must own disjoint files.`);
      owners.set(path, id);
      if (!files.includes(path)) files.push(path);
    }
    if (files.length === 0) problems.push(`${label}: list the files this task owns.`);
    else if (!files.some((path) => TEST_FILE.test(path))) problems.push(`${label}: own at least one test file named like test/${id}.test.js.`);
    const acceptance = task.acceptance.map((item) => item.trim()).filter(Boolean);
    if (acceptance.length === 0) problems.push(`${label}: add testable acceptance criteria.`);
    return {
      id,
      title: task.title.trim(),
      description: task.description.trim(),
      files,
      ...(task.interface?.trim() ? { interface: task.interface.trim() } : {}),
      acceptance,
      dependsOn: [...new Set((task.dependsOn ?? []).map((dep) => dep.trim()).filter(Boolean))],
    };
  });

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) problems.push(`Task "${task.id}" cannot depend on itself.`);
      else if (!ids.has(dep)) problems.push(`Task "${task.id}" depends on unknown task "${dep}".`);
    }
  }
  const cycle = problems.length === 0 ? findCycle(tasks) : undefined;
  if (cycle) problems.push(`Dependency cycle: ${cycle.join(" → ")}. Remove a dependsOn edge.`);

  const bin: Record<string, string> = {};
  for (const [command, target] of Object.entries(raw.bin ?? {})) {
    const path = normalizeWorkspacePath(target);
    if (!COMMAND_NAME.test(command)) problems.push(`bin: "${command}" is not a valid command name.`);
    else if (!path) problems.push(`bin.${command}: "${target}" is not a safe workspace-relative path.`);
    else if (!owners.has(path)) problems.push(`bin.${command}: "${path}" is not owned by any task; add it to the task that implements the command.`);
    else bin[command] = path;
  }

  if (!raw.summary.trim()) problems.push("summary is empty.");
  if (!raw.integration.trim()) problems.push("integration is empty: say what the release must verify end to end.");
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      summary: raw.summary.trim(),
      projectName,
      packageDescription: raw.packageDescription.trim(),
      bin,
      tasks,
      integration: raw.integration.trim(),
    },
  };
}

export interface ValidReview {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

/** Validates a submitted review: request_changes needs a blocker or major finding; approve allows only minor ones. */
export function validateReview(input: unknown): Validation<ValidReview> {
  const parsed = ReviewInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "review"}: ${issue.message}`) };
  }
  const { verdict, summary } = parsed.data;
  const findings: ReviewFinding[] = parsed.data.findings.slice(0, 6).map((finding) => ({
    severity: finding.severity,
    ...(finding.file ? { file: normalizeWorkspacePath(finding.file) ?? finding.file } : {}),
    ...(finding.line ? { line: finding.line } : {}),
    message: finding.message.trim(),
  }));
  const blocking = findings.filter((finding) => finding.severity !== "minor");
  const problems: string[] = [];
  if (!summary.trim()) problems.push("summary is empty.");
  if (verdict === "request_changes" && blocking.length === 0) {
    problems.push("request_changes needs at least one blocker or major finding; approve when only minor issues remain.");
  }
  if (verdict === "approve" && blocking.length > 0) {
    problems.push("You approved but listed blocker or major findings: request_changes, or downgrade them to minor.");
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { verdict, summary: summary.trim(), findings } };
}

/** Tasks in dependency order (stable for independent tasks). */
export function topologicalOrder(tasks: readonly PlanTask[]): PlanTask[] {
  const done = new Set<string>();
  const ordered: PlanTask[] = [];
  const remaining = [...tasks];
  while (remaining.length > 0) {
    const index = remaining.findIndex((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (index < 0) return [...ordered, ...remaining];
    const [task] = remaining.splice(index, 1);
    ordered.push(task!);
    done.add(task!.id);
  }
  return ordered;
}
