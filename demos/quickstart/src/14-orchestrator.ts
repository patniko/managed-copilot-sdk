import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

export default snippet(import.meta.url, { title: "Orchestrator: a coordinator with workers", section: "spec §17", requires: ["orchestrator"], timeoutMs: 30 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  const started: string[] = [];
  managed.on("worker.started", (e) => void started.push(String(e.data.workerId)));

  managed.on("worker.started", (e) => console.log(`${e.data.name} started in ${e.data.environment}`));

  const client = await managed.client("team");
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(session.sessionId)); // deleting the coordinator deletes its workers

  // The coordinator starts workers, waits for their reports, and answers: one sendAndWait covers the whole job.
  const reply = await session.sendAndWait(
    {
      prompt:
        "In parallel, use one worker to compute the sum of the integers from 1 to 1000 with Python and another to compute 20 factorial with Python. Report both numbers.",
    },
    25 * 60_000,
  );
  console.log(reply?.data.content);

  for (const worker of await managed.workers(session).list()) {
    console.log(worker.name, worker.environment, worker.state, worker.result);
  }

  // Acceptance checks
  const answer = reply?.data.content.replace(/[,\s]/g, "") ?? "";
  t.check(answer.includes("500500") && answer.includes("2432902008176640000"), "the coordinator reported both workers' results");
  const workers = await managed.workers(session).list();
  t.check(workers.length >= 2, `the coordinator started ${workers.length} workers`);
  t.check(workers.every((worker) => worker.environment === "coder" && worker.state !== "working" && worker.state !== "starting"), "every worker ran in coder and finished");
  for (const worker of workers.filter((candidate) => candidate.state !== "stopped")) {
    const info = await managed.sessions.get(worker.id);
    t.check(info.parentSessionId === session.sessionId && info.placement === "sandbox" && Boolean(info.sandbox?.id), `worker ${worker.name} is a session in its own sandbox ${info.sandbox?.id}`);
  }
  t.check(workers.every((worker) => started.includes(worker.id)), "managed.on('worker.started') fired for each worker");
  const coordinator = await managed.sessions.get(session.sessionId);
  t.check(coordinator.placement === "shared" && coordinator.sandbox === undefined, "the coordinator itself has no sandbox");
});
