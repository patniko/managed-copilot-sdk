// Probe: a stock Copilot runtime on this machine (the brain) whose shell and file tools, and its sub-agents' tools,
// run inside a Docker container (the hands). No agent runs in the container.
// See docs/design/direct-execution.md. Needs `pnpm install`, Docker, and a Copilot sign-in on this machine.
//
//   docker run -d --name mc-hands-probe --network none --entrypoint sleep -w /workspace ghcr.io/patniko/managed-copilot-sandbox:0.1.0 infinity
//   node docs/design/probes/direct-execution.mjs
//   docker rm -f mc-hands-probe
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
const root = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sdk = await import(pathToFileURL(root + "/libraries/sdk/node_modules/@github/copilot-sdk/dist/index.js").href);
const C = "mc-hands-probe";
const PROMPT = "Use two sub-agents in parallel (the task tool, general-purpose agents). One writes /workspace/primes.py that counts primes below 100000 and runs it. The other writes /workspace/fib.py that prints how many digits the 1000th Fibonacci number has and runs it. Then report both answers and the OS name from /etc/os-release.";

const sh = (script, input) => new Promise((resolve) => {
  const child = spawn("docker", ["exec", "-i", "-w", "/workspace", C, "bash", "-c", script]);
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ code, out: out.slice(-16000) }));
  child.stdin.end(input ?? "");
});
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const calls = [];
const log = (name, args, inv) => { const who = inv.agentId ? `subagent ${inv.agentId.slice(0, 8)}` : "root"; calls.push({ name, who }); console.log(`  [hands] ${who.padEnd(17)} ${name} ${JSON.stringify(args).slice(0, 90)}`); };
const tool = (name, description, properties, required, run) => sdk.defineTool(name, {
  description, overridesBuiltInTool: true, skipPermission: true,
  parameters: { type: "object", properties, required },
  handler: async (args, inv) => { log(name, args, inv); return run(args); },
});
const S = { type: "string" };
const tools = [
  tool("bash", "Run a bash command in the Linux workspace (cwd /workspace). Returns combined output and exit code.", { command: S }, ["command"],
    async ({ command }) => { const r = await sh(command); return `${r.out}\n[exit ${r.code}]`; }),
  tool("view", "View a file (with line numbers) or list a directory in the workspace.", { path: S }, ["path"],
    async ({ path }) => (await sh(`if [ -d ${q(path)} ]; then ls -la ${q(path)}; else cat -n ${q(path)}; fi`)).out),
  tool("create", "Create a new file with the given content.", { path: S, file_text: S }, ["path", "file_text"],
    async ({ path, file_text }) => { const r = await sh(`mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, file_text); return r.code ? r.out : `Created ${path}`; }),
  tool("edit", "Replace exactly one occurrence of old_str with new_str in a file.", { path: S, old_str: S, new_str: S }, ["path", "old_str", "new_str"],
    async ({ path, old_str, new_str }) => {
      const cur = (await sh(`cat ${q(path)}`)).out; const n = cur.split(old_str).length - 1;
      if (n !== 1) return `old_str matched ${n} times; must match exactly once`;
      await sh(`cat > ${q(path)}`, cur.replace(old_str, new_str)); return `Edited ${path}`; }),
  tool("glob", "Find files by glob pattern under the workspace.", { pattern: S }, ["pattern"],
    async ({ pattern }) => (await sh(`shopt -s globstar nullglob; printf '%s\\n' ${pattern}`)).out),
  tool("grep", "Search file contents with grep -rn.", { pattern: S, path: S }, ["pattern"],
    async ({ pattern, path }) => (await sh(`grep -rn -- ${q(pattern)} ${q(path ?? ".")}`)).out),
];
const client = new sdk.CopilotClient({ cwd: tmpdir() });
await client.start();
const session = await client.createSession({
  model: "claude-sonnet-5",
  tools,
  excludedTools: ["powershell", "read_powershell", "write_powershell", "stop_powershell", "list_powershell", "web_fetch"],
  systemMessage: { mode: "customize", sections: { environment_context: { action: "replace", content:
    "<environment_context>\nYour tools act on a Linux container: bash, view, create, edit, glob, and grep all run there, in /workspace. There is no other machine.\n</environment_context>" } } },
  onPermissionRequest: sdk.approveAll,
});
session.on((e) => { if (e.type === "subagent.started") console.log(`  [brain] sub-agent started: ${e.data.agentName ?? e.data.agentDisplayName ?? ""}`); });
const reply = await session.sendAndWait({ prompt: PROMPT }, 6 * 60_000);
console.log("\nBRAIN:", reply?.data.content);
console.log("\nCALLS:", JSON.stringify(calls.reduce((a, c) => ((a[c.who] = (a[c.who] ?? 0) + 1), a), {})));
await session.disconnect(); await client.stop();
