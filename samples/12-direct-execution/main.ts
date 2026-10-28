// Walkthrough 12: the same job, delegated to workers and done directly; then a coordinator that can do both.
// Steps and output: samples/12-direct-execution/README.md
// Run it with: pnpm sample 12
import { approveAll, type CopilotSession } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
const HANDS = new Set(["bash", "read_bash", "write_bash", "stop_bash", "list_bash", "view", "create", "edit", "glob", "grep"]);
const WORKER_TOOLS = new Set(["start_worker", "message_worker", "wait_for_workers", "read_worker_file", "copy_worker_files", "stop_worker"]);
const JOB =
  "Use two helpers in parallel, sub-agents (the task tool) if you have them and workers otherwise: one counts the prime numbers below 100,000 with Python, the other finds how many digits the 1,000th Fibonacci number has, also with Python. Then report both answers.";

/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

/** What a tool call did, in a few words. */
function summary(args: Record<string, unknown> | undefined): string {
  const text = String(args?.["command"] ?? args?.["path"] ?? args?.["pattern"] ?? args?.["name"] ?? args?.["shellId"] ?? "");
  return text.replace(/\s+/g, " ").slice(0, 70);
}

interface Run {
  readonly session: CopilotSession;
  readonly reply: string;
  readonly seconds: number;
  /** Agents in the coordinator's own runtime: its root agent and the sub-agents it started. */
  readonly agents: Map<string, string>;
  /** The coordinator's tool calls that act in sandboxes, by agent. */
  readonly calls: { readonly agent: string; readonly tool: string; readonly detail: string }[];
}

/** Runs one prompt in a new session of `environment`, printing which agent called which tool as it happens. */
async function run(environment: string, prompt: string): Promise<Run> {
  const client = await managed.client(environment);
  const agents = new Map<string, string>([["root", "root agent"]]);
  const calls: Run["calls"][number][] = [];
  // bash, write_bash, create, and edit ask once per call (reads don't); start_worker asks once per worker.
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  session.on((event) => {
    if (event.type === "subagent.started" && event.agentId) {
      agents.set(event.agentId, `sub-agent ${event.agentId.slice(0, 8)} (${event.data.agentName})`);
    } else if (event.type === "tool.execution_start" && (HANDS.has(event.data.toolName) || WORKER_TOOLS.has(event.data.toolName))) {
      const agent = event.agentId ? (agents.get(event.agentId) ?? `sub-agent ${event.agentId.slice(0, 8)}`) : "root agent";
      const detail = summary(event.data.arguments as Record<string, unknown> | undefined);
      calls.push({ agent, tool: event.data.toolName, detail });
      console.log(`  ${agent.padEnd(38)} ${event.data.toolName.padEnd(16)} ${detail}`);
    }
  });
  const started = Date.now();
  const reply = await session.sendAndWait({ prompt }, 20 * 60_000);
  return { session, reply: reply?.data.content ?? "", seconds: Math.round((Date.now() - started) / 1000), agents, calls };
}

/** The sandboxes and model loops a session used, from the platform's records. */
async function footprint(result: Run): Promise<{ sandboxes: number; loops: number; lines: string[] }> {
  const lines: string[] = [];
  const all = await managed.workers(result.session).list();
  const own = all.filter((worker) => worker.role === "hands");
  const workers = all.filter((worker) => worker.role !== "hands");
  for (const sandbox of own) {
    // Every command in a hands sandbox is recorded with the tool and the agent that ran it.
    const commands = await managed.exec.list(sandbox.id);
    const byAgent = new Map<string, number>();
    for (const command of commands) {
      const agent = command.caller?.agentId ? `sub-agent ${command.caller.agentId.slice(0, 8)}` : "root agent";
      byAgent.set(agent, (byAgent.get(agent) ?? 0) + 1);
    }
    lines.push(`  hands sandbox "${sandbox.name}" (${sandbox.environment}, no agent in it): ${commands.length} commands, ${[...byAgent].map(([agent, count]) => `${count} by ${agent}`).join(", ") || "none"}`);
  }
  for (const worker of workers) {
    lines.push(`  worker "${worker.name}" (${worker.environment}, its own agent and model loop): ${worker.state}; task: ${worker.task.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  // The coordinator's root agent and sub-agents run in the shared runtime; each worker runs its own model loop.
  return { sandboxes: own.length + workers.length, loops: result.agents.size + workers.length, lines };
}

const sessions: { environment: string; id: string }[] = [];
try {
  const results: { label: string; seconds: number; sandboxes: number; loops: number }[] = [];
  for (const [label, environment] of [
    ["Delegate", "team"],
    ["Direct", "operator"],
  ] as const) {
    console.log(`\n== ${label}: ${environment} ==`);
    const result = await run(environment, JOB);
    sessions.push({ environment, id: result.session.sessionId });
    const usage = await footprint(result);
    console.log(`\nCopilot (${environment}): ${result.reply.trim()}\n`);
    for (const line of usage.lines) console.log(line);
    results.push({ label, seconds: result.seconds, sandboxes: usage.sandboxes, loops: usage.loops });
  }
  console.log("\n            sandboxes  model loops  wall time");
  for (const result of results) console.log(`  ${result.label.padEnd(10)}${String(result.sandboxes).padStart(9)}  ${String(result.loops).padStart(11)}  ${String(result.seconds).padStart(7)} s`);

  // Mixed: one coordinator that can work in its own sandbox and start workers. The platform describes both options;
  // the model decides which part goes where.
  console.log("\n== Mixed: lead ==");
  const mixed = await run(
    "lead",
    [
      "Two things to do, then report both results:",
      "1. Our slow test suite: a Python script that checks the Collatz conjecture for every starting number below 20,000,000 and prints the starting number with the longest chain. It is independent of the fix and slow (about 15 minutes on a laptop); run it to completion.",
      "2. A quick fix: this greet.py prints the wrong greeting. Save it, fix it so it prints exactly `Hello, world!`, and show its output.",
      "```python\nprint('Helo world')\n```",
    ].join("\n"),
  );
  sessions.push({ environment: "lead", id: mixed.session.sessionId });
  const usage = await footprint(mixed);
  console.log(`\nCopilot (lead): ${mixed.reply.trim()}\n`);
  const itself = mixed.calls.filter((call) => HANDS.has(call.tool));
  const handedOff = (await managed.workers(mixed.session).list()).filter((worker) => worker.role !== "hands");
  console.log(`Did itself: ${itself.length === 0 ? "nothing" : `${itself.length} tool calls in its own sandbox (${[...new Set(itself.map((call) => call.tool))].join(", ")})`}`);
  console.log(`Gave to workers: ${handedOff.length === 0 ? "nothing" : handedOff.map((worker) => `"${worker.name}": ${worker.task.replace(/\s+/g, " ").slice(0, 70)}…`).join("; ")}`);
  for (const line of usage.lines) console.log(line);
  console.log(`Wall time: ${mixed.seconds} s`);
} finally {
  // Deleting a coordinator deletes its workers and hands sandboxes too.
  for (const { environment, id } of sessions) {
    const client = await managed.client(environment);
    await client.deleteSession(id).catch(couldNotDelete(`session ${id}`));
  }
  await managed.close();
}
