import type { Plan, PlanTask, ReviewFinding, TestReport, WorkOrder } from "../../shared/types.js";
import { formatWorkOrderNumber } from "../../shared/types.js";
import { MAX_TASKS } from "./plan.js";
import { changeContinuePrompt } from "./repo.js";

/** Review prompts include file contents up to this budget; larger projects are truncated with a note. */
const REVIEW_CONTENT_BUDGET = 60_000;
const REVIEW_FILE_LIMIT = 20_000;

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function language(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return { js: "js", mjs: "js", cjs: "js", ts: "ts", json: "json", md: "markdown", sh: "bash", py: "python" }[ext] ?? "";
}

function formatFinding(finding: ReviewFinding, index: number): string {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: ` : "";
  return `${index + 1}. [${finding.severity}] ${location}${finding.message}`;
}

function taskSection(task: PlanTask): string {
  return [
    task.description,
    "",
    `Files you own: ${task.files.map((file) => `\`${file}\``).join(", ")}`,
    task.interface ? `\nInterface:\n\n\`\`\`text\n${task.interface}\n\`\`\`` : "",
    "",
    "Acceptance criteria:",
    bullets(task.acceptance),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function planPrompt(workOrder: Pick<WorkOrder, "number" | "title" | "brief">): string {
  return `Plan this work order for the software factory.

# ${formatWorkOrderNumber(workOrder.number)}: ${workOrder.title}

${workOrder.brief.trim()}

# Constraints

- 1 to ${MAX_TASKS} tasks. Builders work in parallel in separate sandboxes; a task with dependsOn waits for its dependencies.
- Every task owns disjoint files, including at least one test file named like test/<task-id>.test.js.
- The factory generates package.json from projectName, packageDescription, and bin.

Load the task-decomposition skill, then call submit_plan.`;
}

export function planRetryPrompt(): string {
  return "You did not submit a plan. Call submit_plan now with the complete plan; the factory cannot continue without it.";
}

export function buildPrompt(workOrder: Pick<WorkOrder, "number">, task: PlanTask, dependencyFiles: readonly string[]): string {
  const dependencies =
    dependencyFiles.length > 0
      ? `\nFiles from the tasks you depend on are already in the workspace (read-only): ${dependencyFiles.map((file) => `\`${file}\``).join(", ")}.\n`
      : "";
  return `Build task "${task.id}: ${task.title}" of work order ${formatWorkOrderNumber(workOrder.number)}.

${taskSection(task)}
${dependencies}
Your task is in .factory/task.json and the whole plan is in .factory/PLAN.md. Finish with \`npm run check\` passing, then reply with a short summary.`;
}

export function fixPrompt(round: number, maxRounds: number, findings: readonly ReviewFinding[], reviewSummary: string): string {
  const blocking = findings.filter((finding) => finding.severity !== "minor");
  const minor = findings.filter((finding) => finding.severity === "minor");
  return `The reviewer requested changes (round ${round} of ${maxRounds}).

Reviewer's summary: ${reviewSummary}

Fix every finding below:

${blocking.map(formatFinding).join("\n")}
${minor.length > 0 ? `\nOptional minor findings:\n\n${minor.map(formatFinding).join("\n")}\n` : ""}
Run \`npm run check\` until it passes, then reply with a short summary of what you changed.`;
}

export function checkFailedPrompt(problem: string, report: TestReport | undefined, release: boolean): string {
  const command = release ? "npm run check:release" : "npm run check";
  const failures = (report?.tests ?? []).filter((test) => test.status === "failed").slice(0, 8);
  const details =
    failures.length > 0
      ? `\nFailing tests:\n\n${failures.map((test) => `- ${test.name}${test.file ? ` (${test.file})` : ""}: ${(test.error ?? "failed").split("\n")[0]}`).join("\n")}\n`
      : "";
  return `The factory check did not pass: ${problem}
${details}
Fix the problems and run \`${command}\` until it passes, then reply with a short summary.`;
}

export interface ReviewMaterial {
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly report: TestReport | undefined;
  readonly builderSummary: string | undefined;
}

/** First message after a retry: why the previous attempt stopped, and what "done" means. */
export function retryPrompt(reason: string, release: boolean): string {
  const command = release ? "npm run check:release" : "npm run check";
  return `The factory is retrying this station. The previous attempt stopped: ${reason}

Commands from that attempt may have been stopped partway, so check the workspace's current state before relying on earlier results. Then continue where you left off: make sure the work is complete, run \`${command}\` until it passes, and reply with a short summary.`;
}

/** When an interrupted turn didn't finish: it failed, was stopped, or the runtime running it restarted. */
export function continuePrompt(release: boolean | "change"): string {
  if (release === "change") return changeContinuePrompt();
  const command = release ? "npm run check:release" : "npm run check";
  return `Your previous turn was interrupted before it finished, and the commands it was running may have been stopped partway. Check the workspace's current state before relying on earlier results, then continue the task, run \`${command}\` until it passes, and reply with a short summary.`;
}

function testSection(report: TestReport | undefined): string {
  if (!report) return "No test report was published.";
  const { total, passed, failed, skipped } = report.summary;
  const failures = report.tests.filter((test) => test.status === "failed");
  return [
    `\`${report.command}\`: ${total} tests, ${passed} passed, ${failed} failed, ${skipped} skipped (exit ${report.exitCode}).`,
    ...failures.slice(0, 8).map((test) => `- FAILED ${test.name}: ${(test.error ?? "").split("\n")[0]}`),
    "",
    "Tests:",
    ...report.tests.slice(0, 60).map((test) => `- ${test.status === "passed" ? "✔" : test.status === "failed" ? "✖" : "○"} ${test.name}`),
  ].join("\n");
}

function filesSection(files: ReviewMaterial["files"]): string {
  let budget = REVIEW_CONTENT_BUDGET;
  const sections: string[] = [];
  const omitted: string[] = [];
  for (const file of files) {
    if (budget <= 0) {
      omitted.push(file.path);
      continue;
    }
    const limit = Math.min(REVIEW_FILE_LIMIT, budget);
    const content = file.content.length > limit ? `${file.content.slice(0, limit)}\n… (truncated)` : file.content;
    budget -= content.length;
    sections.push(`### ${file.path}\n\n\`\`\`${language(file.path)}\n${content}\n\`\`\``);
  }
  if (omitted.length > 0) sections.push(`(Not shown, over the review budget: ${omitted.join(", ")})`);
  return sections.length > 0 ? sections.join("\n\n") : "The builder published no files.";
}

export function reviewPrompt(task: PlanTask, round: number, maxRounds: number, material: ReviewMaterial, previous?: readonly ReviewFinding[]): string {
  const intro =
    round === 1
      ? `Review task "${task.id}: ${task.title}" (round 1; up to ${maxRounds} rounds).`
      : `The builder resubmitted task "${task.id}: ${task.title}" (round ${round} of ${maxRounds}). Check whether each earlier finding is fixed and approve once blockers and majors are resolved.\n\nYour earlier findings:\n\n${(previous ?? []).map(formatFinding).join("\n")}`;
  return `${intro}

## Task

${taskSection(task)}

## Test report

${testSection(material.report)}

## Files

${filesSection(material.files)}

## Builder's summary

${material.builderSummary?.trim() || "(none)"}

Load the review-rubric skill, then call submit_review.`;
}

export function reviewRetryPrompt(): string {
  return "You did not submit a review. Call submit_review now with your verdict, summary, and findings.";
}

export function releasePrompt(workOrder: Pick<WorkOrder, "number" | "title">, plan: Plan, conflicts: readonly string[]): string {
  const conflictNote =
    conflicts.length > 0
      ? `\nTwo tasks changed the same files: ${conflicts.map((path) => `\`${path}\``).join(", ")}. Each version is in .factory/conflicts/<task>/; merge them first.\n`
      : "";
  return `Integrate and release work order ${formatWorkOrderNumber(workOrder.number)}: ${workOrder.title}.

Every task's files are in /workspace, with the factory-generated package.json.
${conflictNote}
Integration notes from the plan:

${plan.integration}

Tasks: ${plan.tasks.map((task) => `${task.id} (${task.title})`).join(", ")}. Review outcomes are in .factory/REVIEWS.md.

Follow the release-checklist skill: add test/integration.test.js, write README.md, run \`npm run check:release\` until it passes, write outputs/RELEASE.md, and reply with a short summary.`;
}
