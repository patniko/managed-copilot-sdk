/**
 * Egress against real sandboxes: the real gateway with the sandbox module (Docker provider, per-sandbox internal
 * networks, sandboxd installing the egress CA) and the network module (supervised egress container). Commands run in
 * the sandbox as the workload user with the exact environment sandboxd gave the runtime.
 *
 * Opt in with `pnpm --filter @managed-copilot/egress test:docker` after `pnpm build` (Docker required; the sandbox
 * image is built on first use).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../gateway/src/config.js";
import { startGateway, type RunningGateway } from "../../../gateway/src/server.js";
import { CertificateAuthority, createCaMaterial } from "../../src/x509.js";

const RUN = `mcsbx${randomBytes(3).toString("hex")}`;
const STRIPE_SECRET = `sk_test_sbx_${randomBytes(8).toString("hex")}`;
const OWNER = 9202;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const bearer = (token: string) => ["Bearer", token].join(" ");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function docker(args: readonly string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { env: options.env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.code !== 0 && !options.allowFailure) reject(new Error(`docker ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr.slice(-800)}`));
      else resolve(result);
    });
    child.stdin.end();
  });
}

const ECHO_SCRIPT = `
const crypto = require("crypto");
const sha = (v) => (v ? crypto.createHash("sha256").update(v).digest("hex") : null);
const handler = (req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ via: process.env.ECHO_NAME, url: req.url, authorizationSha256: sha(req.headers.authorization) })); }); };
if (process.env.ECHO_TLS === "1") require("https").createServer({ cert: Buffer.from(process.env.ECHO_CERT_B64, "base64"), key: Buffer.from(process.env.ECHO_KEY_B64, "base64") }, handler).listen(443);
else require("http").createServer(handler).listen(80);
`;

const CONFIG = {
  name: "copilot",
  vaults: { payments: [{ env: "STRIPE_API_KEY", value: { secretEnv: "SBX_STRIPE_KEY" }, hosts: ["vault.mc.test"] }] },
  environments: {
    offline: { type: "isolated", size: "small", network: false },
    lister: { type: "isolated", size: "small", network: ["plain.mc.test", "example.com"] },
    coder: { type: "isolated", size: "small", vaults: ["payments"], network: ["vault.mc.test"] },
  },
};

describe.skipIf(process.env.MC_SKIP_DOCKER === "1")("egress with real sandboxes (Docker)", () => {
  const upstreamCa = new CertificateAuthority(createCaMaterial({ commonName: "Sandbox E2E Upstream CA" }));
  const echoes: string[] = [];
  const sandboxes = new Map<string, { container: string; env: Record<string, string>; ip: string }>();
  let gateway: RunningGateway;
  let dataDir: string;

  /** Runs a shell command in the sandbox as the workload user, with the environment sandboxd gave the runtime. */
  const run = (name: string, script: string): Promise<Run> => {
    const box = sandboxes.get(name)!;
    return docker(["exec", "--user", "10001:10001", ...Object.keys(box.env).flatMap((key) => ["-e", key]), box.container, "sh", "-c", script], {
      env: { ...process.env, ...box.env },
      allowFailure: true,
    });
  };

  async function sandbox(name: string, environment: string): Promise<void> {
    const sessionId = `${RUN}-${name}`;
    const network = gateway.app.service("policy").bindSession({ sessionId, owner: OWNER, environment, type: "isolated", requested: undefined, vaults: undefined });
    const sandboxes_ = (gateway.app.services as Record<string, unknown>)["sandboxes"] as { create(request: unknown): Promise<{ id?: string }>; get(sessionId: string): Promise<{ id: string }> | { id: string } };
    await sandboxes_.create({ sessionId, ownerId: OWNER, environment, size: "small", network, vaults: gateway.app.service("policy").session(sessionId)!.vaults });
    const info = await sandboxes_.get(sessionId);
    const container = `${RUN}-${info.id.replace("_", "-")}`;
    const environ = await docker(["exec", "--user", "10001:10001", container, "sh", "-c", "tr '\\0' '\\n' < /proc/$(pgrep -u 10001 -f copilot-runtime | head -1)/environ"]);
    const env: Record<string, string> = {};
    for (const line of environ.stdout.split("\n")) {
      const index = line.indexOf("=");
      const key = line.slice(0, index);
      if (/^(https?_proxy|no_proxy|node_use_env_proxy|node_extra_ca_certs|requests_ca_bundle|ssl_cert_file|pip_cert|stripe_api_key)$/i.test(key)) env[key] = line.slice(index + 1);
    }
    const ip = (await docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container])).stdout.split(" ")[0]!;
    sandboxes.set(name, { container, env, ip });
  }

  beforeAll(async () => {
    const wan = `${RUN}-egress-wan`;
    await docker(["network", "create", "--label", `managed-copilot.instance=${RUN}`, wan]);
    const cert = upstreamCa.issue("vault.mc.test");
    for (const [name, alias, extra] of [
      ["vault", "vault.mc.test", { ECHO_TLS: "1", ECHO_CERT_B64: Buffer.from(cert.certPem).toString("base64"), ECHO_KEY_B64: Buffer.from(cert.keyPem).toString("base64") }],
      ["plain", "plain.mc.test", {}],
    ] as const) {
      const env = { ECHO_NAME: name, ...extra };
      await docker(["run", "-d", "--name", `${RUN}-echo-${name}`, "--label", `managed-copilot.instance=${RUN}`, "--network", wan, "--network-alias", alias, ...Object.keys(env).flatMap((key) => ["-e", key]), "--entrypoint", "node", "node:24-alpine", "-e", ECHO_SCRIPT], {
        env: { ...process.env, ...env },
      });
      echoes.push(`${RUN}-echo-${name}`);
    }
    dataDir = mkdtempSync(join(tmpdir(), "mc-egress-sbx-"));
    gateway = await startGateway(
      loadConfig({
        ...process.env,
        PORT: "0",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_INSTANCE: RUN,
        // Lets any gateway remove what this run leaves behind if it dies before its own cleanup.
        MANAGED_COPILOT_INSTANCE_TTL_SECONDS: "21600",
        MANAGED_COPILOT_EGRESS: "docker",
        MANAGED_COPILOT_EGRESS_PRIVATE_HOSTS: "plain.mc.test,vault.mc.test",
        MANAGED_COPILOT_EGRESS_UPSTREAM_CA_B64: Buffer.from(upstreamCa.certPem).toString("base64"),
        MANAGED_COPILOT_CONFIG: JSON.stringify(CONFIG),
        SBX_STRIPE_KEY: STRIPE_SECRET,
      }),
    );
    await sandbox("offline", "offline");
    await sandbox("lister", "lister");
    await sandbox("coder", "coder");
  }, 900_000);

  afterAll(async () => {
    await gateway?.close().catch(() => undefined);
    for (const kind of [["ps", "-a"], ["volume", "ls"], ["network", "ls"]] as const) {
      const listed = await docker([...kind, "--filter", `label=managed-copilot.instance=${RUN}`, "--format", kind[0] === "ps" ? "{{.Names}}" : "{{.Name}}"], { allowFailure: true });
      for (const name of listed.stdout.split("\n").filter(Boolean)) {
        await docker(kind[0] === "ps" ? ["rm", "-f", name] : kind[0] === "volume" ? ["volume", "rm", "-f", name] : ["network", "rm", name], { allowFailure: true });
      }
    }
    for (const name of echoes) await docker(["rm", "-f", name], { allowFailure: true });
    await docker(["network", "rm", `${RUN}-egress-wan`], { allowFailure: true });
    await docker(["volume", "rm", `${RUN}-egress-data`], { allowFailure: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }, 300_000);

  it("gives the runtime the proxy settings and no real secrets", async () => {
    for (const name of ["offline", "lister", "coder"]) {
      const env = sandboxes.get(name)!.env;
      expect(env.HTTPS_PROXY, name).toMatch(/^http:\/\/sbx_[0-9a-f]+:[A-Za-z0-9_-]{43}@mc-egress:3128$/);
    }
    expect(sandboxes.get("coder")!.env.STRIPE_API_KEY).toMatch(/^mcv_placeholder_[0-9a-f]{40}$/);
    const environment = await docker(["exec", "--user", "10001:10001", sandboxes.get("coder")!.container, "sh", "-c", "cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'"], { allowFailure: true });
    expect(environment.stdout).toContain("STRIPE_API_KEY=mcv_placeholder_");
    expect(environment.stdout).not.toContain(STRIPE_SECRET);
  });

  it("network: false blocks curl, pip, npm, git, and raw sockets in a real sandbox", async () => {
    expect((await run("offline", "curl -sS --max-time 20 https://example.com/")).stderr).toMatch(/CONNECT tunnel failed, response 403/);
    const pip = await run("offline", "python3 -m pip download --no-deps --dest /tmp/p --retries 1 --timeout 10 requests 2>&1");
    expect(pip.stdout).toMatch(/403|ProxyError|Tunnel connection failed/);
    expect((await run("offline", "npm view left-pad version --fetch-retries=0 --fetch-timeout=15000 2>&1; echo exit=$?")).stdout).toMatch(/exit=[1-9]/);
    expect((await run("offline", "git ls-remote https://github.com/microsoft/aspire 2>&1")).stdout).toMatch(/403|CONNECT/);
    expect((await run("offline", "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 443), timeout=5)\" 2>&1; echo exit=$?")).stdout).toMatch(/exit=1/);
  });

  it("a host list allows only its hosts, and peers stay unreachable", async () => {
    expect(JSON.parse((await run("lister", "curl -sS --max-time 20 http://plain.mc.test/ok")).stdout)).toMatchObject({ via: "plain", url: "/ok" });
    expect((await run("lister", "curl -sS -o /dev/null -w '%{http_code}' --max-time 60 https://example.com/")).stdout).toBe("200");
    expect((await run("lister", "curl -sS --max-time 20 https://github.com/")).stderr).toMatch(/response 403/);
    const peer = sandboxes.get("offline")!.ip;
    expect((await run("lister", `curl -sS --max-time 20 http://${peer}:7781/v1/health`)).stdout).toMatch(/Direct IP connections are not allowed|Port 7781/);
    expect((await run("lister", `curl -sS --noproxy '*' --max-time 5 http://${peer}:7781/v1/health; echo exit=$?`)).stdout).toMatch(/exit=(7|28)/);
  });

  it("substitutes vault placeholders for curl, Python, and Node through the CA sandboxd installed", async () => {
    const expected = sha256(bearer(STRIPE_SECRET));
    const curl = await run("coder", 'curl -sS --max-time 20 -H "Authorization: Bearer $STRIPE_API_KEY" https://vault.mc.test/curl');
    expect(JSON.parse(curl.stdout).authorizationSha256).toBe(expected);
    const python = await run("coder", "python3 -c \"import os, urllib.request; r = urllib.request.Request('https://vault.mc.test/py', headers={'Authorization': 'Bearer ' + os.environ['STRIPE_API_KEY']}); print(urllib.request.urlopen(r, timeout=20).read().decode())\"");
    expect(JSON.parse(python.stdout).authorizationSha256).toBe(expected);
    const node = await run("coder", "node -e \"fetch('https://vault.mc.test/node', { headers: { authorization: 'Bearer ' + process.env.STRIPE_API_KEY } }).then(r => r.text()).then(console.log)\"");
    expect(JSON.parse(node.stdout).authorizationSha256).toBe(expected);
    expect((await run("coder", 'curl -sS --max-time 20 "https://vault.mc.test/q?key=$STRIPE_API_KEY"')).stdout).toMatch(/not in URLs/);
  });
});
