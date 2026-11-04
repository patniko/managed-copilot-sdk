import { approveAll, type PermissionRequest } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { eventually, snippet } from "./harness.js";

export default snippet(import.meta.url, { title: "Direct execution: the coordinator's hands in a sandbox", section: "spec §17", requires: ["orchestrator"], timeoutMs: 20 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  const asked: string[] = [];

  // "operator" is an orchestrator with execution: "direct": its shell and file tools act on a sandbox of "coder".
  const client = await managed.client("operator");
  const session = await client.createSession({
    model: "claude-sonnet-5",
    onPermissionRequest: (request: PermissionRequest, invocation) => {
      if (request.kind === "custom-tool") asked.push(String(request.toolName));
      return approveAll(request, invocation);
    },
  });
  t.cleanup(() => client.deleteSession(session.sessionId)); // deleting the coordinator deletes its sandbox
  const agents = new Set<string>();
  session.on("tool.execution_start", (e) => void agents.add(e.agentId ?? "root"));

  const reply = await session.sendAndWait(
    {
      prompt:
        "Use the create tool to write /workspace/outputs/report.md containing the single line `status: draft`. Then use the edit tool to change `draft` to `final`. Then run `cat /workspace/outputs/report.md && uname -s` with bash and tell me exactly what it printed.",
    },
    15 * 60_000,
  );
  console.log(reply?.data.content);

  const [hands] = (await managed.workers(session).list()).filter((worker) => worker.role === "hands");
  console.log(hands?.name, hands?.environment, hands?.state);

  // Acceptance checks
  t.check(Boolean(hands) && hands!.environment === "coder" && hands!.state === "idle", "the coordinator acted in one hands sandbox of coder");
  const file = hands ? await managed.files(hands.id).read("outputs/report.md") : "";
  t.check(file.trim() === "status: final", `the file was created and edited in the sandbox (${JSON.stringify(file.trim())})`);
  t.check(/status: final/.test(reply?.data.content ?? "") && /Linux/.test(reply?.data.content ?? ""), "bash ran in the Linux sandbox and printed the edited file");
  t.check(["create", "edit", "bash"].every((tool) => asked.includes(tool)), `create, edit, and bash asked for permission (${asked.join(", ")})`);
  const commands = hands ? await managed.exec.list(hands.id) : [];
  t.check(commands.some((command) => command.caller?.kind === "platform" && command.caller.name === "bash" && command.command.includes("uname")), "the command is recorded with the tool that ran it");
  // Its /workspace/outputs publishes as its artifacts at the end of the coordinator's turn.
  const published = hands ? await eventually(async () => (await managed.artifacts(hands.id).list()).find((artifact) => artifact.path === "report.md"), { timeoutMs: 60_000, what: "report.md to publish" }).catch(() => undefined) : undefined;
  t.check(Boolean(published), "the sandbox's outputs/report.md was published as an artifact");
  const info = hands ? await managed.sessions.get(hands.id) : undefined;
  t.check(info?.kind === "workspace" && info.parentSessionId === session.sessionId, "the hands sandbox is a workspace-only session of the coordinator");
  const coordinator = await managed.sessions.get(session.sessionId);
  t.check(coordinator.placement === "shared" && coordinator.sandbox === undefined, "the coordinator itself runs on the shared runtime");
});
