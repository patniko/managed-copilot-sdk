#!/usr/bin/env node
// Qualifies Azure Container Apps Sandboxes for the Managed Copilot Azure provider against a live sandbox group, with
// the gateway's own data-plane client and Azure CLI credentials (the deployer needs "Container Apps SandboxGroup Data
// Owner" on the group; deploy/azure/qualify/sandboxes-probe.bicep sets that up). Prints one JSON line per check and a
// summary. Creates sandboxes and data disks labelled mc-instance=qualify and removes them at the end (KEEP=1 keeps them).
//
// Environment: AZ_SUBSCRIPTION, AZ_RESOURCE_GROUP, AZ_SANDBOX_GROUP, AZ_REGION, SANDBOX_IMAGE (registry image built by
// `aspire deploy`), REGISTRY_TOKEN (`az acr login -n <registry> --expose-token`), VNET_CONNECTION, PROXY_IP (a forward proxy reachable
// through the VNet, port 3128), CLIENT_CIDR (this machine's address, allowed to reach sandbox ports), STEPS (optional
// comma-separated subset: api,image,sandbox,sandboxd,inside,egress,persistence,isolation).
// Requires `pnpm build` first.
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { SandboxApi } from "../../../platform/gateway/dist/modules/sandbox/providers/azure/api.js";
import { AzureCliTokenSource } from "../../../platform/gateway/dist/modules/sandbox/providers/azure/credential.js";

const env = process.env;
const required = (name) => env[name] ?? (() => { throw new Error(`Set ${name}.`); })();
const steps = new Set((env.STEPS ?? "api,image,sandbox,sandboxd,inside,egress,persistence,isolation").split(","));
const api = new SandboxApi({
  endpoint: env.AZ_SANDBOX_ENDPOINT ?? `https://management.${required("AZ_REGION")}.azuredevcompute.io`,
  subscriptionId: required("AZ_SUBSCRIPTION"),
  resourceGroup: required("AZ_RESOURCE_GROUP"),
  sandboxGroup: required("AZ_SANDBOX_GROUP"),
  apiVersion: env.AZ_SANDBOX_API_VERSION ?? "2026-02-01-preview",
  tokens: new AzureCliTokenSource(),
});
const labels = { "mc-instance": "qualify" };
const results = [];
const created = { sandboxes: new Set(), disks: new Set(), images: new Set() };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const elapsed = (started) => `${((Date.now() - started) / 1000).toFixed(1)} s`;

function record(check, outcome, details = {}) {
  const entry = { check, outcome, ...details };
  results.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  return entry;
}

async function attempt(check, run) {
  const started = Date.now();
  try {
    const { outcome = "passed", ...details } = (await run()) ?? {};
    return record(check, outcome, { ...details, took: elapsed(started) });
  } catch (error) {
    return record(check, "failed", { error: error.message, status: error.status, code: error.code, took: elapsed(started) });
  }
}

async function waitFor(what, read, done, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not finish in ${timeoutMs / 1000} s (last: ${JSON.stringify(value)?.slice(0, 300)})`);
    await sleep(3_000);
  }
}

async function diskImage() {
  const existing = (await api.listDiskImages()).find((image) => image.labels?.["mc-instance"] === "qualify" && image.labels?.["mc-ref"] === Buffer.from(required("SANDBOX_IMAGE")).toString("hex").slice(0, 60));
  // A registry token (az acr login --expose-token): identity-based pulls are rejected by the 2026-02-01-preview data plane.
  const image = existing ?? (await api.createDiskImage(required("SANDBOX_IMAGE"), { ...labels, "mc-ref": Buffer.from(required("SANDBOX_IMAGE")).toString("hex").slice(0, 60) }, { registryCredentials: { username: "00000000-0000-0000-0000-000000000000", token: required("REGISTRY_TOKEN") } }));
  created.images.add(image.id);
  return waitFor("disk image", () => api.getDiskImage(image.id), (value) => ["ready", "succeeded", "failed"].includes(value?.status?.state?.toLowerCase() ?? ""), 30 * 60_000);
}

async function ensureDisks(prefix) {
  // The provider's "small" layout: 20 GiB per vCPU in total, root disk included.
  const names = { workspace: `${prefix}-ws`, home: `${prefix}-home`, state: `${prefix}-state` };
  const sizes = { workspace: "8Gi", home: "4Gi", state: "2Gi" };
  for (const [role, name] of Object.entries(names)) {
    if (!(await api.getVolume(name))) await api.createDataDisk(name, sizes[role], labels);
    created.disks.add(name);
  }
  return names;
}

function sandboxBody(imageId, options) {
  const port = { port: 7781, name: "sandboxd", protocol: "Http", auth: { anonymous: true } };
  if (env.CLIENT_CIDR) port.ipAccessControl = { defaultAction: "Deny", rules: [{ name: "client", action: "Allow", priority: 100, sourceCidrs: [env.CLIENT_CIDR] }] };
  return {
    sourcesRef: { diskImage: { id: imageId } },
    resources: { cpu: "1", memory: "2048Mi", disk: options.disks ? "6144Mi" : "20480Mi" },
    labels: { ...labels, "mc-sandbox": options.name },
    environment: { SANDBOX_ID: options.name, SANDBOXD_KEY: options.key, SANDBOXD_RUNTIME_TOKEN: randomBytes(16).toString("hex") },
    ...(options.disks
      ? { volumes: [
          { volumeName: options.disks.workspace, mountpoint: "/workspace" },
          { volumeName: options.disks.home, mountpoint: "/home/agent" },
          { volumeName: options.disks.state, mountpoint: "/var/lib/managed-copilot" },
        ] }
      : {}),
    ports: [port],
    lifecycle: { autoSuspendPolicy: { enabled: false }, autoDeletePolicy: { enabled: false } },
    egressPolicy: options.egress ?? { http: { defaultAction: "Deny", rules: [] } },
    ...(env.VNET_CONNECTION ? { customerVnetConnectionName: env.VNET_CONNECTION } : {}),
  };
}

async function runningSandbox(imageId, options) {
  const sandbox = await api.createSandbox(sandboxBody(imageId, options));
  created.sandboxes.add(sandbox.id);
  return waitFor(`sandbox ${options.name}`, () => api.getSandbox(sandbox.id), (value) => ["running", "failed", "stopfailed"].includes(value?.state?.toLowerCase() ?? ""));
}

async function removeSandbox(id) {
  await api.deleteSandbox(id);
  await waitFor("sandbox deletion", () => api.getSandbox(id), (value) => value === undefined, 5 * 60_000);
  created.sandboxes.delete(id);
}

const portUrl = (sandbox) => sandbox.ports?.find((port) => port.port === 7781)?.url?.replace(/\/+$/, "");

function upgrade(url, key) {
  return new Promise((resolve) => {
    const request = httpsRequest(url, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), authorization: `Bearer ${key}` }, timeout: 20_000 });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, upgraded: true });
    });
    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, upgraded: false, body: body.slice(0, 300), server: response.headers.server }));
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => resolve({ error: error.message }));
    request.end();
  });
}

const shell = async (id, command) => {
  const result = await api.executeShellCommand(id, command);
  return { exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 4000), stderr: result.stderr.trim().slice(0, 1000) };
};

const curl = (target, extra = "") => `curl -sS -m 12 -o /dev/null -w 'http=%{http_code} ip=%{remote_ip}' ${extra} ${target} 2>&1; echo " exit=$?"`;

async function main() {
  let image;
  let sandbox;
  const key = randomBytes(24).toString("hex");
  const disks = await ensureDisks(`qualify-${randomBytes(3).toString("hex")}`).catch((error) => {
    record("data-disks", "failed", { error: error.message, status: error.status });
    return undefined;
  });
  if (steps.has("api")) await attempt("data-plane", async () => ({ sandboxes: (await api.listSandboxes(labels)).length, apiVersion: env.AZ_SANDBOX_API_VERSION ?? "2026-02-01-preview" }));
  if (disks) record("data-disks", "passed", { disks });

  image = await diskImage().catch((error) => record("disk-image", "failed", { error: error.message, status: error.status }) && undefined);
  if (image) record("disk-image", image.status?.state?.toLowerCase() === "failed" ? "failed" : "passed", { id: image.id, state: image.status?.state, error: image.status?.errorMessage });
  if (!image || image.status?.state?.toLowerCase() === "failed") return;

  const create = await attempt("sandbox-create", async () => {
    sandbox = await runningSandbox(image.id, { name: "sbx_qualify_main", key, disks });
    return { outcome: sandbox.state?.toLowerCase() === "running" ? "passed" : "failed", id: sandbox.id, state: sandbox.state, url: portUrl(sandbox) };
  });
  if (create.outcome !== "passed") return;

  if (steps.has("sandboxd")) {
    await attempt("sandboxd-https", async () => {
      const health = await waitFor("sandboxd health", () => fetch(`${portUrl(sandbox)}/v1/health`, { headers: { authorization: `Bearer ${key}` } }).then(async (response) => ({ status: response.status, body: (await response.text()).slice(0, 300) })).catch((error) => ({ error: error.message })), (value) => value.status === 200, 3 * 60_000);
      const anonymous = await fetch(`${portUrl(sandbox)}/v1/health`).then((response) => response.status);
      return { health, withoutKey: anonymous };
    });
    await attempt("sandboxd-websocket", async () => {
      const result = await upgrade(`${portUrl(sandbox)}/v1/runtime`, key);
      return { outcome: result.upgraded || (result.status && result.status !== 403 && result.server !== undefined) ? "observed" : "failed", ...result };
    });
  }

  if (steps.has("inside")) {
    await attempt("inside-identity", () => shell(sandbox.id, "id; echo; tr '\\0' ' ' </proc/1/cmdline; echo; grep -E '^Cap(Prm|Eff|Bnd)' /proc/1/status; ps -eo user:12,pid,args --sort=pid | head -15"));
    await attempt("inside-disks", () => shell(sandbox.id, "for p in /workspace /home/agent /var/lib/managed-copilot; do stat -c '%n %U:%G %a' $p; done; ls -la /workspace /home/agent | head -20; mount | grep -E ' (/workspace|/home/agent|/var/lib/managed-copilot) '; df -h /workspace | tail -1"));
    await attempt("inside-network", () => shell(sandbox.id, "hostname -I 2>/dev/null || ip -4 addr; ip route 2>/dev/null; cat /etc/resolv.conf"));
  }

  if (steps.has("egress")) {
    const proxyIp = env.PROXY_IP;
    const proxy = proxyIp ? `http://sbx_qualify_main:not-a-secret@${proxyIp}:3128` : undefined;
    const run = (policy, commands) => async () => {
      if (policy) await api.setEgressPolicy(sandbox.id, policy);
      await sleep(3_000);
      return shell(sandbox.id, commands.join("; "));
    };
    await attempt("egress-deny-all", run(undefined, [
      curl("https://example.com"),
      curl("http://example.com"),
      curl("'http://169.254.169.254/metadata/instance?api-version=2021-02-01'", "-H Metadata:true"),
      "getent hosts example.com; echo dns=$?",
    ]));
    await attempt("egress-allow-host", run({ http: { defaultAction: "Deny", rules: [{ name: "example", match: { host: "example.com" }, action: { type: "Allow" } }] } }, [
      curl("https://example.com"),
      curl("https://www.github.com"),
      "curl -sv -m 12 https://example.com -o /dev/null 2>&1 | grep -iE 'issuer|subject:|SSL certificate|error' | head -5",
    ]));
    if (proxy) {
      await attempt("egress-proxy-host-vnet", run({ http: { defaultAction: "Deny", rules: [{ name: "proxy", match: { host: proxyIp }, action: { type: "Allow", routingMode: "Vnet" } }] } }, [
        curl("https://example.com", `-x ${proxy}`),
        curl("http://example.com", `-x ${proxy}`),
        curl(`http://${proxyIp}:3128/direct-probe`),
      ]));
      await attempt("egress-proxy-transport", run({ http: { defaultAction: "Deny", rules: [] }, transportRules: { defaultAction: "Deny", rules: [{ name: "proxy", action: "Allow", protocol: "Tcp", destination: `${proxyIp}/32`, port: 3128 }] } }, [
        curl("https://example.com", `-x ${proxy}`),
      ]));
      await attempt("egress-forward-proxy", run({ http: { defaultAction: "Deny", rules: [{ name: "example", match: { host: "example.com" }, action: { type: "Allow", forward: "proxy", forwardProxy: { url: proxy }, routingMode: "Vnet" } }] } }, [
        curl("https://example.com"),
        curl("http://example.com"),
      ]));
      await attempt("egress-inspection-none", run({ trafficInspection: "None", http: { defaultAction: "Deny", rules: [] } }, [
        curl("https://example.com"),
        curl("https://example.com", `-x ${proxy}`),
      ]));
    }
    await api.setEgressPolicy(sandbox.id, { http: { defaultAction: "Deny", rules: [] } }).catch(() => undefined);
  }

  if (steps.has("isolation")) {
    await attempt("isolation-peer-port", async () => {
      const peer = await runningSandbox(image.id, { name: "sbx_qualify_peer", key: randomBytes(24).toString("hex"), egress: { http: { defaultAction: "Allow", rules: [] } } });
      const fromPeer = await shell(peer.id, curl(`${portUrl(sandbox)}/v1/health`));
      const mainAddress = (await shell(sandbox.id, "hostname -I 2>/dev/null | awk '{print $1}'")).stdout;
      const privatePath = mainAddress ? await shell(peer.id, curl(`http://${mainAddress}:7781/v1/health`)) : undefined;
      await removeSandbox(peer.id);
      return { outcome: "observed", fromPeerToPublicPort: fromPeer, mainAddress, fromPeerToPrivateAddress: privatePath };
    });
  }

  if (steps.has("persistence") && disks) {
    await attempt("persistence-across-compute", async () => {
      const marker = `persisted-${Date.now()}`;
      await shell(sandbox.id, `echo ${marker} > /workspace/qualify.txt && chown 10001:10001 /workspace/qualify.txt && echo ${marker} > /home/agent/qualify.txt && sync`);
      const deleteStarted = Date.now();
      await removeSandbox(sandbox.id);
      const deleteTook = elapsed(deleteStarted);
      const recreateStarted = Date.now();
      sandbox = await runningSandbox(image.id, { name: "sbx_qualify_main", key, disks });
      const recreateTook = elapsed(recreateStarted);
      const after = await shell(sandbox.id, "cat /workspace/qualify.txt /home/agent/qualify.txt; stat -c '%U:%G' /workspace/qualify.txt");
      return { outcome: after.stdout.split("\n").filter((line) => line === marker).length === 2 ? "passed" : "failed", deleteTook, recreateTook, after };
    });
  }
}

try {
  await main();
} catch (error) {
  record("run", "failed", { error: error.message, stack: error.stack?.split("\n").slice(0, 3).join(" | ") });
} finally {
  if (env.KEEP !== "1") {
    for (const id of created.sandboxes) await removeSandbox(id).catch((error) => record("cleanup-sandbox", "failed", { id, error: error.message }));
    for (const name of created.disks) {
      await waitFor("disk detach", () => api.getVolume(name), (value) => !value?.isAttached, 5 * 60_000).catch(() => undefined);
      await api.deleteVolume(name).catch((error) => record("cleanup-disk", "failed", { name, error: error.message }));
    }
  }
  process.stdout.write(`${JSON.stringify({ summary: results.map(({ check, outcome }) => `${check}: ${outcome}`) })}\n`);
}
