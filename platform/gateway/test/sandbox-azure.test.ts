// Azure Container Apps Sandboxes provider against a fake data plane that mirrors the published wire format
// (azure-containerapps-sandbox 0.1.0b4). The live qualification runs separately against Azure.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManagedCopilotError, type EnvironmentConfig } from "@managed-copilot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { SandboxApi } from "../src/modules/sandbox/providers/azure/api.js";
import { loadAzureConfig } from "../src/modules/sandbox/providers/azure/config.js";
import { AzureSandboxProvider, LABELS, type AzureProviderOverrides } from "../src/modules/sandbox/providers/azure/provider.js";
import type { SandboxSpec } from "../src/modules/sandbox/providers/types.js";

const GROUP = "/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/grp-1";

interface FakeSandbox {
  id: string;
  state: string;
  labels: Record<string, string>;
  body: Record<string, unknown>;
  ports: { port: number; url: string }[];
  deleteLag: number;
}

class FakeDataPlane {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly volumes = new Map<string, { volumeName: string; type: string; size: string; labels: Record<string, string>; isAttached: boolean }>();
  readonly images = new Map<string, { id: string; labels: Record<string, string>; image: { base: string }; status: { state: string }; reads: number }>();
  readonly files: { sandbox: string; path: string; mode: string; content: string }[] = [];
  readonly requests: string[] = [];
  denyAll = false;
  failImages = false;
  /** Polls a deleted sandbox stays in Deleting (holding its disks) before it disappears. */
  deleteLag = 0;
  /** Creates (sandboxes, disk images) whose responses are lost. */
  dropSandboxCreates = 0;
  dropImageCreates = 0;
  /** When a dropped sandbox create takes effect: at once, after this many sandbox listings, or never. */
  dropCommitAfterLists: number | "never" = 0;
  readonly #pending: { sandbox: FakeSandbox; lists: number }[] = [];
  #next = 0;
  #server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  #attach(sandbox: FakeSandbox, attached: boolean): void {
    for (const mount of (sandbox.body.volumes as { volumeName: string }[] | undefined) ?? []) {
      const volume = this.volumes.get(mount.volumeName);
      if (volume) volume.isAttached = attached;
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    this.requests.push(`${req.method} ${url.pathname.replace(GROUP, "")}`);
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "Unauthorized", message: "no token" } });
    if (this.denyAll) return send(403, { error: { code: "AuthorizationFailed", message: "The client does not have authorization" } });
    if (url.searchParams.get("api-version") !== "2026-02-01-preview") return send(400, { error: { code: "BadApiVersion", message: "api-version" } });
    if (!url.pathname.startsWith(GROUP)) return send(404, { error: { code: "NotFound", message: "group" } });
    const path = url.pathname.slice(GROUP.length).split("/").filter(Boolean);

    if (path[0] === "sandboxes") {
      if (path.length === 1 && req.method === "GET") {
        for (const pending of [...this.#pending]) {
          if (--pending.lists > 0) continue;
          this.#pending.splice(this.#pending.indexOf(pending), 1);
          this.sandboxes.set(pending.sandbox.id, pending.sandbox);
          this.#attach(pending.sandbox, true);
        }
        const wanted = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean).map((pair) => pair.split("="));
        const value = [...this.sandboxes.values()].filter((sandbox) => wanted.every(([key, value]) => sandbox.labels[key!] === value)).map((sandbox) => this.#view(sandbox));
        return send(200, { value });
      }
      if (path.length === 1 && req.method === "PUT") {
        const body = JSON.parse(raw.toString()) as Record<string, unknown>;
        // A data disk attaches to one sandbox at a time.
        if (((body.volumes as { volumeName: string }[] | undefined) ?? []).some((mount) => this.volumes.get(mount.volumeName)?.isAttached)) {
          return send(409, { error: { code: "VolumeAttached", message: "A volume is attached to another sandbox" } });
        }
        const id = `remote-${++this.#next}`;
        const sandbox: FakeSandbox = { id, state: "Creating", labels: body.labels as Record<string, string>, body, ports: [{ port: 7781, url: `https://${id}-7781.westus2.adcproxy.io/` }], deleteLag: 0 };
        if (this.dropSandboxCreates > 0) {
          this.dropSandboxCreates--;
          if (this.dropCommitAfterLists === 0) {
            this.sandboxes.set(id, sandbox);
            this.#attach(sandbox, true);
          } else if (this.dropCommitAfterLists !== "never") {
            this.#pending.push({ sandbox, lists: this.dropCommitAfterLists });
          }
          req.socket.destroy();
          return;
        }
        this.sandboxes.set(id, sandbox);
        this.#attach(sandbox, true);
        return send(201, this.#view(sandbox));
      }
      const sandbox = this.sandboxes.get(path[1] ?? "");
      if (!sandbox) return send(404, { error: { code: "NotFound", message: "sandbox" } });
      if (path.length === 2 && req.method === "GET") {
        const view = this.#view(sandbox);
        if (sandbox.state === "Creating") sandbox.state = "Running";
        if (sandbox.state === "Deleting" && sandbox.deleteLag-- <= 0) {
          this.sandboxes.delete(sandbox.id);
          this.#attach(sandbox, false);
        }
        return send(200, view);
      }
      if (path.length === 2 && req.method === "DELETE") {
        if (sandbox.state !== "Deleting") sandbox.deleteLag = this.deleteLag;
        sandbox.state = "Deleting";
        return send(202);
      }
      if (path[2] === "files" && req.method === "PUT") {
        this.files.push({ sandbox: sandbox.id, path: url.searchParams.get("path")!, mode: url.searchParams.get("mode")!, content: raw.toString() });
        return send(200, { success: true });
      }
    }

    if (path[0] === "volumes") {
      if (path.length === 1 && req.method === "GET") return send(200, { value: [...this.volumes.values()] });
      const name = path[1]!;
      if (req.method === "GET") return this.volumes.has(name) ? send(200, this.volumes.get(name)) : send(404, { error: { code: "NotFound", message: "volume" } });
      if (req.method === "PUT") {
        const body = JSON.parse(raw.toString()) as { type: string; size: string; labels: Record<string, string> };
        this.volumes.set(name, { volumeName: name, ...body, isAttached: false });
        return send(201, this.volumes.get(name));
      }
      if (req.method === "DELETE") {
        if (this.volumes.get(name)?.isAttached) return send(409, { error: { code: "VolumeAttached", message: "attached" } });
        this.volumes.delete(name);
        return send(204);
      }
    }

    if (path[0] === "diskimages") {
      if (path.length === 1 && req.method === "GET") return send(200, { value: [...this.images.values()] });
      if (path.length === 1 && req.method === "PUT") {
        const body = JSON.parse(raw.toString()) as { image: { base: string }; labels: Record<string, string> };
        const id = `img-${++this.#next}`;
        this.images.set(id, { id, labels: body.labels, image: body.image, status: { state: "Building" }, reads: 0 });
        if (this.dropImageCreates > 0) {
          this.dropImageCreates--;
          req.socket.destroy();
          return;
        }
        return send(201, this.images.get(id));
      }
      const image = this.images.get(path[1] ?? "");
      if (!image) return send(404, { error: { code: "NotFound", message: "image" } });
      if (++image.reads >= 1 && image.status.state === "Building") image.status = { state: this.failImages ? "Failed" : "Ready" };
      return send(200, image);
    }
    return send(404, { error: { code: "NotFound", message: url.pathname } });
  }

  /** Lets every dropped create that has not taken effect yet take effect now. */
  commitPending(): void {
    for (const pending of this.#pending.splice(0)) {
      this.sandboxes.set(pending.sandbox.id, pending.sandbox);
      this.#attach(pending.sandbox, true);
    }
  }

  #view(sandbox: FakeSandbox): Record<string, unknown> {
    return { id: sandbox.id, state: sandbox.state, labels: sandbox.labels, ports: sandbox.ports };
  }
}

const tokens = { token: async () => "test-token" };
let plane: FakeDataPlane;
let dataDir: string;

beforeEach(async () => {
  plane = new FakeDataPlane();
  await plane.start();
  dataDir = mkdtempSync(join(tmpdir(), "mc-azure-provider-"));
});

afterEach(async () => {
  await plane.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    MANAGED_COPILOT_AZURE_SUBSCRIPTION_ID: "sub-1",
    MANAGED_COPILOT_AZURE_RESOURCE_GROUP: "rg-1",
    MANAGED_COPILOT_AZURE_SANDBOX_GROUP: "grp-1",
    MANAGED_COPILOT_AZURE_REGION: "westus2",
    MANAGED_COPILOT_AZURE_SANDBOX_ENDPOINT: plane.url,
    IDENTITY_ENDPOINT: "http://127.0.0.1:1/msi",
    IDENTITY_HEADER: "header",
    MANAGED_COPILOT_AZURE_SANDBOX_IMAGES: JSON.stringify({ "*": "acr.example/managed-copilot-sandbox:abc", coder: "acr.example/coder:def" }),
    MANAGED_COPILOT_AZURE_REGISTRY_IDENTITY: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull",
    MANAGED_COPILOT_AZURE_VNET_CONNECTION: "default",
    MANAGED_COPILOT_AZURE_EGRESS_PROXY: "10.42.4.4:3128",
    MANAGED_COPILOT_AZURE_INGRESS_CIDRS: "20.1.2.3/32",
    ...extra,
  };
}

function provider(variables: Record<string, string> = env(), overrides: AzureProviderOverrides = {}): AzureSandboxProvider {
  const loaded = loadAzureConfig(variables);
  const api = loaded.config
    ? new SandboxApi({ endpoint: loaded.config.endpoint, subscriptionId: "sub-1", resourceGroup: "rg-1", sandboxGroup: "grp-1", apiVersion: loaded.config.apiVersion, tokens, sleep: async () => {} })
    : undefined;
  return new AzureSandboxProvider(
    { env: variables, log: createLogger("test", "error"), instance: "mctest", platformKey: "pk", appHostDir: dataDir, dataDir },
    loaded,
    api,
    { sleep: async () => {}, pollMs: 0, ...overrides },
  );
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: "sbx_0123456789abcdef01234567",
    sessionId: "session-1",
    ownerId: 42,
    environment: "coder",
    size: "medium",
    imageId: "img-1",
    env: { SANDBOX_ID: "sbx_0123456789abcdef01234567", SANDBOXD_KEY: "key", SANDBOXD_RUNTIME_TOKEN: "token" },
    ...overrides,
  };
}

describe("Azure sandbox provider", () => {
  it("names every missing setting instead of failing the gateway at start", async () => {
    const broken = provider({ MANAGED_COPILOT_AZURE_REGION: "west us 2!" });
    const error = await broken.ready().catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "capability_unavailable")).toBe(true);
    expect((error as Error).message).toMatch(/MANAGED_COPILOT_AZURE_SUBSCRIPTION_ID is not set/);
    expect((error as Error).message).toMatch(/MANAGED_COPILOT_AZURE_SANDBOX_IMAGES is not set/);
    expect((error as Error).message).toMatch(/No managed identity is available/);
  });

  it("explains a missing data-plane role", async () => {
    plane.denyAll = true;
    const error = await provider().ready().catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "capability_unavailable")).toBe(true);
    expect((error as Error).message).toMatch(/Container Apps SandboxGroup Data Owner/);
  });

  it("resolves registry-relative images against MANAGED_COPILOT_AZURE_REGISTRY", () => {
    const images = JSON.stringify({ "*": "copilot-sandbox:abc", coder: "other.example/coder:def", local: "localhost/x:1" });
    expect(loadAzureConfig(env({ MANAGED_COPILOT_AZURE_SANDBOX_IMAGES: images, MANAGED_COPILOT_AZURE_REGISTRY: "myacr.azurecr.io" })).config?.images).toEqual({
      "*": "myacr.azurecr.io/copilot-sandbox:abc",
      coder: "other.example/coder:def",
      local: "localhost/x:1",
    });
    const missing = loadAzureConfig(env({ MANAGED_COPILOT_AZURE_SANDBOX_IMAGES: images }));
    expect(missing.config).toBeUndefined();
    expect(missing.problems.join(" ")).toMatch(/\["\*"\] names no registry and MANAGED_COPILOT_AZURE_REGISTRY is not set/);
  });

  it("trusts a successful readiness check only briefly, and re-checks right after a failure", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const subject = provider();
      const lists = () => plane.requests.filter((request) => request === "GET /sandboxes").length;
      await subject.ready();
      await subject.ready();
      expect(lists()).toBe(1);
      now += 31_000;
      plane.denyAll = true;
      await expect(subject.ready()).rejects.toThrow(/SandboxGroup Data Owner/);
      plane.denyAll = false;
      await subject.ready();
      expect(lists()).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("converts each deployed image into a disk image once and reuses it", async () => {
    const first = provider();
    await first.ready();
    const image = await first.ensureImage("coder", {} as EnvironmentConfig);
    expect(image.ref).toBe("acr.example/coder:def");
    expect(plane.images.get(image.id)?.image.base).toBe("acr.example/coder:def");
    expect(await first.ensureImage("coder", {} as EnvironmentConfig)).toEqual(image);
    expect(await provider().ensureImage("coder", {} as EnvironmentConfig)).toEqual(image); // found by label after a restart
    expect((await first.ensureImage("chat-only", {} as EnvironmentConfig)).ref).toBe("acr.example/managed-copilot-sandbox:abc");
    expect(plane.images.size).toBe(2);
    expect(await first.hasImage(image.id)).toBe(true);
    expect(await first.hasImage("img-missing")).toBe(false);
  });

  it("fails clearly when a disk image cannot be built", async () => {
    plane.failImages = true;
    const error = await provider().ensureImage("coder", {} as EnvironmentConfig).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "capability_unavailable")).toBe(true);
    expect((error as Error).message).toMatch(/could not be prepared on Azure/);
  });

  it("creates data disks and a sandbox that only reaches the egress proxy, then uploads customizations", async () => {
    const customizations = join(dataDir, "customizations", "abc");
    mkdirSync(join(customizations, "agents"), { recursive: true });
    writeFileSync(join(customizations, "agents", "builder.agent.md"), "# builder");
    const subject = provider();
    const progress: string[] = [];
    await subject.create(spec({ customizations }), { onProgress: (message) => progress.push(message) });

    expect([...plane.volumes.keys()].sort()).toEqual(["mctest-sbx-0123456789abcdef01234567-home", "mctest-sbx-0123456789abcdef01234567-state", "mctest-sbx-0123456789abcdef01234567-ws"]);
    expect(plane.volumes.get("mctest-sbx-0123456789abcdef01234567-ws")).toMatchObject({ type: "DataDisk", size: "32Gi", labels: { [LABELS.instance]: "mctest", [LABELS.role]: "ws" } });
    const created = [...plane.sandboxes.values()][0]!;
    expect(created.body).toMatchObject({
      sourcesRef: { diskImage: { id: "img-1" } },
      resources: { cpu: "2", memory: "4096Mi" },
      labels: { [LABELS.instance]: "mctest", [LABELS.sandbox]: "sbx_0123456789abcdef01234567", [LABELS.session]: "session-1", [LABELS.owner]: "42", [LABELS.environment]: "coder" },
      environment: { SANDBOX_ID: "sbx_0123456789abcdef01234567", SANDBOXD_KEY: "key", SANDBOXD_RUNTIME_TOKEN: "token" },
      volumes: [
        { volumeName: "mctest-sbx-0123456789abcdef01234567-ws", mountpoint: "/workspace" },
        { volumeName: "mctest-sbx-0123456789abcdef01234567-home", mountpoint: "/home/agent" },
        { volumeName: "mctest-sbx-0123456789abcdef01234567-state", mountpoint: "/var/lib/managed-copilot" },
      ],
      ports: [{ port: 7781, auth: { anonymous: true }, ipAccessControl: { defaultAction: "Deny", rules: [{ action: "Allow", sourceCidrs: ["20.1.2.3/32"] }] } }],
      lifecycle: { autoSuspendPolicy: { enabled: false }, autoDeletePolicy: { enabled: false } },
      egressPolicy: { http: { defaultAction: "Deny", rules: [{ match: { host: "10.42.4.4" }, action: { type: "Allow", routingMode: "Vnet" } }] } },
      customerVnetConnectionName: "default",
    });
    expect(plane.files).toEqual([{ sandbox: created.id, path: "/opt/managed-copilot/customizations/agents/builder.agent.md", mode: "0644", content: "# builder" }]);
    expect(progress).toContain("Allocating an Azure sandbox…");
    expect(await subject.isRunning("sbx_0123456789abcdef01234567")).toBe(true);
    expect(await subject.endpoint("sbx_0123456789abcdef01234567")).toEqual({ url: `https://${created.id}-7781.westus2.adcproxy.io`, headers: {} });
    expect(subject.egressProxy()).toEqual({ host: "10.42.4.4", port: 3128 });
    expect(subject.capabilities).toMatchObject({ warm: false, addressPinning: false });

    await subject.create(spec({ customizations })); // idempotent: the same sandbox and disks
    expect(plane.sandboxes.size).toBe(1);
    expect(plane.volumes.size).toBe(3);
  });

  it("stops by deleting compute, keeps the disks, and recreates over them; reports gone without disks", async () => {
    const subject = provider();
    await subject.create(spec());
    await subject.stop("sbx_0123456789abcdef01234567");
    expect(plane.sandboxes.size).toBe(0);
    expect(plane.volumes.size).toBe(3);
    expect(await subject.isRunning("sbx_0123456789abcdef01234567")).toBe(false);
    expect(await subject.start("sbx_0123456789abcdef01234567")).toBe("recreate");

    await subject.create(spec());
    expect(plane.sandboxes.size).toBe(1);
    expect(await subject.start("sbx_0123456789abcdef01234567")).toBe("started");

    await subject.remove("sbx_0123456789abcdef01234567");
    await subject.remove("sbx_0123456789abcdef01234567"); // safe to repeat
    expect(plane.sandboxes.size).toBe(0);
    expect(plane.volumes.size).toBe(0);
    expect(await subject.start("sbx_0123456789abcdef01234567")).toBe("gone");
  });

  it("replaces compute the platform stopped instead of trusting a snapshot", async () => {
    const subject = provider();
    await subject.create(spec());
    [...plane.sandboxes.values()][0]!.state = "Stopped";
    expect(await subject.start("sbx_0123456789abcdef01234567")).toBe("recreate");
    expect(plane.sandboxes.size).toBe(0);
  });

  it("waits for compute still being deleted (it holds the disks) before reporting stopped or recreating", async () => {
    plane.deleteLag = 3;
    const first = provider();
    await first.create(spec());
    const remoteId = [...plane.sandboxes.keys()][0]!;
    // A delete that was interrupted (gateway restart): the next gateway finds the sandbox still Deleting.
    plane.sandboxes.get(remoteId)!.state = "Deleting";
    plane.sandboxes.get(remoteId)!.deleteLag = 3;
    const restarted = provider();
    expect(await restarted.start("sbx_0123456789abcdef01234567")).toBe("recreate");
    expect(plane.sandboxes.size).toBe(0);
    await expect(restarted.endpoint("sbx_0123456789abcdef01234567")).rejects.toThrow(/not running/);
    await restarted.create(spec());
    expect(plane.sandboxes.size).toBe(1);

    const again = [...plane.sandboxes.values()][0]!;
    again.state = "Deleting";
    again.deleteLag = 3;
    await provider().stop("sbx_0123456789abcdef01234567");
    expect(plane.sandboxes.size).toBe(0);
    expect([...plane.volumes.values()].every((volume) => !volume.isAttached)).toBe(true);
  });

  it("replaces leftover compute when creating, so a stopped or failed sandbox never blocks the disks", async () => {
    const subject = provider();
    await subject.create(spec());
    [...plane.sandboxes.values()][0]!.state = "Failed";
    await subject.create(spec());
    expect(plane.sandboxes.size).toBe(1);
    expect([...plane.sandboxes.values()][0]!.state).toBe("Running");
  });

  it("adopts a sandbox or disk image Azure created without answering, instead of creating a second", async () => {
    plane.dropImageCreates = 1;
    plane.dropSandboxCreates = 1;
    const subject = provider();
    const image = await subject.ensureImage("coder", {} as EnvironmentConfig);
    expect(plane.images.size).toBe(1);
    expect(image.id).toBe([...plane.images.keys()][0]);
    await subject.create(spec({ imageId: image.id }));
    expect(plane.sandboxes.size).toBe(1);
    expect(await subject.isRunning("sbx_0123456789abcdef01234567")).toBe(true);
  });

  it("keeps looking for a sandbox Azure creates only after the lookup started, without creating it again", async () => {
    plane.dropSandboxCreates = 1;
    plane.dropCommitAfterLists = 3;
    const subject = provider();
    await subject.create(spec());
    expect(plane.requests.filter((request) => request === "PUT /sandboxes")).toHaveLength(1);
    expect(plane.sandboxes.size).toBe(1);
  });

  it("reports an unconfirmed create instead of submitting it twice", async () => {
    plane.dropSandboxCreates = 1;
    plane.dropCommitAfterLists = "never";
    const subject = provider(env(), { timeouts: { reconcileMs: 30 } });
    const error = await subject.create(spec()).catch((caught: unknown) => caught);
    expect(isManagedCopilotError(error, "capability_unavailable")).toBe(true);
    expect((error as Error).message).toMatch(/did not confirm whether the sandbox was created/);
    expect(plane.requests.filter((request) => request === "PUT /sandboxes")).toHaveLength(1);
  });

  it("remembers an unconfirmed create across calls and restarts, and adopts it when it appears", async () => {
    plane.dropSandboxCreates = 1;
    plane.dropCommitAfterLists = 1_000_000; // takes effect only when the test says so
    const first = provider(env(), { timeouts: { reconcileMs: 20 } });
    await expect(first.create(spec())).rejects.toThrow(/did not confirm whether the sandbox was created/);
    const restarted = provider(env(), { timeouts: { reconcileMs: 20 } });
    await expect(restarted.create(spec())).rejects.toThrow(/earlier attempt to create the sandbox has not been confirmed/);
    expect(plane.requests.filter((request) => request === "PUT /sandboxes")).toHaveLength(1);

    plane.commitPending();
    await restarted.create(spec());
    expect(plane.sandboxes.size).toBe(1);
    expect(plane.requests.filter((request) => request === "PUT /sandboxes")).toHaveLength(1);
    expect(existsSync(join(dataDir, "sandbox-azure", "unconfirmed-creates.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "sandbox-azure", "unconfirmed-creates.json"), "utf8"))).toEqual({});
  });

  it("creates again only once an unconfirmed create is past its horizon", async () => {
    plane.dropSandboxCreates = 1;
    plane.dropCommitAfterLists = "never";
    const subject = provider(env(), { timeouts: { reconcileMs: 20, unconfirmedMs: 0 } });
    await expect(subject.create(spec())).rejects.toThrow(/did not confirm/);
    await subject.create(spec());
    expect(plane.requests.filter((request) => request === "PUT /sandboxes")).toHaveLength(2);
    expect(plane.sandboxes.size).toBe(1);
  });

  it("refuses an environment with system packages but no image of its own instead of using the base image", async () => {
    const subject = provider();
    await expect(subject.ensureImage("tools", { type: "isolated", packages: { system: ["ffmpeg"] } } as EnvironmentConfig)).rejects.toThrow(
      /declares system packages, but no image with them was deployed/,
    );
    expect((await subject.ensureImage("coder", { type: "isolated", packages: { system: ["ffmpeg"] } } as EnvironmentConfig)).ref).toBe("acr.example/coder:def");
  });

  it("stops every sandbox that carries the sandbox's labels", async () => {
    const subject = provider();
    await subject.create(spec());
    const original = [...plane.sandboxes.values()][0]!;
    plane.sandboxes.set("remote-duplicate", { ...original, id: "remote-duplicate", body: { ...original.body, volumes: [] }, deleteLag: 0 });
    await subject.stop("sbx_0123456789abcdef01234567");
    expect(plane.sandboxes.size).toBe(0);
  });

  it("lists this instance's sandboxes and disks for the orphan sweep", async () => {
    const subject = provider();
    await subject.create(spec());
    await subject.create(spec({ sandboxId: "sbx_ffffffffffffffffffffffff", sessionId: "session-2" }));
    await subject.stop("sbx_ffffffffffffffffffffffff");
    plane.volumes.set("other-instance-disk", { volumeName: "other-instance-disk", type: "DataDisk", size: "1Gi", labels: { [LABELS.instance]: "someone-else", [LABELS.sandbox]: "sbx_000000000000000000000000" }, isAttached: false });
    expect([...(await subject.inventory())].sort()).toEqual(["sbx_0123456789abcdef01234567", "sbx_ffffffffffffffffffffffff"]);
  });
});
