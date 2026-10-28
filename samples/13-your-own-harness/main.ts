// Walkthrough 13: your own harness, with its hands in a platform sandbox.
// Steps and output: samples/13-your-own-harness/README.md
// Run it with: pnpm sample 13
import { tmpdir } from "node:os";
import { CopilotClient, defineTool, type PermissionRequest } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { z } from "zod";

const managed = await ManagedCopilot.connect();

// 1. A workspace-only sandbox of the isolated "coder" environment: its image, setup, network rules, and vaults apply,
//    and no agent runs in it.
const sandbox = await managed.sandboxes.create({ environment: "coder" });
console.log(`Sandbox ${sandbox.id}: ${sandbox.kind}, ${sandbox.sandbox?.state} (${sandbox.sandbox?.size})`);

/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

let client: CopilotClient | undefined;
try {
  // 2. Run a command and wait for it: you get its exit code and output.
  const result = await managed.exec(sandbox, "python3 -c 'print(6 * 7)'", { timeoutMs: 60_000 });
  console.log(`\nexec: exit ${result.exitCode}, output ${JSON.stringify(result.output)}`);

  // 3. A long-running command: start it, read its output as it goes, then wait for its result.
  const job = await managed.exec(sandbox, 'for step in 1 2 3; do echo "step $step"; sleep 1; done', { background: true });
  console.log(`\nbackground ${job.id}:`);
  for await (const chunk of job.output) process.stdout.write(`  ${chunk.trimEnd().split("\n").join("\n  ")}\n`);
  const finished = await job.result;
  console.log(`  -> ${finished.state}, exit ${finished.exitCode}`);

  // 4. Your own harness: a stock Copilot client in this process (the brain) whose shell and file tools, and its
  //    sub-agents', run in the sandbox (the hands). The tools replace the built-ins with the same names.
  const hands = (agentId: string | undefined, name: string, detail: string) =>
    console.log(`  [hands] ${(agentId ? `sub-agent ${agentId.slice(0, 8)}` : "root").padEnd(18)} ${name} ${detail.replace(/\s+/g, " ").slice(0, 60)}`);
  const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
  const files = managed.files(sandbox);
  const tools = [
    defineTool("bash", {
      description: "Run a bash command in the Linux workspace (cwd /workspace). Returns its output and exit code.",
      parameters: z.object({ command: z.string() }),
      overridesBuiltInTool: true,
      handler: async ({ command }, invocation) => {
        hands(invocation.agentId, "bash", command);
        const run = await managed.exec(sandbox, command, { timeoutMs: 5 * 60_000 });
        return `${run.output}\n[exit ${run.exitCode ?? run.state}]`;
      },
    }),
    defineTool("view", {
      description: "View a file in the workspace with line numbers, or list a directory.",
      parameters: z.object({ path: z.string() }),
      overridesBuiltInTool: true,
      skipPermission: true,
      handler: async ({ path }, invocation) => {
        hands(invocation.agentId, "view", path);
        return (await managed.exec(sandbox, `if [ -d ${quote(path)} ]; then ls -la ${quote(path)}; else cat -n ${quote(path)}; fi`)).output;
      },
    }),
    defineTool("create", {
      description: "Create a file in the workspace with the given content.",
      parameters: z.object({ path: z.string(), file_text: z.string() }),
      overridesBuiltInTool: true,
      handler: async ({ path, file_text }, invocation) => {
        hands(invocation.agentId, "create", path);
        await files.write(path, file_text);
        return `Created ${path}`;
      },
    }),
    defineTool("edit", {
      description: "Replace exactly one occurrence of old_str with new_str in a workspace file.",
      parameters: z.object({ path: z.string(), old_str: z.string(), new_str: z.string() }),
      overridesBuiltInTool: true,
      handler: async ({ path, old_str, new_str }, invocation) => {
        hands(invocation.agentId, "edit", path);
        const current = await files.read(path);
        const matches = current.split(old_str).length - 1;
        if (matches !== 1) return `old_str matched ${matches} times; it must match exactly once.`;
        await files.write(path, current.replace(old_str, new_str));
        return `Edited ${path}`;
      },
    }),
  ];

  client = new CopilotClient({ workingDirectory: tmpdir() });
  await client.start();
  const session = await client.createSession({
    model: "claude-sonnet-5",
    tools,
    // This machine's own shell, search, and web tools stay out: everything the agents do happens in the sandbox.
    excludedTools: ["powershell", "read_powershell", "write_powershell", "stop_powershell", "list_powershell", "glob", "grep", "web_fetch"],
    systemMessage: {
      mode: "customize",
      sections: {
        environment_context: {
          action: "replace",
          content: "<environment_context>\nYour bash, view, create, and edit tools act on a Linux sandbox, in /workspace. There is no other machine.\n</environment_context>",
        },
      },
    },
    // Your app decides: bash, create, and edit ask here once per call (view doesn't ask).
    onPermissionRequest: (request: PermissionRequest) => {
      if (request.kind === "custom-tool") console.log(`  [your app] approve ${request.toolName}? yes`);
      return { kind: "approved" };
    },
  });
  session.on("subagent.started", (event) => console.log(`  [brain] sub-agent started: ${event.data.agentDisplayName ?? event.data.agentName}`));

  console.log("\nharness:");
  const reply = await session.sendAndWait(
    {
      prompt:
        "Use two sub-agents in parallel (the task tool, general-purpose agents). One writes /workspace/primes.py that counts the primes below 100,000 and runs it. The other writes /workspace/fib.py that prints how many digits the 1,000th Fibonacci number has and runs it. Then report both answers in one sentence.",
    },
    10 * 60_000,
  );
  console.log(`\nCopilot: ${reply?.data.content}`);
  await session.disconnect();

  // 5. The sandbox kept what the agents wrote, and its journal records every command with who ran it.
  console.log(`\nfiles: ${(await files.list()).map((entry) => entry.path).join(", ")}`);
  const commands = await managed.exec.list(sandbox);
  const callers = [...new Set(commands.map((command) => command.caller?.login ?? command.caller?.kind ?? "unknown"))];
  console.log(`commands: ${commands.length}, ${commands.filter((command) => command.state === "completed").length} completed, run by ${callers.join(", ")}`);
} finally {
  await client?.stop().catch(() => undefined);
  // Deleting the sandbox deletes its files and its command journal.
  await managed.sessions.delete(sandbox.id).catch(couldNotDelete(`sandbox ${sandbox.id}`));
  await managed.close();
}
