import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { playRun, startServer, type FakeSession, until } from "./fakes.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Runs the happy-path script from its sources against `url`. */
function happyPath(url: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/scripts/happy-path.ts", "--url", url], { cwd: packageRoot, env: { ...process.env, MANAGED_COPILOT_PORT_OFFSET: "" } });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

describe("the happy-path script", () => {
  it("researches one question through the API, checks the cited report, and deletes the run", async () => {
    const server = await startServer();
    servers.push(server);
    const finished = happyPath(server.url);
    await until(() => (server.platform.sessions[0]?.sent.length ?? 0) > 0, "the lead's question", 15_000);
    const lead = server.platform.sessions[0] as FakeSession;
    expect(lead.sent[0]!.prompt).toBe("Question: What is WebAssembly, and which browsers support it?");
    expect(lead.config.systemMessage?.content).toContain("Call plan_research with two sub-questions");
    await playRun(server.platform, lead);
    const { code, output } = await finished;
    expect(output).toContain('✔ "WebAssembly today"');
    expect(output).toContain("sources: 2 cited of 2 read · blocked: none");
    expect(output).toContain("Deleted run");
    expect(code).toBe(0);
    expect(server.platform.deleted).toEqual([lead.sessionId]);
    expect(server.store.list()).toEqual([]);
  }, 30_000);

  it("fails, and still deletes the run, when the research does", async () => {
    const server = await startServer();
    servers.push(server);
    server.platform.createError = new Error("The model isn't available.");
    const { code, output } = await happyPath(server.url);
    expect(output).toContain("✖ Happy path failed: The run failed: Couldn't start the research: The model isn't available.");
    expect(output).toContain("Deleted run");
    expect(code).toBe(1);
    expect(server.store.list()).toEqual([]);
  }, 30_000);
});
