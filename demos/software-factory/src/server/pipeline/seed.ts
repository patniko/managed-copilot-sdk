import { createHash } from "node:crypto";
import type { Plan, PlanTask, ReviewRecord, WorkOrder } from "../../shared/types.js";
import { formatWorkOrderNumber } from "../../shared/types.js";
import { CONTEXT_DIR, type LoadedInputs } from "./inputs.js";

/** Where the workshop customizations are mounted inside a sandbox (read-only). */
export const DEFAULT_SKILLS_ROOT = "/opt/managed-copilot/customizations/skills";

export interface SeedFile {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The factory owns package.json: builders never fight over it, and the release gets a consistent one. A project the
 * work order brought keeps its own package.json (name, version, dependencies, scripts) with the factory's check
 * scripts added.
 */
export function packageJson(plan: Plan, skillsRoot = DEFAULT_SKILLS_ROOT, base?: string): string {
  const check = `node ${skillsRoot}/factory-check/check.mjs`;
  const existing = parseObject(base);
  if (existing) {
    const bin = { ...objectOf(existing.bin), ...plan.bin };
    const merged = {
      ...existing,
      ...(Object.keys(bin).length > 0 ? { bin } : {}),
      scripts: { test: 'node --test "test/**/*.test.*js"', ...objectOf(existing.scripts), check, "check:release": `${check} --release` },
    };
    return `${JSON.stringify(merged, null, 2)}\n`;
  }
  const manifest = {
    name: plan.projectName,
    version: "0.1.0",
    description: plan.packageDescription,
    type: "module",
    ...(Object.keys(plan.bin).length > 0 ? { bin: plan.bin } : {}),
    scripts: {
      test: 'node --test "test/**/*.test.*js"',
      check,
      "check:release": `${check} --release`,
    },
    engines: { node: ">=22" },
    license: "MIT",
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The project's package name, when the work order brought a project whose package.json names it. */
export function projectPackageName(inputs: LoadedInputs | undefined): string | undefined {
  const name = parseObject(inputs?.project?.files.get("package.json"))?.name;
  return typeof name === "string" && /^[a-z0-9@][a-z0-9._/@-]{0,213}$/.test(name) ? name : undefined;
}

type BriefOf = Pick<WorkOrder, "number" | "title" | "brief"> & Partial<Pick<WorkOrder, "origin" | "inputs">>;

export function workOrderMarkdown(workOrder: BriefOf): string {
  const lines = [`# ${formatWorkOrderNumber(workOrder.number)}: ${workOrder.title}`, ""];
  const origin = workOrder.origin;
  if (origin) {
    lines.push(`Routed to the factory by ${origin.name}${origin.label ? ` (${origin.label})` : ""}.`, "");
  }
  lines.push(workOrder.brief.trim(), "");
  const context = workOrder.inputs?.context ?? [];
  if (context.length > 0) {
    lines.push(
      "## Reference material",
      "",
      `In \`${CONTEXT_DIR}/\`:`,
      "",
      ...context.map((file) => `- \`${file.path}\`${file.description ? `: ${file.description}` : ""}`),
      "",
    );
  }
  const project = workOrder.inputs?.project;
  if (project) {
    lines.push("## The project", "", `This work order changes the existing **${project.name}** project (${project.files} files): its files are the workspace.`, "");
  }
  return lines.join("\n");
}

/** Context files at `.factory/context/<path>`. */
function contextSeed(inputs: LoadedInputs | undefined): SeedFile[] {
  return [...(inputs?.context ?? [])].map(([path, content]) => ({ path: `${CONTEXT_DIR}/${path}`, content }));
}

/** The project's files (package.json aside: the factory writes its own merge of it). */
function projectFiles(inputs: LoadedInputs | undefined): Map<string, string> {
  const files = new Map<string, string>();
  for (const [path, content] of inputs?.project?.files ?? []) if (path !== "package.json") files.set(path, content);
  return files;
}

function taskMarkdown(task: PlanTask): string {
  const lines = [`### ${task.id}: ${task.title}`, "", task.description, "", `- Files: ${task.files.map((file) => `\`${file}\``).join(", ")}`];
  lines.push(`- Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.map((dep) => `\`${dep}\``).join(", ") : "nothing"}`);
  if (task.interface) lines.push("- Interface:", "", "  ```text", ...task.interface.split("\n").map((line) => `  ${line}`), "  ```", "");
  lines.push("- Acceptance criteria:", ...task.acceptance.map((item) => `  - ${item}`));
  return lines.join("\n");
}

export function planMarkdown(plan: Plan): string {
  const commands = Object.entries(plan.bin);
  return [
    `# Plan: ${plan.projectName}`,
    "",
    plan.summary,
    "",
    `Package \`${plan.projectName}\`: ${plan.packageDescription}`,
    commands.length > 0 ? `Commands: ${commands.map(([name, path]) => `\`${name}\` → \`${path}\``).join(", ")}` : "Commands: none",
    "",
    "## Tasks",
    "",
    plan.tasks.map(taskMarkdown).join("\n\n"),
    "",
    "## Integration",
    "",
    plan.integration,
    "",
  ].join("\n");
}

function seedManifest(files: readonly SeedFile[]): SeedFile {
  const entries = Object.fromEntries(files.filter((file) => !file.path.startsWith(".factory/")).map((file) => [file.path, sha256(file.content)]));
  return { path: ".factory/seed.json", content: `${JSON.stringify({ files: entries }, null, 2)}\n` };
}

/**
 * Files for a builder's fresh sandbox: the brief, the plan, its task, package.json, and its dependencies' files. A
 * routed work order adds its context under `.factory/context/`, and its project's files are the workspace's starting
 * point (a dependency's changes override them). Every workspace file is in `.factory/seed.json`, so the harness
 * publishes only what the builder added or changed.
 */
export function builderSeed(
  workOrder: BriefOf,
  plan: Plan,
  task: PlanTask,
  dependencyFiles: ReadonlyMap<string, string>,
  skillsRoot = DEFAULT_SKILLS_ROOT,
  inputs?: LoadedInputs,
): SeedFile[] {
  const workspace = projectFiles(inputs);
  for (const [path, content] of dependencyFiles) workspace.set(path, content);
  const files: SeedFile[] = [
    { path: "package.json", content: packageJson(plan, skillsRoot, inputs?.project?.files.get("package.json")) },
    ...[...workspace].map(([path, content]) => ({ path, content })),
    ...contextSeed(inputs),
    { path: ".factory/WORK_ORDER.md", content: workOrderMarkdown(workOrder) },
    { path: ".factory/PLAN.md", content: planMarkdown(plan) },
    {
      path: ".factory/task.json",
      content: `${JSON.stringify({ ...task, projectName: plan.projectName, workOrder: formatWorkOrderNumber(workOrder.number) }, null, 2)}\n`,
    },
  ];
  return [...files, seedManifest(files)];
}

export interface TaskOutcome {
  readonly task: PlanTask;
  readonly reviews: readonly ReviewRecord[];
  readonly acceptedWithFindings: boolean;
  /** The task's published files: path → content. */
  readonly files: ReadonlyMap<string, string>;
}

function reviewsMarkdown(outcomes: readonly TaskOutcome[]): string {
  const sections = outcomes.map(({ task, reviews, acceptedWithFindings }) => {
    const last = reviews.at(-1);
    const status = acceptedWithFindings
      ? `accepted after ${reviews.length} rounds with findings still open`
      : last
        ? `approved in round ${last.round}${reviews.length > 1 ? ` after ${reviews.length - 1} round${reviews.length > 2 ? "s" : ""} of requested changes` : ""}`
        : "not reviewed";
    const lines = [`## ${task.id}: ${status}`];
    for (const review of reviews) {
      lines.push("", `Round ${review.round}: ${review.verdict === "approve" ? "approved" : "changes requested"}. ${review.summary}`);
      const shown = review.verdict === "approve" && !acceptedWithFindings ? review.findings.filter((finding) => finding.severity === "minor") : review.findings;
      lines.push(
        ...shown.map((finding) => `- [${finding.severity}] ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: ` : ""}${finding.message}`),
      );
    }
    if (acceptedWithFindings) lines.push("", "The findings from the last round are still open: list them in the release notes.");
    return lines.join("\n");
  });
  return `# Review outcomes\n\n${sections.join("\n\n")}\n`;
}

export interface ReleaseSeed {
  readonly files: readonly SeedFile[];
  /** Paths that two or more tasks published with different content. */
  readonly conflicts: readonly string[];
}

/**
 * Files for the release sandbox: every task's published files merged (over the project's own files, when the work order
 * brought one), with conflicts between tasks set aside for the agent.
 */
export function releaseSeed(
  workOrder: BriefOf,
  plan: Plan,
  outcomes: readonly TaskOutcome[],
  skillsRoot = DEFAULT_SKILLS_ROOT,
  inputs?: LoadedInputs,
): ReleaseSeed {
  const merged = new Map<string, { content: string; taskId: string }>();
  const conflictVersions = new Map<string, Map<string, string>>();
  for (const outcome of outcomes) {
    for (const [path, content] of outcome.files) {
      if (path === "package.json") continue;
      const existing = merged.get(path);
      if (!existing) {
        merged.set(path, { content, taskId: outcome.task.id });
      } else if (existing.content !== content) {
        const versions = conflictVersions.get(path) ?? new Map([[existing.taskId, existing.content]]);
        versions.set(outcome.task.id, content);
        conflictVersions.set(path, versions);
      }
    }
  }
  const workspace = projectFiles(inputs);
  for (const [path, { content }] of merged) workspace.set(path, content);
  const files: SeedFile[] = [
    { path: "package.json", content: packageJson(plan, skillsRoot, inputs?.project?.files.get("package.json")) },
    ...[...workspace].map(([path, content]) => ({ path, content })),
  ];
  for (const [path, versions] of conflictVersions) {
    for (const [taskId, content] of versions) files.push({ path: `.factory/conflicts/${taskId}/${path}`, content });
  }
  const release = {
    projectName: plan.projectName,
    workOrder: { number: formatWorkOrderNumber(workOrder.number), title: workOrder.title },
    ...(inputs?.project ? { project: { name: inputs.project.name, files: [...inputs.project.files.keys()] } } : {}),
    bin: plan.bin,
    integration: plan.integration,
    tasks: outcomes.map(({ task, acceptedWithFindings }) => ({
      id: task.id,
      title: task.title,
      files: task.files,
      outcome: acceptedWithFindings ? "accepted_with_findings" : "approved",
    })),
    conflicts: [...conflictVersions.keys()],
  };
  files.push(
    ...contextSeed(inputs),
    { path: ".factory/WORK_ORDER.md", content: workOrderMarkdown(workOrder) },
    { path: ".factory/PLAN.md", content: planMarkdown(plan) },
    { path: ".factory/REVIEWS.md", content: reviewsMarkdown(outcomes) },
    { path: ".factory/release.json", content: `${JSON.stringify(release, null, 2)}\n` },
  );
  return { files: [...files, seedManifest(files)], conflicts: [...conflictVersions.keys()] };
}
