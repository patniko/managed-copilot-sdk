import type { ExecResult } from "@managed-copilot/protocol";
import { resolveSession, type Context } from "../context.js";
import { UsageError } from "../errors.js";
import { shortId } from "../output.js";

/** Exit codes for commands that did not exit by themselves (as `timeout` and shells use them). */
const TIMED_OUT = 124;
const STOPPED = 130;

function exitCodeOf(result: ExecResult): number {
  if (result.state === "completed") return result.exitCode ?? 1;
  if (result.state === "timed_out") return TIMED_OUT;
  if (result.state === "stopped") return STOPPED;
  return 1;
}

/** `exec <session> -- <command>`: runs a command in the session's sandbox, streaming its output; exits with its code. */
export async function exec(ctx: Context): Promise<number> {
  const [sessionRef, ...words] = ctx.args;
  if (!sessionRef) throw new UsageError("Name a session and a command.", "Example: npx managed-copilot exec 7f3a2c1 -- ls -la");
  if (words.length === 0) throw new UsageError("Pass the command after `--`.", `Example: npx managed-copilot exec ${sessionRef} -- python3 --version`);
  // One word is a whole command line (`-- "ls | wc -l"`); several are joined as typed.
  const command = words.join(" ");
  let timeoutMs: number | undefined;
  if (ctx.options.timeout !== undefined) {
    const seconds = Number(ctx.options.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout takes a number of seconds, e.g. --timeout 600.");
    timeoutMs = Math.round(seconds * 1000);
  }
  const managed = await (await ctx.deployment()).managed();
  const session = await resolveSession(managed, sessionRef);
  if (ctx.json) {
    const result = await managed.exec(session.id, command, { ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    ctx.out(JSON.stringify(result, null, 2));
    return exitCodeOf(result);
  }
  const job = await managed.exec(session.id, command, { background: true, timeoutMs: timeoutMs ?? 10 * 60_000, stdin: "closed" });
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) process.exit(STOPPED);
    interrupted = true;
    ctx.err(ctx.errStyle.dim(`Stopping ${job.id} in ${shortId(session.id)}...`));
    void job.stop().catch(() => undefined);
  };
  process.on("SIGINT", onInterrupt);
  try {
    for await (const chunk of job.output) ctx.write(chunk);
    const result = await job.result;
    if (result.skippedBytes) ctx.err(ctx.errStyle.dim(`(${result.skippedBytes} bytes of older output were not kept)`));
    if (result.state !== "completed") ctx.err(`${ctx.errStyle.red(ctx.errStyle.fail)} ${result.reason ?? `The command ended as ${result.state}.`}`);
    return exitCodeOf(result);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
