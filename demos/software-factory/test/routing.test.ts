import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { StationError } from "../src/server/pipeline/errors.js";
import { Factory } from "../src/server/pipeline/factory.js";
import { INPUT_LIMITS, parseRoutedInputs, projectChanges, type ReleasedFile } from "../src/server/pipeline/inputs.js";
import { buildPrompt, planPrompt, releasePrompt } from "../src/server/pipeline/prompts.js";
import { builderSeed, packageJson, projectPackageName, releaseSeed } from "../src/server/pipeline/seed.js";
import { FactoryStore } from "../src/server/store.js";
import type { CreateWorkOrderRequest, Plan, WorkOrder } from "../src/shared/types.js";
import { FakePlatform, manifest, testReport, type Script } from "./fakes.js";

const PROMOTIONS = `export const PROMOTIONS = { TRAIL15: 15 };\n\nexport function applyPromoCode(code, subtotal) {\n  const percent = PROMOTIONS[code];\n  if (!percent) throw new Error("Invalid code");\n  return subtotal - Math.round((subtotal * percent) / 100);\n}\n`;
const PROJECT_PACKAGE = `${JSON.stringify({ name: "contoso-storefront", version: "2.3.0", type: "module", scripts: { test: "node --test" }, dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`;
const FIXED = PROMOTIONS.replace("PROMOTIONS[code]", "PROMOTIONS[code.trim().toUpperCase()]");
const BUG_REPORT = "# Promo codes rejected\n\n- Aisha: TRAIL15 pasted from the newsletter says invalid.\n";
// A template the factory has no extension rule for, and a CI file in a folder the release harness never bundles.
const BANNER = "<p class=\"promo\">Use {{code}} at checkout</p>\n";
const FIXED_BANNER = "<p class=\"promo\">Use {{upper code}} at checkout</p>\n";
const CI = "on: push\n";

const ROUTED: CreateWorkOrderRequest = {
  title: "Fix: promo codes rejected at checkout",
  brief: "Two customers report that TRAIL15 is rejected when pasted with a space or typed in lowercase. Fix the storefront and add regression tests.",
  mode: "classic",
  origin: { app: "help-desk", name: "Help Desk", label: "Promo codes · 2 tickets", url: "http://localhost:7440/#/", key: "run1:promo-codes" },
  context: [{ path: "BUG_REPORT.md", content: BUG_REPORT, description: "The customers' reports" }],
  project: {
    name: "contoso-storefront",
    files: [
      { path: "package.json", content: PROJECT_PACKAGE },
      { path: "README.md", content: "# Contoso storefront\n" },
      { path: "src/promotions.js", content: PROMOTIONS },
      { path: "src/views/banner.hbs", content: BANNER },
      { path: "test/promotions.test.js", content: "// existing tests\n" },
      { path: ".github/workflows/ci.yml", content: CI },
    ],
  },
};

const PLAN = {
  summary: "One focused fix.",
  projectName: "promo-fix",
  packageDescription: "Normalize promo codes",
  bin: {},
  tasks: [
    {
      id: "normalize-codes",
      title: "Normalize promo codes",
      description: "Trim and uppercase codes before looking them up.",
      files: ["src/promotions.js", "src/views/banner.hbs", "test/normalize-codes.test.js"],
      acceptance: ["Accepts trail15", "Accepts 'TRAIL15 '"],
      dependsOn: [],
    },
  ],
  integration: "Run the whole suite.",
};

let hub: EventHub | undefined;

afterEach(() => hub?.close());

function setup(scripts: ConstructorParameters<typeof FakePlatform>[0]) {
  const store = new FactoryStore(":memory:");
  hub = new EventHub(60_000);
  const platform = new FakePlatform(scripts);
  const factory = new Factory({
    store,
    hub,
    platform,
    readiness: () => ({ ready: true }),
    account: () => ({ login: "octocat" }),
    config: { maxSandboxes: 4, turnTimeoutMs: { planner: 5_000, builder: 5_000, reviewer: 5_000, release: 5_000, coordinator: 5_000, developer: 5_000 }, publicationTimeoutMs: 1_000 },
    pollMs: 10,
  });
  return { platform, factory, store };
}

async function settle(factory: Factory, id: string): Promise<WorkOrder> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const wo = factory.get(id)!;
    if (!factory.isActive(id) && ["completed", "failed", "cancelled"].includes(wo.status)) return wo;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Work order ${id} did not settle`);
}

describe("routed work orders", () => {
  it("brings its origin, context, and project through every station, and reports what the release changed", async () => {
    const prompts: Record<string, string> = {};
    const planner: Script = async (session, prompt) => {
      prompts.plan = prompt;
      await session.callTool("submit_plan", PLAN);
    };
    const builder: Script = async (session, prompt, platform) => {
      prompts.build = prompt;
      const workspace = platform.workspaces.get(session.sessionId)!;
      // The project is the workspace's starting point, with the factory's check scripts merged into its package.json.
      expect(workspace.get("src/promotions.js")).toBe(PROMOTIONS);
      expect(workspace.get("README.md")).toBe("# Contoso storefront\n");
      const pkg = JSON.parse(workspace.get("package.json")!) as { name: string; version: string; scripts: Record<string, string>; dependencies: Record<string, string> };
      expect(pkg).toMatchObject({ name: "contoso-storefront", version: "2.3.0", scripts: { test: "node --test" }, dependencies: { leftpad: "1.0.0" } });
      expect(pkg.scripts.check).toMatch(/factory-check\/check\.mjs$/);
      expect(workspace.get(".factory/context/BUG_REPORT.md")).toBe(BUG_REPORT);
      expect(JSON.parse(workspace.get(".factory/seed.json")!).files).toHaveProperty("src/promotions.js");
      expect(workspace.get(".factory/WORK_ORDER.md")).toContain("Routed to the factory by Help Desk (Promo codes · 2 tickets).");
      platform.publish(session.sessionId, {
        "files/src/promotions.js": FIXED,
        "files/src/views/banner.hbs": FIXED_BANNER,
        "files/test/normalize-codes.test.js": "// regression tests\n",
        "test-report.json": testReport(4),
        "manifest.json": manifest(["src/promotions.js", "src/views/banner.hbs", "test/normalize-codes.test.js"]),
      });
      session.say("Normalized the codes.");
    };
    const reviewer: Script = async (session, prompt) => {
      prompts.review = prompt;
      await session.callTool("submit_review", { verdict: "approve", summary: "Small and correct.", findings: [] });
    };
    const release: Script = async (session, prompt, platform) => {
      prompts.release = prompt;
      const workspace = platform.workspaces.get(session.sessionId)!;
      expect(workspace.get("src/promotions.js")).toBe(FIXED);
      // The builder's fix to a file with no extension rule survived into the release.
      expect(workspace.get("src/views/banner.hbs")).toBe(FIXED_BANNER);
      expect(workspace.get("test/promotions.test.js")).toBe("// existing tests\n");
      // Like factory-check, the release bundles no dot-directories.
      const projectFiles = [...workspace.keys()].filter((path) => !path.split("/").slice(0, -1).some((folder) => folder.startsWith(".")));
      platform.publish(session.sessionId, {
        ...Object.fromEntries(projectFiles.map((path) => [`bundle/${path}`, workspace.get(path)!])),
        "bundle/README.md": "# Contoso storefront\n\n## Promo codes\n\nCodes are trimmed and case-insensitive.\n",
        "project.patch": "diff --git a/src/promotions.js b/src/promotions.js\n",
        "test-report.json": testReport(6, 0, "release"),
        "manifest.json": manifest(projectFiles, "release"),
        "RELEASE.md": "# contoso-storefront\n\nPromo codes are normalized.",
      });
      session.say("Released.");
    };
    const { factory, store } = setup({ planner, builder, reviewer, release });
    const created = factory.create(ROUTED);
    expect(created.origin).toEqual(ROUTED.origin);
    expect(created.inputs).toEqual({
      context: [{ path: "BUG_REPORT.md", size: Buffer.byteLength(BUG_REPORT), description: "The customers' reports" }],
      project: { name: "contoso-storefront", files: 6, bytes: expect.any(Number) },
    });
    expect(factory.list().find((summary) => summary.id === created.id)?.origin).toEqual(ROUTED.origin);

    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    // The plan keeps the project's own package name.
    expect(wo.plan?.projectName).toBe("contoso-storefront");

    expect(prompts.plan).toContain("# Routed from Help Desk");
    expect(prompts.plan).toContain(BUG_REPORT.trim());
    expect(prompts.plan).toContain("# The existing project: contoso-storefront");
    expect(prompts.plan).toContain("PROMOTIONS[code]");
    expect(prompts.plan).toContain("keeps the project's own name, whatever projectName you submit");
    expect(prompts.build).toContain("changes the existing contoso-storefront project");
    expect(prompts.build).toContain("Reference material from Help Desk is in .factory/context/: `BUG_REPORT.md`");
    expect(prompts.review).toContain("## The existing project");
    expect(prompts.review).toContain("### src/promotions.js (before)");
    expect(prompts.review).toContain(FIXED_BANNER.trim());
    expect(prompts.release).toContain("Keep its README.md");

    // The routed files are the intake's artifacts, listed first.
    const index = factory.artifactIndex(wo.id);
    expect(index.files[0]?.stationId).toBe("intake");
    expect(index.files.filter((file) => file.stationId === "intake").map((file) => file.path).sort()).toEqual(
      [
        "context/BUG_REPORT.md",
        "project/.github/workflows/ci.yml",
        "project/package.json",
        "project/README.md",
        "project/src/promotions.js",
        "project/src/views/banner.hbs",
        "project/test/promotions.test.js",
      ].sort(),
    );
    expect(factory.artifact(wo.id, "intake", "context/BUG_REPORT.md")?.content).toBe(BUG_REPORT);

    // The CI file in .github/ isn't part of the release, so it isn't reported as removed.
    const changes = [
      { path: "package.json", status: "modified" },
      { path: "README.md", status: "modified" },
      { path: "src/promotions.js", status: "modified" },
      { path: "src/views/banner.hbs", status: "modified" },
      { path: "test/normalize-codes.test.js", status: "added" },
    ];
    expect(wo.release?.changes).toEqual(changes);
    const released = factory.release(wo.id)!;
    expect(released).toMatchObject({ workOrderId: wo.id, number: wo.number, projectName: "contoso-storefront", changes, tests: { passed: 6 } });
    expect(released.files.find((file) => file.path === "src/promotions.js")?.content).toBe(FIXED);
    expect(store.getWorkOrder(wo.id)?.origin?.key).toBe("run1:promo-codes");
  });

  it("refuses routed inputs it can't take, with messages for the routing app", () => {
    const { factory } = setup({});
    const attempt = (patch: Partial<CreateWorkOrderRequest>) => () => factory.create({ ...ROUTED, ...patch });
    expect(attempt({ origin: { app: "Help Desk", name: "Help Desk" } })).toThrow(/origin\.app must be lowercase/);
    expect(attempt({ origin: { app: "help-desk", name: " " } })).toThrow(/origin\.name is required/);
    expect(attempt({ origin: { app: "help-desk", name: "Help Desk", url: "javascript:alert(1)" } })).toThrow(/http or https/);
    expect(attempt({ context: [{ path: "../secrets.txt", content: "x" }] })).toThrow(/isn't a safe relative path/);
    expect(attempt({ context: [{ path: ".factory/plan.md", content: "x" }] })).toThrow(/reserves/);
    expect(attempt({ context: [{ path: "a.md", content: "x" }, { path: "./a.md", content: "y" }] })).toThrow(/twice/);
    expect(attempt({ context: [{ path: "a.bin", content: "x\u0000y" }] })).toThrow(/binary/);
    expect(attempt({ context: Array.from({ length: INPUT_LIMITS.contextFiles + 1 }, (_, index) => ({ path: `f${index}.md`, content: "x" })) })).toThrow(/up to 12/);
    expect(attempt({ project: { name: "app", files: [] } })).toThrow(/project\.files is empty/);
    try {
      attempt({ context: [{ path: "huge.csv", content: "x".repeat(INPUT_LIMITS.contextFileBytes + 1) }] })();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StationError);
      expect((error as StationError).code).toBe("payload_too_large");
    }
    // Nothing was created by the refused requests.
    expect(factory.list()).toHaveLength(0);
  });

  it("keeps work orders without routed inputs exactly as before", () => {
    const plan: Plan = { ...PLAN, projectName: "tiny", bin: {} };
    expect(parseRoutedInputs({ title: "t", brief: "b" })).toEqual({ context: [] });
    expect(JSON.parse(packageJson(plan, "/skills"))).toMatchObject({ name: "tiny", version: "0.1.0", scripts: { test: 'node --test "test/**/*.test.*js"' } });
    const seed = builderSeed({ number: 1, title: "Tiny", brief: "Build it." }, plan, plan.tasks[0]!, new Map(), "/skills");
    expect(seed.map((file) => file.path)).toEqual(["package.json", ".factory/WORK_ORDER.md", ".factory/PLAN.md", ".factory/task.json", ".factory/seed.json"]);
    expect(seed.find((file) => file.path === ".factory/WORK_ORDER.md")?.content).toBe("# WO-0001: Tiny\n\nBuild it.\n");
    expect(planPrompt({ number: 1, title: "Tiny", brief: "Build it." })).not.toContain("Routed from");
    expect(buildPrompt({ number: 1 }, plan.tasks[0]!, [])).not.toContain(".factory/context");
    expect(releasePrompt({ number: 1, title: "Tiny" }, plan, [])).not.toContain("existing");
  });

  it("starts the release from the project, with each task's changes over it", () => {
    const plan: Plan = { ...PLAN, projectName: "contoso-storefront" };
    const inputs = {
      context: new Map([["BUG_REPORT.md", BUG_REPORT]]),
      project: { name: "contoso-storefront", files: new Map([["package.json", PROJECT_PACKAGE], ["src/promotions.js", PROMOTIONS], ["src/cart.js", "// cart\n"]]) },
    };
    const outcome = { task: plan.tasks[0]!, reviews: [], acceptedWithFindings: false, files: new Map([["src/promotions.js", FIXED], ["test/normalize-codes.test.js", "// t\n"]]) };
    const { files, conflicts } = releaseSeed({ number: 3, title: "Fix", brief: "Fix it." }, plan, [outcome], "/skills", inputs);
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    expect(conflicts).toEqual([]);
    expect(byPath.get("src/cart.js")).toBe("// cart\n");
    expect(byPath.get("src/promotions.js")).toBe(FIXED);
    expect(byPath.get(".factory/context/BUG_REPORT.md")).toBe(BUG_REPORT);
    expect(JSON.parse(byPath.get("package.json")!)).toMatchObject({ name: "contoso-storefront", scripts: { test: "node --test", "check:release": "node /skills/factory-check/check.mjs --release" } });
    expect(JSON.parse(byPath.get(".factory/release.json")!).project).toEqual({ name: "contoso-storefront", files: ["package.json", "src/promotions.js", "src/cart.js"] });
  });

  it("tells added, changed, and removed files apart", () => {
    const project = new Map([["a.js", "a"], ["b.js", "b"], ["c.js", "c"], ["d.vue", "d"], ["e.vue", "e"], [".github/ci.yml", "ci"], ["node_modules/x/index.js", "x"]]);
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const released = new Map<string, ReleasedFile>([
      ["a.js", { content: "a" }],
      ["b.js", { content: "b2" }],
      ["new.js", { content: "n" }],
      // Kept without content: compared by the manifest's hash.
      ["d.vue", { sha256: hash("d") }],
      ["e.vue", { sha256: hash("e2") }],
    ]);
    expect(projectChanges(project, released)).toEqual([
      { path: "b.js", status: "modified" },
      { path: "c.js", status: "deleted" },
      { path: "e.vue", status: "modified" },
      { path: "new.js", status: "added" },
    ]);
  });

  it("doesn't ask the planner for a scoped package name it would reject", () => {
    const inputs = { context: new Map<string, string>(), project: { name: "checkout", files: new Map([["package.json", '{ "name": "@acme/checkout" }\n'], ["src/a.js", "a"]]) } };
    expect(projectPackageName(inputs)).toBe("@acme/checkout");
    const prompt = planPrompt({ number: 2, title: "Fix", brief: "Fix the checkout." }, { inputs });
    expect(prompt).not.toMatch(/use projectName/i);
    expect(prompt).toContain("keeps the project's own name");
  });
});
