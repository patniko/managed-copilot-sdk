// Keeps the QA catalog complete: every snippet, walkthrough, demo script, and opt-in test in the repository has a check,
// every check is mapped to a flow in docs/qa.md, and the doc's generated catalog matches the code.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_ENVS } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { CHECKS, CI_UNSET, DEMOS, TIERS, type RunContext } from "../src/catalog.js";
import { catalogMarkdown, DOC_END, DOC_START, withCatalog } from "../src/docs.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Line endings depend on the checkout (core.autocrlf), not on the content.
const doc = readFileSync(join(root, "docs", "qa.md"), "utf8").replace(/\r\n/g, "\n");
const ids = new Set(CHECKS.map((check) => check.id));
const posix = (path: string) => path.split("\\").join("/");

/** Every automated check's pnpm arguments, as run against a placeholder deployment. */
const commands = CHECKS.flatMap((check) => {
  if (check.kind !== "automated") return [];
  const ctx: RunContext = { tier: check.tier, url: "https://gateway.example", appsDomain: "apps.example", isolatedEnvironment: "coder", portOffset: 0, reportFile: "report.json" };
  return [{ id: check.id, args: check.command(ctx).pnpm }];
});

/** Files under `dir` (relative to the repository root) whose names match. */
function files(dir: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) found.push(posix(relative(root, full)));
    }
  };
  if (existsSync(join(root, dir))) walk(join(root, dir));
  return found;
}

describe("the QA catalog", () => {
  it("has unique IDs, each prefixed with its tier", () => {
    expect(ids.size).toBe(CHECKS.length);
    for (const check of CHECKS) expect(check.id.startsWith(`${check.tier}.`), check.id).toBe(true);
    for (const tier of TIERS) expect(CHECKS.some((check) => check.tier === tier), tier).toBe(true);
  });

  it("runs the ci tier without any variable CI lacks", () => {
    for (const name of TOKEN_ENVS) expect(CI_UNSET).toContain(name);
  });

  it("runs the same commands as the CI workflow", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
    const steps = [...workflow.matchAll(/^\s*- run: pnpm (.+)$/gm)].map((match) => match[1]!.trim()).filter((step) => !step.startsWith("install"));
    const tier = commands.filter(({ id }) => id.startsWith("ci.")).map(({ args }) => args.join(" "));
    expect(tier).toEqual(steps);
  });

  it("has a check for every spec snippet, in both tiers that can run it", () => {
    const snippets = readdirSync(join(root, "tests", "snippets", "src")).flatMap((name) => /^(\d\d)-.+\.ts$/.exec(name)?.[1] ?? []);
    expect(snippets.length).toBeGreaterThan(0);
    for (const number of snippets) expect(ids, `snippet ${number}`).toContain(`local.snippet-${number}`);
  });

  it("has a check for every walkthrough with code", () => {
    const walkthroughs = readdirSync(join(root, "walkthroughs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, "walkthroughs", entry.name, "main.ts")))
      .map((entry) => entry.name.slice(0, 2));
    expect(walkthroughs.length).toBeGreaterThan(0);
    for (const number of walkthroughs) expect(ids, `walkthrough ${number}`).toContain(`local.walkthrough-${number}`);
  });

  it("runs every demo's live script (happy-path, e2e, smoke:*)", () => {
    for (const entry of readdirSync(join(root, "demos"), { withFileTypes: true })) {
      const manifest = join(root, "demos", entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; scripts?: Record<string, string> };
      for (const script of Object.keys(pkg.scripts ?? {}).filter((name) => name === "happy-path" || name === "e2e" || name.startsWith("smoke:"))) {
        const runs = commands.some(({ args }) => args.includes(pkg.name) && args.includes(script));
        expect(runs, `${pkg.name} ${script}`).toBe(true);
      }
    }
    for (const demo of Object.values(DEMOS)) expect(existsSync(join(root, "demos", demo.pkg.replace("@managed-copilot/demo-", ""), "package.json")), demo.pkg).toBe(true);
  });

  it("runs or points to every opt-in end-to-end, Docker, and live test", () => {
    // Runs in CI with a fake runtime, so `ci.test` covers it.
    const inCi = new Set(["services/gateway/test/sdk.e2e.test.ts"]);
    const optIn = [
      ...files("services", /\.(e2e\.test|docker\.test|live)\.ts$|\.docker\.ts$/),
      ...files("libraries", /\.live\.ts$/),
      ...files("deployments", /\.live\.(ts|mjs)$|^check\.mjs$/),
    ].filter((file) => !inCi.has(file));
    expect(optIn.length).toBeGreaterThan(0);
    const referenced = (file: string) =>
      commands.some(({ args }) => args.some((arg) => arg.includes("/") && file.endsWith(arg))) ||
      // The egress Docker tests run through the package's own script.
      (file.startsWith("services/egress/test/docker/") && commands.some(({ args }) => args.includes("@managed-copilot/egress") && args.includes("test:docker"))) ||
      CHECKS.some((check) => check.kind === "manual" && check.steps.includes(file.replace(/\/check\.mjs$/, "/README.md")));
    for (const file of optIn) expect(referenced(file), file).toBe(true);
  });
});

describe("docs/qa.md", () => {
  it("contains the generated catalog (run `pnpm qa --update-docs` after changing a check)", () => {
    expect(doc).toContain(DOC_START);
    expect(doc).toContain(DOC_END);
    expect(withCatalog(doc)).toBe(doc);
    expect(catalogMarkdown().length).toBeGreaterThan(0);
  });

  it("maps every check to a flow, and names only checks that exist", () => {
    const handWritten = doc.slice(0, doc.indexOf(DOC_START)) + doc.slice(doc.indexOf(DOC_END));
    const named = new Set([...handWritten.matchAll(/`((?:ci|e2e|local|azure)\.[a-z0-9-]+)`/g)].map((match) => match[1]!));
    for (const id of named) expect(ids, `docs/qa.md names ${id}`).toContain(id);
    for (const id of ids) expect(named, `docs/qa.md maps ${id} to a flow`).toContain(id);
  });
});
