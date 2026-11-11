// End-to-end acceptance for isolated placement: a real gateway, real Docker sandboxes, the stock Copilot SDK, and a
// real model. Opt in with MANAGED_COPILOT_E2E=1 after `pnpm build`; it needs Docker and a GitHub sign-in (`gh auth
// login` or GH_TOKEN) with Copilot access. Everything it creates is labelled with a unique instance and removed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";

const enabled = process.env.MANAGED_COPILOT_E2E === "1";
const root = join(import.meta.dirname, "..", "..", "..");
const instance = `mce2e${Math.random().toString(36).slice(2, 7)}`;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args);
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? (error as Error).message);
  }
};
const container = (sandboxId: string) => `${instance}-${sandboxId.replace("_", "-")}`;

// A tiny npm CLI installed offline during setup proves the persisted tool environment survives idle stop and resume.
const INSTALL_DEMO_CLI = String.raw`mkdir -p /tmp/npmdemo && cd /tmp/npmdemo && printf '{"name":"demo-cli","version":"1.2.3","bin":{"demo-cli":"cli.js"}}' > package.json && printf '#!/usr/bin/env node\nconsole.log("demo-cli 1.2.3")\n' > cli.js && npm pack --silent && npm install -g --offline --no-audit --no-fund ./demo-cli-1.2.3.tgz`;

/**
 * Hosts pip needs for setup installs: the configured index (the gateway bakes the same one into the image), else PyPI.
 * Azure Artifacts feeds behind packagefeedproxy redirect wheel downloads to *.pkgs.visualstudio.com and then to blob
 * storage (*.vsblob.vsassets.io).
 */
function pipHosts(): string[] {
  let index = process.env.MANAGED_COPILOT_PIP_INDEX_URL;
  if (!index && enabled) {
    try {
      index = /global\.index-url='([^']+)'/.exec(execFileSync("python", ["-m", "pip", "config", "list"], { encoding: "utf8" }))?.[1];
    } catch {
      index = undefined;
    }
  }
  if (!index) return ["pypi.org", "files.pythonhosted.org"];
  const host = new URL(index).hostname;
  return host.endsWith("packagefeedproxy.microsoft.io") ? [host, "*.pkgs.visualstudio.com", "*.vsblob.vsassets.io"] : [host];
}
const PIP_HOSTS = pipHosts();

describe.runIf(enabled)("isolated placement end to end", () => {
  let gateway: { close(): Promise<void>; server: import("node:http").Server; app: { services: Record<string, unknown> } };
  let managed: any;
  let client: CopilotClient;
  let session: CopilotSession;
  let dataDir: string;
  let homeDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mc-e2e-"));
    homeDir = mkdtempSync(join(tmpdir(), "mc-e2e-home-"));
    process.env.MANAGED_COPILOT_HOME = homeDir;
    const { loadConfig } = await import(pathToFileURL(join(root, "services/gateway/dist/config.js")).href);
    const { startGateway } = await import(pathToFileURL(join(root, "services/gateway/dist/server.js")).href);
    const { ManagedCopilot } = await import(pathToFileURL(join(root, "libraries/sdk/dist/index.js")).href);
    gateway = await startGateway(
      loadConfig({
        ...process.env,
        PORT: "0",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_INSTANCE: instance,
        // Lets any gateway remove what this run leaves behind if it dies before its own cleanup.
        MANAGED_COPILOT_INSTANCE_TTL_SECONDS: "21600",
        MANAGED_COPILOT_SANDBOX_IDLE_SECONDS: "20",
        MANAGED_COPILOT_SANDBOX_IDLE_SWEEP_MS: "4000",
        MANAGED_COPILOT_CONFIG: JSON.stringify({
          name: "copilot",
          environments: {
            coder: { type: "isolated", size: "small", network: false, setupCommands: ["git config --global user.name 'Contoso Agent'", INSTALL_DEMO_CLI], env: { REPORT_TITLE: "Q3 sales" } },
            egress: { type: "isolated", size: "small", network: { access: "restricted", allowedDomains: PIP_HOSTS }, packages: { python: ["six==1.16.0"] } },
            // glibc writes one LD_DEBUG_OUTPUT file per process that honored the loader variables.
            ldprobe: { type: "isolated", size: "small", network: false, env: { LD_DEBUG: "libs", LD_DEBUG_OUTPUT: "/tmp/lddebug" }, setupCommands: ["true"] },
            broken: { type: "isolated", size: "small", network: false, setupCommands: ["echo starting && exit 3"] },
          },
        }),
      }),
    );
    const address = gateway.server.address() as import("node:net").AddressInfo;
    managed = await ManagedCopilot.connect({ url: `http://127.0.0.1:${address.port}` });
    client = await managed.client("coder");
  }, 600_000);

  afterAll(async () => {
    await managed?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    for (const name of tryDocker("ps", "-a", "--filter", `label=managed-copilot.instance=${instance}`, "--format", "{{.Names}}").split("\n").filter(Boolean)) tryDocker("rm", "-f", name);
    for (const name of tryDocker("volume", "ls", "--filter", `label=managed-copilot.instance=${instance}`, "--format", "{{.Name}}").split("\n").filter(Boolean)) tryDocker("volume", "rm", "-f", name);
    for (const name of tryDocker("network", "ls", "--filter", `label=managed-copilot.instance=${instance}`, "--format", "{{.Name}}").split("\n").filter(Boolean)) tryDocker("network", "rm", name);
    // Egress resources may carry only the instance prefix.
    for (const name of tryDocker("ps", "-a", "--filter", `name=${instance}-`, "--format", "{{.Names}}").split("\n").filter(Boolean)) tryDocker("rm", "-f", name);
    for (const name of tryDocker("volume", "ls", "--filter", `name=${instance}-`, "--format", "{{.Name}}").split("\n").filter(Boolean)) tryDocker("volume", "rm", "-f", name);
    for (const name of tryDocker("network", "ls", "--filter", `name=${instance}-`, "--format", "{{.Name}}").split("\n").filter(Boolean)) tryDocker("network", "rm", name);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }, 120_000);

  it("creates a ready sandbox, streams files, runs a real turn, and publishes its outputs", async () => {
    session = await client.createSession({ onPermissionRequest: approveAll });
    const info = await managed.sessions.get(session.sessionId);
    expect(info.placement).toBe("sandbox");
    expect(info.sandbox).toMatchObject({ state: "running", size: "small", network: { access: "disabled" } });

    const local = join(dataDir, "sales.csv");
    writeFileSync(local, "month,revenue\nJan,100\nFeb,140\nMar,90\n");
    expect(await managed.files(session).upload(local, "data/sales.csv")).toMatchObject({ path: "data/sales.csv", size: 37 });
    expect((await managed.files(session).list("data")).map((entry: { path: string }) => entry.path)).toEqual(["data/sales.csv"]);

    await session.sendAndWait(
      {
        prompt:
          "Use the shell to count the data rows (excluding the header) in data/sales.csv and to run `demo-cli` and `echo $REPORT_TITLE`. Then write outputs/report.md with the heading '# Sales report', the row count, the demo-cli output, the report title, and a markdown table of the CSV. Reply with just DONE.",
      },
      300_000,
    );
    const artifacts = managed.artifacts(session);
    const publication = await artifacts.waitForPublication();
    expect(publication.state).toBe("published");
    expect(publication.artifacts.map((artifact: { path: string }) => artifact.path)).toContain("report.md");
    const report = await artifacts.read("report.md");
    expect(report).toMatch(/Sales report/i);
    expect(report).toMatch(/1\.2\.3/);
    expect(report).toMatch(/Q3 sales/i);
    expect(await managed.files(session).read("outputs/report.md")).toBe(report);
  }, 600_000);

  it("keeps the GitHub token out of the sandbox and blocks peers and the Internet", async () => {
    const second = await client.createSession({ onPermissionRequest: approveAll });
    const a = (await managed.sessions.get(session.sessionId)).sandbox;
    const b = (await managed.sessions.get(second.sessionId)).sandbox;
    expect(a.id).not.toBe(b.id);
    const ipB = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container(b.id));
    expect(tryDocker("exec", "--user", "10001:10001", container(a.id), "sh", "-c", `curl -sS -m 4 http://${ipB}:7781/v1/health; echo exit=$?`)).toMatch(/exit=(7|28)/);
    expect(tryDocker("exec", "--user", "10001:10001", container(a.id), "sh", "-c", "curl -sS -m 4 https://github.com; echo exit=$?")).toMatch(/exit=(6|7|28)/);
    expect(docker("exec", container(a.id), "sh", "-c", "grep -rIlE 'gh[opsu]_[A-Za-z0-9]{20}|github_pat_' /workspace /home/agent /var/lib/managed-copilot 2>/dev/null | head -3; echo scanned")).toBe("scanned");
    expect(docker("exec", "--user", "10001:10001", container(a.id), "sh", "-c", "env | grep -ciE '^(gh_token|github_token|copilot_github_token)=' || true")).toBe("0");

    await client.deleteSession(second.sessionId);
    const leftovers = [
      tryDocker("ps", "-a", "--filter", `name=${container(b.id)}`, "--format", "{{.Names}}"),
      tryDocker("volume", "ls", "--filter", `name=${container(b.id)}`, "--format", "{{.Name}}"),
      tryDocker("network", "ls", "--filter", `name=${container(b.id)}`, "--format", "{{.Name}}"),
    ].join("");
    expect(leftovers).toBe("");
  }, 300_000);

  it("installs setup packages through the egress proxy for a restricted network", async () => {
    const egress = await managed.client("egress");
    const restricted = await egress.createSession({ onPermissionRequest: approveAll });
    const sandboxes = gateway.app.services.sandboxes as any;
    const setup = sandboxes.setupRecord(restricted.sessionId);
    expect(setup.state).toBe("succeeded");
    expect(setup.resolved.python?.six).toBe("1.16.0");
    const info = (await managed.sessions.get(restricted.sessionId)).sandbox;
    expect(info.network.access).toBe("restricted");
    // The workload has no direct route: only the proxy env sandboxd gives the runtime reaches the index.
    expect(tryDocker("exec", "--user", "10001:10001", container(info.id), "sh", "-c", `curl -sS -m 4 https://${PIP_HOSTS[0]!.replace(/^\*\./, "")}; echo exit=$?`)).toMatch(/exit=(6|7|28)/);
    await egress.deleteSession(restricted.sessionId);
  }, 600_000);

  it("imports exported runtime state into a running sandbox for promotion", async () => {
    const target = await client.createSession({ onPermissionRequest: approveAll });
    const sandboxes = gateway.app.services.sandboxes as any;
    const exported = mkdtempSync(join(tmpdir(), "mc-e2e-export-"));
    try {
      writeFileSync(join(exported, "events.jsonl"), '{"type":"session.start"}\n');
      writeFileSync(join(exported, "workspace.yaml"), "id: imported\n");
      mkdirSync(join(exported, "checkpoints"));
      writeFileSync(join(exported, "checkpoints", "index.md"), "# Checkpoints\n");
      writeFileSync(join(exported, "inuse.lock"), "lock");
      expect(await sandboxes.importRuntimeState(target.sessionId, { sessionStateDir: exported, activeTurnId: "carried-turn" })).toEqual({ files: 3, bytes: 25 + 13 + 14 });
      const id = (await managed.sessions.get(target.sessionId)).sandbox.id;
      const list = () =>
        docker("exec", "--user", "10001:10001", container(id), "sh", "-c", `cd /var/lib/managed-copilot/runtime/session-state/${target.sessionId} && find . -type f | sort && stat -c %u events.jsonl && ls -a ..`);
      const first = list();
      expect(first).toContain("./events.jsonl");
      expect(first).toContain("./checkpoints/index.md");
      expect(first).not.toContain("inuse.lock");
      expect(first).toMatch(/^10001$/m);
      // A retried import replaces the directory instead of merging into it.
      rmSync(join(exported, "workspace.yaml"));
      expect((await sandboxes.importRuntimeState(target.sessionId, { sessionStateDir: exported })).files).toBe(2);
      expect(list()).not.toContain("workspace.yaml");
    } finally {
      rmSync(exported, { recursive: true, force: true });
      await client.deleteSession(target.sessionId);
    }
  }, 300_000);

  it("never lets the workload environment reach a process that still runs as root", async () => {
    const probe = await managed.client("ldprobe");
    const probeSession = await probe.createSession({ onPermissionRequest: approveAll });
    try {
      const id = (await managed.sessions.get(probeSession.sessionId)).sandbox.id;
      // Setup commands and the runtime honor the workload's LD_DEBUG as uid 10001. setpriv, the only launcher process
      // that runs as root (and the only one linking libcap-ng), must never see it: LD_AUDIT would run code as root.
      expect(docker("exec", container(id), "sh", "-c", "stat -c %u /tmp/lddebug.* | sort -u")).toBe("10001");
      expect(docker("exec", container(id), "sh", "-c", "grep -l libcap-ng /tmp/lddebug.* || true")).toBe("");
    } finally {
      await probe.deleteSession(probeSession.sessionId);
    }
  }, 300_000);

  it("fails creation explicitly when setup fails", async () => {
    const broken = await managed.client("broken");
    await expect(broken.createSession({ onPermissionRequest: approveAll })).rejects.toThrow(/exit code 3/);
  }, 300_000);

  it("stops idle compute and resumes with the workspace and installed tools intact", async () => {
    let state: string | undefined;
    for (let attempt = 0; attempt < 30 && state !== "stopped"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      state = (await managed.sessions.get(session.sessionId)).sandbox?.state;
    }
    expect(state).toBe("stopped");
    const reply = await session.sendAndWait({ prompt: "Run `wc -l < data/sales.csv` and `demo-cli` in the shell and reply with both outputs on one line." }, 300_000);
    expect(reply?.data.content).toMatch(/4/);
    expect(reply?.data.content).toMatch(/1\.2\.3/);
    expect((await managed.sessions.get(session.sessionId)).sandbox?.state).toBe("running");
    await client.deleteSession(session.sessionId);
    expect(tryDocker("ps", "-a", "--filter", `label=managed-copilot.instance=${instance}`, "--filter", "label=managed-copilot.component=sandbox", "--format", "{{.Names}}")).toBe("");
  }, 600_000);
});
