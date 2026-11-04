/**
 * End to end with Docker: the real gateway network module supervises the real egress container; sandbox-like client
 * containers sit on their own internal networks (no route out) and use the proxy settings and CA the policy service
 * issues. Echo services stand in for the Internet (operator-allowed private hosts) so no real secret or third-party
 * API is involved.
 *
 * Client images: by default one image is built from node:24-alpine with curl, git, python3, and pip (needs the Alpine
 * package mirrors). On slow or restricted networks, point at prebuilt local images instead:
 *   MC_E2E_CURL_IMAGE   any image with sh and curl (update-ca-certificates or update-ca-trust)
 *   MC_E2E_TOOLS_IMAGE  any image with sh, git, python3, node 24, and npm (update-ca-certificates)
 *   MC_E2E_PIP_PYZ      optional path to pip.pyz, copied into the tools container when it has no pip
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../gateway/src/config.js";
import { startGateway, type RunningGateway } from "../../../gateway/src/server.js";
import { CertificateAuthority, createCaMaterial } from "../../src/x509.js";

const RUN = `mce2e${randomBytes(3).toString("hex")}`;
const STRIPE_SECRET = `sk_test_e2e_${randomBytes(8).toString("hex")}`;
const JIRA_SECRET = `jira_e2e_${randomBytes(8).toString("hex")}`;
const ALICE = { token: "tok-alice-e2e", id: 9101, login: "alice" };
const WAN = `${RUN}-egress-wan`;
const EGRESS = `${RUN}-egress`;
const CURL_IMAGE = process.env.MC_E2E_CURL_IMAGE;
const TOOLS_IMAGE = process.env.MC_E2E_TOOLS_IMAGE;
const PIP_PYZ = process.env.MC_E2E_PIP_PYZ;
const BUILT_IMAGE = `${RUN}-client:latest`;
const ECHO_IMAGE = process.env.MC_E2E_ECHO_IMAGE ?? "node:24-alpine";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const bearer = (token: string) => ["Bearer", token].join(" ");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function docker(args: readonly string[], options: { env?: NodeJS.ProcessEnv; input?: string; allowFailure?: boolean } = {}): Promise<Run> {
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
    child.stdin.end(options.input ?? "");
  });
}

const sh = (container: string, script: string, user?: string) => docker(["exec", ...(user ? ["-u", user] : []), container, "sh", "-c", script], { allowFailure: true });
const output = (run: Run) => `${run.stdout}\n${run.stderr}`;

const ECHO_SCRIPT = `
const crypto = require("crypto");
const sha = (v) => (v ? crypto.createHash("sha256").update(v).digest("hex") : null);
const handler = (req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => res.write("tick\\n"), 250);
    setTimeout(() => { clearInterval(timer); res.end("done\\n"); }, 60000);
    res.on("close", () => clearInterval(timer));
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ via: process.env.ECHO_NAME, method: req.method, url: req.url, host: req.headers.host,
      authorization: req.headers.authorization || null, authorizationSha256: sha(req.headers.authorization), apiKeySha256: sha(req.headers["x-api-key"]) }));
  });
};
if (process.env.ECHO_TLS === "1") require("https").createServer({ cert: Buffer.from(process.env.ECHO_CERT_B64, "base64"), key: Buffer.from(process.env.ECHO_KEY_B64, "base64") }, handler).listen(443);
else require("http").createServer(handler).listen(80);
`;

const INSTALL_CA =
  "mkdir -p /etc/managed-copilot && cat > /etc/managed-copilot/egress-ca.pem && " +
  "if command -v update-ca-certificates >/dev/null; then mkdir -p /usr/local/share/ca-certificates && cp /etc/managed-copilot/egress-ca.pem /usr/local/share/ca-certificates/managed-copilot-egress.crt && update-ca-certificates >/dev/null 2>&1; " +
  "elif command -v update-ca-trust >/dev/null; then cp /etc/managed-copilot/egress-ca.pem /etc/pki/ca-trust/source/anchors/managed-copilot-egress.pem && update-ca-trust; fi";

const TOOLS_ENV = {
  NODE_EXTRA_CA_CERTS: "/etc/managed-copilot/egress-ca.pem",
  REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
};

const CONFIG = {
  name: "copilot",
  vaults: { payments: [{ env: "STRIPE_API_KEY", value: { secretEnv: "E2E_STRIPE_KEY" }, hosts: ["vault.mc.test"] }] },
  environments: {
    offline: { type: "isolated", network: false },
    lister: { type: "isolated", network: ["plain.mc.test", "private.mc.test", "example.com"] },
    open: { type: "isolated", network: true },
    coder: { type: "isolated", vaults: ["payments"], network: ["vault.mc.test", "plain.mc.test"] },
    other: { type: "isolated", network: ["vault.mc.test"] },
  },
};

interface Box {
  readonly sandboxId: string;
  readonly sessionId: string;
  /** Container used for curl checks. */
  readonly curl: string;
  /** Container used for git, python, node, npm, and pip checks (the same container when one image has everything). */
  readonly tools: string;
  readonly ip: string;
}

describe.skipIf(process.env.MC_SKIP_DOCKER === "1")("egress end to end (Docker)", () => {
  const upstreamCa = new CertificateAuthority(createCaMaterial({ commonName: "E2E Upstream CA" }));
  const containers: string[] = [];
  const networks: string[] = [];
  const boxes = new Map<string, Box>();
  let github: Server;
  let gateway: RunningGateway;
  let dataDir: string;
  let curlImage = BUILT_IMAGE;
  let toolsImage = BUILT_IMAGE;

  async function startClient(name: string, network: string, image: string, env: Record<string, string>, ca: string): Promise<{ container: string; ip: string }> {
    const container = `${RUN}-${name}`;
    await docker(["run", "-d", "--name", container, "--network", network, "--entrypoint", "sleep", ...Object.keys(env).flatMap((key) => ["-e", key]), image, "3600"], { env: { ...process.env, ...env } });
    containers.push(container);
    if (ca) await docker(["exec", "-i", "-u", "0", container, "sh", "-c", INSTALL_CA], { input: ca });
    const ip = (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container])).stdout;
    return { container, ip };
  }

  async function sandbox(name: string, sessionId: string): Promise<Box> {
    const policy = gateway.app.service("policy");
    const sandboxId = `sbx_${RUN}_${name}`;
    const egress = await policy.registerSandbox({ sandboxId, sessionId });
    const network = `${RUN}-sbx-${name}`;
    await docker(["network", "create", "--internal", "--label", `managed-copilot.instance=${RUN}`, network]);
    networks.push(network);
    await docker(["network", "connect", "--alias", "mc-egress", network, EGRESS]);
    const curl = await startClient(`${name}-curl`, network, curlImage, curlImage === toolsImage ? { ...egress.env, ...TOOLS_ENV } : egress.env, egress.caCertificate);
    const tools = curlImage === toolsImage ? curl : await startClient(`${name}-tools`, network, toolsImage, { ...egress.env, ...TOOLS_ENV }, egress.caCertificate);
    if (curl === tools) policy.updateSandbox(sandboxId, { address: curl.ip });
    if (PIP_PYZ && tools !== curl) await docker(["cp", PIP_PYZ, `${tools.container}:/opt/pip.pyz`]);
    const box = { sandboxId, sessionId, curl: curl.container, tools: tools.container, ip: curl.ip };
    boxes.set(name, box);
    return box;
  }

  const blockedFor = async (sessionId: string) => {
    const response = await fetch(`${gateway.url}/v1/sessions/${sessionId}/network`, { headers: { authorization: bearer(ALICE.token) } });
    return ((await response.json()) as { blocked: { reason: string; host?: string }[] }).blocked;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      execFile("node", ["scripts/bundle.mjs"], { cwd: fileURLToPath(new URL("../..", import.meta.url)) }, (error) => (error ? reject(error) : resolve()));
    });
    if (CURL_IMAGE && TOOLS_IMAGE) {
      curlImage = CURL_IMAGE;
      toolsImage = TOOLS_IMAGE;
    } else {
      await docker(["build", "-q", "-t", BUILT_IMAGE, "-"], { input: "FROM node:24-alpine\nRUN apk add --no-cache curl git python3 py3-pip ca-certificates >/dev/null\n" });
    }

    // Echo services on the egress proxy's Internet-side network.
    await docker(["network", "create", "--label", `managed-copilot.instance=${RUN}`, WAN]);
    networks.push(WAN);
    const vaultCert = upstreamCa.issue("vault.mc.test");
    const echoes: [string, string, Record<string, string>][] = [
      ["vault", "vault.mc.test", { ECHO_TLS: "1", ECHO_CERT_B64: Buffer.from(vaultCert.certPem).toString("base64"), ECHO_KEY_B64: Buffer.from(vaultCert.keyPem).toString("base64") }],
      ["plain", "plain.mc.test", {}],
      ["private", "private.mc.test", {}],
    ];
    for (const [name, alias, extra] of echoes) {
      const env = { ECHO_NAME: name, ...extra };
      await docker(["run", "-d", "--name", `${RUN}-echo-${name}`, "--network", WAN, "--network-alias", alias, ...Object.keys(env).flatMap((key) => ["-e", key]), "--entrypoint", "node", ECHO_IMAGE, "-e", ECHO_SCRIPT], {
        env: { ...process.env, ...env },
      });
      containers.push(`${RUN}-echo-${name}`);
    }

    github = createServer((req, res) => {
      const ok = (req.headers.authorization ?? "").endsWith(ALICE.token);
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { id: ALICE.id, login: ALICE.login } : { message: "Bad credentials" }));
    });
    await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", () => resolve()));
    dataDir = mkdtempSync(join(tmpdir(), "mc-egress-e2e-"));
    gateway = await startGateway(
      loadConfig({
        ...process.env,
        PORT: "0",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_INSTANCE: RUN,
        MANAGED_COPILOT_EGRESS: "docker",
        MANAGED_COPILOT_EGRESS_PRIVATE_HOSTS: "plain.mc.test,vault.mc.test",
        MANAGED_COPILOT_EGRESS_UPSTREAM_CA_B64: Buffer.from(upstreamCa.certPem).toString("base64"),
        MANAGED_COPILOT_GITHUB_API_URL: `http://127.0.0.1:${(github.address() as { port: number }).port}`,
        MANAGED_COPILOT_CONFIG: JSON.stringify(CONFIG),
        E2E_STRIPE_KEY: STRIPE_SECRET,
      }),
    );

    // A vault created in code by alice, for her coder session.
    const created = await fetch(`${gateway.url}/v1/vaults`, {
      method: "POST",
      headers: { authorization: bearer(ALICE.token), "content-type": "application/json" },
      body: JSON.stringify({ name: "jira-e2e", credentials: [{ env: "JIRA_TOKEN", value: JIRA_SECRET, hosts: ["vault.mc.test"], headers: ["x-api-key"] }] }),
    });
    expect(created.status).toBe(201);
    const jira = (await created.json()) as { id: string };

    const policy = gateway.app.service("policy");
    const bind = (sessionId: string, environment: string, vaults?: string[]) => policy.bindSession({ sessionId, owner: ALICE.id, environment, type: "isolated", requested: undefined, vaults });
    bind("s-off", "offline");
    bind("s-list", "lister");
    bind("s-open", "open");
    bind("s-coder", "coder", [jira.id]);
    bind("s-other", "other");
    await sandbox("off", "s-off");
    await sandbox("list", "s-list");
    await sandbox("open", "s-open");
    await sandbox("coder", "s-coder");
    await sandbox("other", "s-other");
  });

  afterAll(async () => {
    if (process.env.MC_E2E_KEEP === "1") {
      console.log(`Keeping Docker resources with prefix ${RUN} for inspection`);
      await gateway?.close();
      return;
    }
    for (const container of containers) await docker(["rm", "-f", container], { allowFailure: true });
    await gateway?.close();
    for (const network of [...networks].reverse()) await docker(["network", "rm", network], { allowFailure: true });
    await docker(["network", "rm", `${RUN}-sandboxes`], { allowFailure: true });
    await docker(["volume", "rm", `${RUN}-egress-data`], { allowFailure: true });
    if (!(CURL_IMAGE && TOOLS_IMAGE)) await docker(["image", "rm", BUILT_IMAGE], { allowFailure: true });
    github?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("network: false blocks curl, pip, npm, git, and raw sockets", async () => {
    const box = boxes.get("off")!;
    const curl = await sh(box.curl, "curl -sS --max-time 20 https://example.com");
    expect(curl.code).not.toBe(0);
    expect(curl.stderr).toMatch(/CONNECT tunnel failed, response 403/);
    expect((await sh(box.curl, "curl -sS --max-time 20 http://example.com/")).stdout).toMatch(/network: false/);
    const pipCommand = (await sh(box.tools, "python3 -m pip --version")).code === 0 ? "python3 -m pip" : existsSync(PIP_PYZ ?? "") ? "python3 /opt/pip.pyz" : undefined;
    if (pipCommand) {
      const pip = await sh(box.tools, `${pipCommand} download --no-deps --dest /tmp/pip --retries 1 --timeout 10 requests`);
      expect(pip.code).not.toBe(0);
      expect(output(pip)).toMatch(/403|ProxyError|Tunnel connection failed/);
    }
    const npm = await sh(box.tools, "npm view left-pad version --fetch-retries=0 --fetch-timeout=15000");
    expect(npm.code).not.toBe(0);
    expect(output(npm)).toMatch(/403|proxy|tunnel/i);
    const git = await sh(box.tools, "git ls-remote https://github.com/microsoft/aspire");
    expect(git.code).not.toBe(0);
    expect(git.stderr).toMatch(/403|CONNECT/);
    const raw = await sh(box.tools, "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 443), timeout=5)\"");
    expect(raw.code).not.toBe(0);
    const bypass = await sh(box.curl, "curl -sS --noproxy '*' --max-time 10 https://1.1.1.1/");
    expect(bypass.code).not.toBe(0);
    expect((await blockedFor("s-off")).map((entry) => entry.reason)).toContain("network_disabled");
  });

  it("a host list allows only those hosts", async () => {
    const box = boxes.get("list")!;
    expect(JSON.parse((await sh(box.curl, "curl -sS --max-time 20 http://plain.mc.test/hello")).stdout)).toMatchObject({ via: "plain", url: "/hello" });
    // -k: this checks that the proxy lets the tunnel through; minimal client images may lack some public roots.
    const internet = await sh(box.curl, "curl -sSk -o /dev/null -w '%{http_code}' --max-time 60 https://example.com/");
    expect(internet.stdout, output(internet)).toBe("200");
    expect((await sh(box.curl, "curl -sS --max-time 20 https://github.com/")).stderr).toMatch(/CONNECT tunnel failed, response 403/);
    expect((await sh(box.curl, "curl -sS --max-time 20 https://www.example.com/")).stderr).toMatch(/response 403/);
  });

  it("blocks metadata, loopback, private, direct-IP, port, and peer destinations", async () => {
    const list = boxes.get("list")!.curl;
    const open = boxes.get("open")!.curl;
    const peer = boxes.get("off")!.ip;
    const port = new URL(gateway.url).port;
    const cases: [string, string, RegExp][] = [
      [list, "curl -sS --max-time 20 http://private.mc.test/", /private network address/],
      [list, "curl -sS --max-time 20 http://169.254.169.254/latest/meta-data/", /Direct IP connections are not allowed/],
      [open, "curl -sS --max-time 20 http://169.254.169.254/latest/meta-data/", /metadata/],
      [open, "curl -sS --max-time 20 http://metadata.google.internal/", /not resolve|metadata|address/],
      [open, "curl -sS --noproxy '' --max-time 20 http://127.0.0.1:80/", /loopback/],
      [open, "curl -sS --noproxy '' --max-time 20 http://localhost:80/", /loopback/],
      [open, "curl -sS --max-time 20 http://host.docker.internal/healthz", /which workloads cannot reach/],
      [open, `curl -sS --max-time 20 http://host.docker.internal:${port}/healthz`, /Port \d+ is not allowed/],
      [open, "curl -sS --max-time 20 http://mc-egress:3128/healthz", /Port 3128 is not allowed|which workloads cannot reach/],
      [open, "curl -sS --max-time 20 http://mc-egress/healthz", /which workloads cannot reach/],
      [open, `curl -sS --max-time 20 http://${peer}/`, /which workloads cannot reach/],
      [open, "curl -sS --max-time 20 https://plain.mc.test:22/", /response 403/],
    ];
    for (const [box, command, message] of cases) expect(output(await sh(box, command)), command).toMatch(message);
    expect((await sh(open, "curl -sSk -o /dev/null -w '%{http_code}' --max-time 60 https://example.com/")).stdout).toBe("200");
    expect((await sh(open, `curl -sS --noproxy '*' --max-time 10 http://${peer}/`)).code).not.toBe(0);
  });

  it("pins each proxy credential to its sandbox's address", async () => {
    const box = boxes.get("open")!;
    if (box.curl === box.tools) {
      const other = boxes.get("list")!;
      const stolen = (await sh(box.curl, "printenv HTTPS_PROXY")).stdout;
      const reused = await sh(other.curl, `curl -sS --max-time 20 --proxy '${stolen}' https://example.com/`);
      expect(reused.stderr).toMatch(/response 403/);
    } else {
      gateway.app.service("policy").updateSandbox(box.sandboxId, { address: box.ip });
      expect((await sh(box.tools, "node -e \"fetch('https://example.com/').then(r => console.log(r.status), e => console.log('failed', e.cause?.message ?? e.message))\"")).stdout).toMatch(/failed|403/);
      const internet = await sh(box.curl, "curl -sSk -o /dev/null -w '%{http_code}' --max-time 60 https://example.com/");
    expect(internet.stdout, output(internet)).toBe("200");
    }
  });

  it("vault placeholders are substituted only for their session, host, and header", async () => {
    const coder = boxes.get("coder")!;
    const placeholder = (await sh(coder.curl, 'echo "$STRIPE_API_KEY"')).stdout;
    expect(placeholder).toMatch(/^mcv_placeholder_[0-9a-f]{40}$/);
    expect((await sh(coder.curl, "env")).stdout).not.toContain(STRIPE_SECRET);

    const curl = JSON.parse((await sh(coder.curl, 'curl -sS --max-time 20 -H "Authorization: Bearer $STRIPE_API_KEY" https://vault.mc.test/v1/balance')).stdout) as { authorizationSha256: string; authorization: string };
    expect(curl.authorizationSha256).toBe(sha256(bearer(STRIPE_SECRET)));
    expect(curl.authorization).toBe(bearer("[redacted]"));

    const python = await sh(
      coder.tools,
      "python3 -c \"import os, urllib.request; r = urllib.request.Request('https://vault.mc.test/py', headers={'Authorization': 'Bearer ' + os.environ['STRIPE_API_KEY']}); print(urllib.request.urlopen(r, timeout=20).read().decode())\"",
    );
    expect(JSON.parse(python.stdout).authorizationSha256).toBe(sha256(bearer(STRIPE_SECRET)));
    const node = await sh(coder.tools, "node -e \"fetch('https://vault.mc.test/node', { headers: { authorization: 'Bearer ' + process.env.STRIPE_API_KEY } }).then(r => r.text()).then(console.log)\"");
    expect(JSON.parse(node.stdout).authorizationSha256).toBe(sha256(bearer(STRIPE_SECRET)));

    const jira = JSON.parse((await sh(coder.curl, 'curl -sS --max-time 20 -H "x-api-key: $JIRA_TOKEN" https://vault.mc.test/jira')).stdout) as { apiKeySha256: string };
    expect(jira.apiKeySha256).toBe(sha256(JIRA_SECRET));

    expect((await sh(coder.curl, 'curl -sS --max-time 20 "https://vault.mc.test/v1?key=$STRIPE_API_KEY"')).stdout).toMatch(/not in URLs/);
    expect((await sh(coder.curl, 'curl -sS --max-time 20 -H "Authorization: Bearer $STRIPE_API_KEY" http://plain.mc.test/')).stdout).toMatch(/only substituted in HTTPS/);
    const pinned = await sh(coder.curl, "curl -sS --max-time 20 --pinnedpubkey 'sha256//YhKJKSzoTt2b5FP18fvpHo7fJYqQCjAa3HWY3tvRMwE=' https://vault.mc.test/");
    expect(pinned.code).not.toBe(0);

    // Another session cannot use the placeholder: its tunnel is not intercepted, so the echo sees the literal text.
    const copied = JSON.parse((await sh(boxes.get("other")!.curl, `curl -sS -k --max-time 20 -H "Authorization: Bearer ${placeholder}" https://vault.mc.test/copied`)).stdout) as { authorizationSha256: string };
    expect(copied.authorizationSha256).toBe(sha256(bearer(placeholder)));

    let reasons: string[] = [];
    for (let attempt = 0; attempt < 25 && !reasons.includes("tls_client_untrusted"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      reasons = (await blockedFor("s-coder")).map((entry) => entry.reason);
    }
    expect(reasons).toEqual(expect.arrayContaining(["credential_misuse", "tls_client_untrusted"]));
  });

  it("revocation stops new uses immediately", async () => {
    const coder = boxes.get("coder")!;
    const vaults = (await (await fetch(`${gateway.url}/v1/vaults`, { headers: { authorization: bearer(ALICE.token) } })).json()) as { id: string; name: string }[];
    const jira = vaults.find((vault) => vault.name === "jira-e2e")!;
    expect((await fetch(`${gateway.url}/v1/vaults/${jira.id}`, { method: "DELETE", headers: { authorization: bearer(ALICE.token) } })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await sh(coder.curl, 'curl -sS --max-time 20 -H "x-api-key: $JIRA_TOKEN" https://vault.mc.test/jira')).stdout).toMatch(/does not belong to this session, or its vault was revoked/);
  });

  it("closes open connections when a sandbox is unregistered", async () => {
    const open = boxes.get("open")!;
    const pending = sh(open.curl, "curl -sS -o /dev/null --max-time 60 http://plain.mc.test/slow; echo exit=$?");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    gateway.app.service("policy").unregisterSandbox(open.sandboxId);
    expect((await pending).stdout).toMatch(/exit=(?!0\b)\d+/);
    expect((await sh(open.curl, "curl -sS --max-time 20 https://example.com/")).stderr).toMatch(/407/);
  });
});
