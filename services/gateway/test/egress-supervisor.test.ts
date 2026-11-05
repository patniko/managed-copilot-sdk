import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { bridgeAddress, EgressSupervisor, type EgressSupervisorOptions } from "../src/modules/network/supervisor.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface DockerCall {
  readonly args: string[];
  readonly url: string | null;
}

/**
 * A fake Docker CLI: the image and networks exist, `network inspect --format` prints `ipam` (the egress network's
 * `Gateway|Subnet` entries), and no container runs yet.
 */
function fakeDocker(ipam = "10.214.5.1|10.214.5.0/24 "): { readonly docker: string; readonly context: string; calls(): DockerCall[] } {
  const dir = mkdtempSync(join(tmpdir(), "mc-egress-supervisor-"));
  dirs.push(dir);
  const context = join(dir, "context");
  mkdirSync(join(context, "dist"), { recursive: true });
  writeFileSync(join(context, "dist", "egress.mjs"), "// egress\n");
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
  const log = join(dir, "calls.jsonl");
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, url: process.env.EGRESS_GATEWAY_URL ?? null }) + "\\n");
const [command, sub] = args;
if (command === "version") console.log("29.0.0");
else if (command === "network" && sub === "inspect" && args.includes("--format")) console.log(${JSON.stringify(ipam)});
else if (command === "inspect") { console.error("Error: No such object"); process.exit(1); }
else if (command === "run") console.log("0123456789ab");
`,
  );
  chmodSync(docker, 0o755);
  return { docker, context, calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as DockerCall) };
}

function supervisor(fake: ReturnType<typeof fakeDocker>, options: Partial<EgressSupervisorOptions> = {}): EgressSupervisor {
  return new EgressSupervisor({
    instance: "mctest",
    context: fake.context,
    gatewayUrl: () => "http://host.docker.internal:7400",
    key: "egress-key",
    settings: { allowedPorts: [443], privateHosts: [], protectedCidrs: [], blockedCidrs: [] },
    log: createLogger("test", "error"),
    docker: fake.docker,
    ...options,
  });
}

function run(calls: DockerCall[]): DockerCall {
  const call = calls.find((candidate) => candidate.args[0] === "run");
  expect(call).toBeDefined();
  return call!;
}

function hostMapping(call: DockerCall): string | undefined {
  return call.args[call.args.indexOf("--add-host") + 1];
}

// The fake Docker CLI is a script with a shebang, which Windows cannot execute directly.
describe.skipIf(process.platform === "win32")("EgressSupervisor gateway address", () => {
  it("serves the egress proxy on the egress network's bridge when that address is this machine's (native Docker Engine)", async () => {
    const fake = fakeDocker();
    const offered: string[] = [];
    await supervisor(fake, {
      listenOnBridge: async (address) => {
        offered.push(address);
        return 7400;
      },
    }).ensure();
    expect(offered).toEqual(["10.214.5.1"]);
    const call = run(fake.calls());
    expect(hostMapping(call)).toBe("host.docker.internal:10.214.5.1");
    expect(call.url).toBe("http://host.docker.internal:7400");
  });

  it("finds the bridge from the subnet when Docker Engine 28 or earlier reports no gateway", async () => {
    const fake = fakeDocker("|10.214.77.0/24 ");
    const offered: string[] = [];
    await supervisor(fake, {
      listenOnBridge: async (address) => {
        offered.push(address);
        return 7400;
      },
    }).ensure();
    expect(offered).toEqual(["10.214.77.1"]);
    expect(hostMapping(run(fake.calls()))).toBe("host.docker.internal:10.214.77.1");
  });

  it("keeps host-gateway when the bridge address isn't this machine's (Docker Desktop and other VM engines)", async () => {
    const fake = fakeDocker();
    await supervisor(fake, { gatewayUrl: () => "http://host.docker.internal:7401", listenOnBridge: async () => undefined }).ensure();
    const call = run(fake.calls());
    expect(hostMapping(call)).toBe("host.docker.internal:host-gateway");
    expect(call.url).toBe("http://host.docker.internal:7401");
  });

  it("keeps host-gateway without looking up the bridge when the gateway is reachable beyond loopback", async () => {
    const fake = fakeDocker();
    await supervisor(fake).ensure();
    const calls = fake.calls();
    expect(calls.some((call) => call.args[0] === "network" && call.args.includes("--format"))).toBe(false);
    expect(hostMapping(run(calls))).toBe("host.docker.internal:host-gateway");
  });

  it("labels the container with a configuration hash that changes with the host mapping", async () => {
    const label = (call: DockerCall) => call.args.find((arg) => arg.startsWith("managed-copilot.egress-config="));
    const bridged = fakeDocker();
    await supervisor(bridged, { listenOnBridge: async () => 7400 }).ensure();
    const direct = fakeDocker();
    await supervisor(direct, { listenOnBridge: async () => undefined }).ensure();
    expect(label(run(bridged.calls()))).toBeDefined();
    expect(label(run(bridged.calls()))).not.toBe(label(run(direct.calls())));
  });
});

describe("bridgeAddress", () => {
  it("prefers the reported gateway, else the subnet's first host address", () => {
    expect(bridgeAddress("10.214.5.1", "10.214.5.0/24")).toBe("10.214.5.1");
    expect(bridgeAddress("", "10.214.77.0/24")).toBe("10.214.77.1");
    expect(bridgeAddress("", "172.18.0.0/16")).toBe("172.18.0.1");
    expect(bridgeAddress("<no value>", "10.214.77.128/25")).toBe("10.214.77.129");
    expect(bridgeAddress("", "10.214.77.5/24")).toBe("10.214.77.1");
  });

  it("finds nothing in IPv6 or malformed entries", () => {
    for (const [gateway, subnet] of [["", "fd00::/64"], ["fd00::1", "fd00::/64"], ["", ""], ["", "10.214.77.0"], ["", "10.214.77.0/31"], ["", "10.214.300.0/24"]] as const) {
      expect(bridgeAddress(gateway, subnet), `${gateway}|${subnet}`).toBeUndefined();
    }
  });
});
