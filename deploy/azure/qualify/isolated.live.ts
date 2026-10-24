/**
 * Live check of isolated placement against any gateway (gate G3): a real isolated session with a real model, a file
 * written to /workspace, the sandbox's compute stopped by idle stop and replaced on the next turn, and the file read
 * back from the same disks. Not part of `pnpm test`.
 *
 *   pnpm build
 *   npx tsx deploy/azure/qualify/isolated.live.ts <gateway URL> <isolated environment> [idle wait seconds]
 *
 * The environment should set a short `idleTimeoutSeconds` (the default is 900). The token comes from
 * MANAGED_COPILOT_GITHUB_TOKEN / GH_TOKEN / `gh auth token`.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// The built package, as customers use it: the stock client spawns dist/bridge.js next to it.
import { ManagedCopilot } from "../../../packages/sdk/dist/index.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const { approveAll } = (await import(pathToFileURL(createRequire(resolve(ROOT, "packages/sdk/package.json")).resolve("@github/copilot-sdk")).href)) as {
  approveAll: (...args: unknown[]) => unknown;
};

const [url, environment, idleWait = "150"] = process.argv.slice(2);
if (!url || !environment) {
  process.stderr.write("Usage: npx tsx deploy/azure/qualify/isolated.live.ts <gateway URL> <isolated environment> [idle wait seconds]\n");
  process.exit(64);
}

const log = (message: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${message}\n`);
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, ...(detail ? { detail } : {}) });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const token = process.env.MANAGED_COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true }).trim();

const managed = await ManagedCopilot.connect({ url, gitHubToken: token });
try {
  check("isolated advertised", managed.info.capabilities.includes("isolated"), managed.info.capabilities.join(", "));
  const client = await managed.client(environment);
  const started = Date.now();
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll as never });
  log(`created session ${session.sessionId} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const reply = await session.sendAndWait({ prompt: "Reply with exactly the word PONG and nothing else." }, 5 * 60_000);
  const text = String((reply as { data?: { content?: unknown } } | undefined)?.data?.content ?? "");
  check("model reply from the sandbox's stock runtime", /PONG/.test(text), text.slice(0, 80));

  const info = await managed.sessions.get(session.sessionId);
  const sandboxId = info.sandbox?.id;
  check("session runs in its own sandbox", info.placement === "sandbox" && Boolean(sandboxId), `${info.placement} ${sandboxId ?? ""}`);

  const files = managed.files(session);
  const marker = `azure-${Date.now()}`;
  await files.write("qualify/marker.txt", marker);
  check("file written to /workspace", (await files.read("qualify/marker.txt")).trim() === marker);
  const tool = await session.sendAndWait({ prompt: "Use the shell to run `id -u && cat qualify/marker.txt` in the workspace, then reply with its exact output." }, 5 * 60_000);
  const toolText = String((tool as { data?: { content?: unknown } } | undefined)?.data?.content ?? "");
  check("the agent's shell runs as uid 10001 and sees the file", /10001/.test(toolText) && toolText.includes(marker), toolText.slice(0, 120));

  log(`waiting up to ${idleWait} s for idle stop…`);
  const deadline = Date.now() + Number(idleWait) * 1000;
  let state = info.sandbox?.state;
  while (Date.now() < deadline) {
    state = (await managed.sessions.get(session.sessionId)).sandbox?.state;
    if (state === "stopped") break;
    await new Promise((done) => setTimeout(done, 5_000));
  }
  check("idle stop released the compute", state === "stopped", `state ${state}`);

  const resumeStarted = Date.now();
  const resumed = await client.resumeSession(session.sessionId, { onPermissionRequest: approveAll as never });
  const after = await resumed.sendAndWait({ prompt: "Use the shell to run `cat qualify/marker.txt` in the workspace, then reply with its exact output." }, 10 * 60_000);
  const afterText = String((after as { data?: { content?: unknown } } | undefined)?.data?.content ?? "");
  check("after compute replacement, the workspace kept its files", afterText.includes(marker), `${((Date.now() - resumeStarted) / 1000).toFixed(1)} s: ${afterText.slice(0, 80)}`);
  check("the resumed session kept its sandbox", (await managed.sessions.get(session.sessionId)).sandbox?.id === sandboxId);

  await client.deleteSession(session.sessionId);
  log("deleted the session (and its sandbox and disks)");
} catch (error) {
  check("run", false, (error as Error).message);
} finally {
  await managed.close();
  const failed = results.filter((result) => !result.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
