/**
 * Live smoke test for the factory's office stations (shared environments): runs the real planner and reviewer
 * custom agents against a running platform with real models, using the same prompts and tools as the factory.
 *
 *   node dist/scripts/smoke-office.js
 *
 * Connects like the factory does (`MANAGED_COPILOT_URL`, then local discovery). Exits 1 on failure.
 */
import { defineTool, type CopilotClient } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { chooseModels } from "../server/models.js";
import { StationActivityMapper } from "../server/pipeline/activity.js";
import { factoryPermissions } from "../server/pipeline/permissions.js";
import { PlanInputSchema, ReviewInputSchema, validatePlan, validateReview, type ValidReview } from "../server/pipeline/plan.js";
import { planPrompt, reviewPrompt } from "../server/pipeline/prompts.js";
import { FACTORY_ENVIRONMENTS } from "../shared/environments.js";
import { HAPPY_PATH_TEMPLATE_ID, TEMPLATES } from "../shared/templates.js";
import type { ActivityItem, Plan } from "../shared/types.js";

function printer(label: string) {
  return new StationActivityMapper("smoke", label, {
    item: (item: ActivityItem) => {
      const text = item.kind === "tool" ? `${item.tool!.status} ${item.tool!.summary}` : (item.text ?? "").split("\n")[0];
      console.log(`  [${label}] ${item.kind.padEnd(7)} ${text}`);
    },
    delta: () => undefined,
  });
}

async function station<T>(
  client: CopilotClient,
  label: string,
  agent: string,
  model: string,
  toolName: string,
  schema: typeof PlanInputSchema | typeof ReviewInputSchema,
  validate: (args: unknown) => { ok: true; value: T } | { ok: false; problems: readonly string[] },
  prompt: string,
): Promise<T> {
  let captured: T | undefined;
  const mapper = printer(label);
  const tool = defineTool(toolName, {
    description: `Submit the result to the factory (${toolName}).`,
    parameters: schema,
    skipPermission: true,
    handler: async (args: unknown) => {
      const result = validate(args);
      if (!result.ok) return `Rejected. Fix these problems and call ${toolName} again:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
      captured = result.value;
      return "Accepted.";
    },
  });
  const started = Date.now();
  const session = await client.createSession({
    agent,
    model,
    tools: [tool],
    streaming: true,
    onPermissionRequest: factoryPermissions("shared", (kind) => console.log(`  [${label}] denied ${kind}`)),
    onEvent: (event) => mapper.handle(event),
  });
  console.log(`  [${label}] session ${session.sessionId} (${agent}, ${model})`);
  await session.sendAndWait({ prompt }, 5 * 60_000);
  await session.disconnect();
  if (!captured) throw new Error(`${label}: the agent didn't call ${toolName}`);
  console.log(`  [${label}] done in ${((Date.now() - started) / 1000).toFixed(1)}s · ${mapper.usage.requests} model calls`);
  return captured;
}

async function main(): Promise<void> {
  const managed = await ManagedCopilot.connect({ clientName: "software-factory-smoke" });
  console.log(`Connected to ${managed.url} as ${managed.account.login} · capabilities: ${managed.info.capabilities.join(", ")}`);
  try {
    const planner = await managed.client(FACTORY_ENVIRONMENTS.planner);
    const models = chooseModels(await planner.listModels());
    console.log(`Models: ${JSON.stringify(models)}`);
    const template = TEMPLATES.find((candidate) => candidate.id === HAPPY_PATH_TEMPLATE_ID)!;
    const plan = await station<Plan>(planner, "plan", "planner", models.planner, "submit_plan", PlanInputSchema, validatePlan, planPrompt({ number: 1, title: template.title, brief: template.brief }));
    console.log(`Plan: ${plan.projectName} · ${plan.tasks.map((task) => `${task.id} [${task.files.join(", ")}]${task.dependsOn.length ? ` after ${task.dependsOn.join(",")}` : ""}`).join(" | ")}`);

    const reviewer = await managed.client(FACTORY_ENVIRONMENTS.reviewer);
    const task = plan.tasks[0]!;
    const buggy = `export function parseCsv(text) {\n  return text.trim().split("\\n").map((line) => line.split(","));\n}\n`;
    const review = await station<ValidReview>(
      reviewer,
      "review",
      "reviewer",
      models.reviewer,
      "submit_review",
      ReviewInputSchema,
      validateReview,
      reviewPrompt(task, 1, 2, { files: [{ path: task.files[0]!, content: buggy }], report: undefined, builderSummary: "Implemented a simple split-based parser." }),
    );
    console.log(`Review: ${review.verdict} · ${review.findings.map((finding) => `[${finding.severity}] ${finding.message}`).join(" | ")}`);
    if (review.verdict !== "request_changes") throw new Error("The reviewer approved a parser that ignores quoted fields.");
    console.log("Office stations OK");
  } finally {
    await managed.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Smoke test failed: ${(error as Error).message}`);
  process.exit(1);
});
