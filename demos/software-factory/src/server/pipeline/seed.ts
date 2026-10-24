import { createHash } from "node:crypto";
import type { Plan, PlanTask, ReviewRecord, WorkOrder } from "../../shared/types.js";
import { formatWorkOrderNumber } from "../../shared/types.js";

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

/** The factory owns package.json: builders never fight over it, and the release gets a consistent one. */
export function packageJson(plan: Plan, skillsRoot = DEFAULT_SKILLS_ROOT): string {
  const check = `node ${skillsRoot}/factory-check/check.mjs`;
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

export function workOrderMarkdown(workOrder: Pick<WorkOrder, "number" | "title" | "brief">): string {
  return `# ${formatWorkOrderNumber(workOrder.number)}: ${workOrder.title}\n\n${workOrder.brief.trim()}\n`;
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

/** Files for a builder's fresh sandbox: the brief, the plan, its task, package.json, and its dependencies' files. */
export function builderSeed(
  workOrder: Pick<WorkOrder, "number" | "title" | "brief">,
  plan: Plan,
  task: PlanTask,
  dependencyFiles: ReadonlyMap<string, string>,
  skillsRoot = DEFAULT_SKILLS_ROOT,
): SeedFile[] {
  const files: SeedFile[] = [
    { path: "package.json", content: packageJson(plan, skillsRoot) },
    ...[...dependencyFiles].map(([path, content]) => ({ path, content })),
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
        ? `approved in round ${last.round}`
        : "not reviewed";
    const open = acceptedWithFindings ? (last?.findings ?? []) : (last?.findings ?? []).filter((finding) => finding.severity === "minor");
    const lines = [`## ${task.id}: ${status}`, "", last?.summary ?? ""];
    if (open.length > 0) {
      lines.push("", "Open findings:", ...open.map((finding) => `- [${finding.severity}] ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: ` : ""}${finding.message}`));
    }
    return lines.join("\n");
  });
  return `# Review outcomes\n\n${sections.join("\n\n")}\n`;
}

export interface ReleaseSeed {
  readonly files: readonly SeedFile[];
  /** Paths that two or more tasks published with different content. */
  readonly conflicts: readonly string[];
}

/** Files for the release sandbox: every task's published files merged, with conflicts set aside for the agent. */
export function releaseSeed(
  workOrder: Pick<WorkOrder, "number" | "title" | "brief">,
  plan: Plan,
  outcomes: readonly TaskOutcome[],
  skillsRoot = DEFAULT_SKILLS_ROOT,
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
  const files: SeedFile[] = [
    { path: "package.json", content: packageJson(plan, skillsRoot) },
    ...[...merged].map(([path, { content }]) => ({ path, content })),
  ];
  for (const [path, versions] of conflictVersions) {
    for (const [taskId, content] of versions) files.push({ path: `.factory/conflicts/${taskId}/${path}`, content });
  }
  const release = {
    projectName: plan.projectName,
    workOrder: { number: formatWorkOrderNumber(workOrder.number), title: workOrder.title },
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
    { path: ".factory/WORK_ORDER.md", content: workOrderMarkdown(workOrder) },
    { path: ".factory/PLAN.md", content: planMarkdown(plan) },
    { path: ".factory/REVIEWS.md", content: reviewsMarkdown(outcomes) },
    { path: ".factory/release.json", content: `${JSON.stringify(release, null, 2)}\n` },
  );
  return { files: [...files, seedManifest(files)], conflicts: [...conflictVersions.keys()] };
}
