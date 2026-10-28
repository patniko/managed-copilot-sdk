// End-to-end acceptance for commands run directly in sandboxes: a real gateway, real Docker sandboxes, and the SDK's
// managed.sandboxes and managed.exec (no model needed). Opt in with MANAGED_COPILOT_E2E=1 after `pnpm build`; it needs
// Docker and a GitHub sign-in (`gh auth login` or GH_TOKEN). Everything it creates is labelled and removed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.MANAGED_COPILOT_E2E === "1";
const root = join(import.meta.dirname, "..", "..", "..");
const instance = `mcexe${Math.random().toString(36).slice(2, 7)}`;
const tryDocker = (...args: string[]) => {
  try {
    return execFileSync("docker", args, { encoding: "utf8" }).trim();
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? (error as Error).message);
  }
};

describe.runIf(enabled)("commands run directly in sandboxes, end to end", () => {
  let gateway: { close(): Promise<void>; server: import("node:http").Server };
  let managed: any;
  let dataDir: string;
  let homeDir: string;
  let sandbox: any;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mc-exec-e2e-"));
    homeDir = mkdtempSync(join(tmpdir(), "mc-exec-e2e-home-"));
    process.env.MANAGED_COPILOT_HOME = homeDir;
    const { loadConfig } = await import(pathToFileURL(join(root, "platform/gateway/dist/config.js")).href);
    const { startGateway } = await import(pathToFileURL(join(root, "platform/gateway/dist/server.js")).href);
    const { ManagedCopilot } = await import(pathToFileURL(join(root, "packages/sdk/dist/index.js")).href);
    gateway = await startGateway(
      loadConfig({
        ...process.env,
        PORT: "0",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_INSTANCE: instance,
        MANAGED_COPILOT_CONFIG: JSON.stringify({
          name: "copilot",
          environments: {
            python: { type: "isolated", size: "small", network: false, env: { REPORT_TITLE: "Q3 sales" }, setupCommands: ["mkdir -p /workspace/data && echo 'month,revenue' > /workspace/data/sales.csv"] },
            locked: { type: "isolated", size: "small", network: false, exec: false },
          },
        }),
      }),
    );
    const address = gateway.server.address() as import("node:net").AddressInfo;
    managed = await ManagedCopilot.connect({ url: `http://127.0.0.1:${address.port}` });
  }, 600_000);

  afterAll(async () => {
    await managed?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    for (const kind of ["ps -a", "volume ls", "network ls"]) {
      const [command, ...flags] = kind.split(" ");
      const remove = command === "ps" ? ["rm", "-f"] : [command!, "rm", ...(command === "volume" ? ["-f"] : [])];
      for (const filter of [`label=managed-copilot.instance=${instance}`, `name=${instance}-`]) {
        const listed = tryDocker(command!, ...flags, "--filter", filter, "--format", command === "ps" ? "{{.Names}}" : "{{.Name}}");
        for (const name of listed.split("\n").filter(Boolean)) tryDocker(...remove, name);
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }, 120_000);

  it("creates a workspace-only sandbox that runs no Copilot runtime", async () => {
    expect(managed.info.capabilities).toContain("exec");
    expect(managed.info.environments.find((environment: { name: string }) => environment.name === "locked")?.exec).toBe(false);
    sandbox = await managed.sandboxes.create({ environment: "python" });
    expect(sandbox).toMatchObject({ kind: "workspace", placement: "sandbox", state: "ready", sandbox: { state: "running" } });
    expect(sandbox.sessionId).toBe(sandbox.id);
    const processes = await managed.exec(sandbox, "ps -eo user,args");
    expect(processes.output).not.toMatch(/copilot-runtime|--headless/);
  }, 600_000);

  it("runs a command as the workload identity in /workspace with the environment and setup", async () => {
    const result = await managed.exec(sandbox, "id -u && pwd && echo \"$REPORT_TITLE\" && cat data/sales.csv && env | grep -ci token || true");
    expect(result).toMatchObject({ state: "completed", exitCode: 0, background: false, caller: { kind: "api" } });
    const [uid, cwd, title, header, tokens] = result.output.trim().split("\n");
    expect([uid, cwd, title, header, tokens]).toEqual(["10001", "/workspace", "Q3 sales", "month,revenue", "0"]);
    expect((await managed.exec(sandbox, "exit 3")).exitCode).toBe(3);
  }, 120_000);

  it("streams a background command, writes its stdin, and waits for its result", async () => {
    const job = await managed.exec(sandbox, "for i in 1 2 3; do echo tick $i; sleep 0.3; done; read line; echo got $line", { background: true });
    expect(job.id).toMatch(/^ex_/);
    await job.end("hello\n");
    let text = "";
    for await (const chunk of job.output) text += chunk;
    expect(text).toBe("tick 1\ntick 2\ntick 3\ngot hello\n");
    expect(await job.result).toMatchObject({ state: "completed", exitCode: 0, output: text });
  }, 120_000);

  it("stops and times out commands, killing their process group", async () => {
    const job = await managed.exec(sandbox, "sleep 300 & sleep 300; echo never", { background: true });
    expect(await job.stop()).toMatchObject({ state: "stopped" });
    expect((await managed.exec(sandbox, "pgrep -c sleep || true")).output.trim()).toBe("0");
    const slow = await managed.exec(sandbox, "sleep 30", { timeoutMs: 1000 });
    expect(slow).toMatchObject({ state: "timed_out" });
    expect(slow.reason).toMatch(/timeout/);
  }, 120_000);

  it("never runs a command twice for one ID", async () => {
    const first = await managed.exec(sandbox, "echo $RANDOM >> /workspace/once.txt", { id: "once-1" });
    const again = await managed.exec(sandbox, "echo $RANDOM >> /workspace/once.txt", { id: "once-1" });
    expect(again.id).toBe(first.id);
    expect((await managed.exec(sandbox, "wc -l < /workspace/once.txt")).output.trim()).toBe("1");
    const list = await managed.exec.list(sandbox);
    expect(list.filter((entry: { id: string }) => entry.id === "once-1")).toHaveLength(1);
  }, 120_000);

  it("works with files and publishes outputs after each command", async () => {
    await managed.files(sandbox).write("script.py", "print(6 * 7)\n");
    expect((await managed.exec(sandbox, "python3 script.py")).output).toBe("42\n");
    const done = await managed.exec(sandbox, "mkdir -p outputs && echo '# Report' > outputs/report.md");
    const publication = await managed.artifacts(sandbox).waitForPublication({ turnId: done.id, timeoutMs: 60_000 });
    expect(publication.state).toBe("published");
    expect(await managed.artifacts(sandbox).read("report.md")).toBe("# Report\n");
  }, 120_000);

  it("refuses agent operations on it and exec where the operator turned it off", async () => {
    const client = await managed.client("python");
    await expect(client.resumeSession(sandbox.id, { onPermissionRequest: () => ({ kind: "approved" }) })).rejects.toThrow(/workspace-only/);
    await client.stop();
    await expect(managed.sandboxes.create({ environment: "locked" })).rejects.toMatchObject({ code: "policy_violation", message: "Running commands directly is turned off for environment locked." });
  }, 120_000);

  it("deletes it with its sandbox", async () => {
    await managed.sessions.delete(sandbox.id);
    await expect(managed.sessions.get(sandbox.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(managed.exec(sandbox, "true")).rejects.toMatchObject({ code: "not_found" });
  }, 120_000);
});
