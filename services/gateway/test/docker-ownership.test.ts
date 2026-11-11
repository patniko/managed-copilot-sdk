import { describe, expect, it } from "vitest";
import { classifyOwnership, dockerOwnerHost, OWNERSHIP_LABELS, ownershipLabels } from "../src/docker-ownership.js";
import { createLogger } from "../src/log.js";
import { sweepAbandonedInstances } from "../src/modules/sandbox/providers/docker/abandoned.js";

const HOST = "win32/devbox";
const NOW = Date.UTC(2026, 10, 10);
const existing = new Set(["C:\\repos\\live\\.managed-copilot\\data"]);
const context = { host: HOST, now: NOW, exists: (path: string) => existing.has(path) };

function owned(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { [OWNERSHIP_LABELS.dataDir]: dataDir, [OWNERSHIP_LABELS.host]: HOST, ...extra };
}

describe("ownershipLabels", () => {
  it("records the data directory and host, and an expiry only with a TTL", () => {
    expect(ownershipLabels("/data", {}, NOW)).toEqual({ [OWNERSHIP_LABELS.dataDir]: "/data", [OWNERSHIP_LABELS.host]: dockerOwnerHost({}) });
    expect(ownershipLabels("/data", { MANAGED_COPILOT_INSTANCE_TTL_SECONDS: "60" }, NOW)[OWNERSHIP_LABELS.expires]).toBe(String(NOW / 1000 + 60));
    expect(ownershipLabels("/data", { MANAGED_COPILOT_INSTANCE_TTL_SECONDS: "nope" }, NOW)[OWNERSHIP_LABELS.expires]).toBeUndefined();
  });

  it("tells WSL distributions apart, since they share the Windows host name", () => {
    expect(dockerOwnerHost({ WSL_DISTRO_NAME: "Ubuntu" })).not.toBe(dockerOwnerHost({ WSL_DISTRO_NAME: "Debian" }));
  });
});

describe("classifyOwnership", () => {
  it("is live while the data directory exists on this host", () => {
    expect(classifyOwnership(owned("C:\\repos\\live\\.managed-copilot\\data"), context)).toBe("live");
  });

  it("is abandoned once the data directory is gone", () => {
    expect(classifyOwnership(owned("C:\\repos\\deleted\\.managed-copilot\\data"), context)).toBe("abandoned");
  });

  it("is abandoned once expired, even while the data directory exists", () => {
    expect(classifyOwnership(owned("C:\\repos\\live\\.managed-copilot\\data", { [OWNERSHIP_LABELS.expires]: String(NOW / 1000 - 1) }), context)).toBe("abandoned");
    expect(classifyOwnership(owned("C:\\repos\\live\\.managed-copilot\\data", { [OWNERSHIP_LABELS.expires]: String(NOW / 1000 + 60) }), context)).toBe("live");
  });

  it("cannot judge another host's paths, or resources from before ownership labels", () => {
    expect(classifyOwnership({ ...owned("/home/me/gone"), [OWNERSHIP_LABELS.host]: "linux/devbox/Ubuntu" }, context)).toBe("foreign");
    expect(classifyOwnership({ "managed-copilot.instance": "mc-old" }, context)).toBe("unlabeled");
    expect(classifyOwnership(null, context)).toBe("unlabeled");
  });
});

interface Resource {
  readonly name: string;
  readonly labels: Record<string, string>;
}

function fakeDocker(resources: { containers?: Resource[]; volumes?: Resource[]; networks?: Resource[] }) {
  const removed: string[] = [];
  const docker = {
    listContainers: async () => (resources.containers ?? []).map((item) => ({ Id: item.name, Names: [`/${item.name}`], State: "running", Labels: item.labels })),
    listVolumes: async () => (resources.volumes ?? []).map((item) => ({ Name: item.name, Labels: item.labels })),
    listNetworks: async () => (resources.networks ?? []).map((item) => ({ Id: item.name, Name: item.name, Internal: false, Labels: item.labels })),
    inspectNetwork: async (name: string) => ({ Id: name, Name: name, Internal: false, Containers: {} }),
    removeContainer: async (name: string) => void removed.push(`container:${name}`),
    removeVolume: async (name: string) => void removed.push(`volume:${name}`),
    removeNetwork: async (name: string) => void removed.push(`network:${name}`),
    disconnectNetwork: async () => undefined,
  };
  return { docker, removed };
}

const at = (instance: string, labels: Record<string, string> = {}) => ({ "managed-copilot.instance": instance, ...labels });

describe("sweepAbandonedInstances", () => {
  const log = createLogger("test", "error");

  it("removes every resource of an instance whose data directory is gone, including its unlabeled CA volume", async () => {
    const gone = owned("C:\\repos\\deleted\\.managed-copilot\\data");
    const { docker, removed } = fakeDocker({
      containers: [{ name: "mc-dead-relay", labels: at("mc-dead", gone) }, { name: "mc-dead-egress", labels: at("mc-dead") }],
      volumes: [{ name: "mc-dead-sbx-1-workspace", labels: at("mc-dead", gone) }],
      networks: [{ name: "mc-dead-edge", labels: at("mc-dead", gone) }],
    });
    const result = await sweepAbandonedInstances({ docker, instance: "mc-self", log, context });
    expect(result.map((entry) => entry.instance)).toEqual(["mc-dead"]);
    expect(removed).toEqual(["container:mc-dead-relay", "container:mc-dead-egress", "network:mc-dead-edge", "volume:mc-dead-sbx-1-workspace", "volume:mc-dead-egress-data"]);
  });

  it("keeps instances with any live or foreign resource, unlabeled-only instances, and its own", async () => {
    const gone = owned("C:\\repos\\deleted\\.managed-copilot\\data");
    const { docker, removed } = fakeDocker({
      containers: [
        { name: "mc-mixed-relay", labels: at("mc-mixed", gone) },
        { name: "mc-mixed-sbx", labels: at("mc-mixed", owned("C:\\repos\\live\\.managed-copilot\\data")) },
        { name: "mc-wsl-relay", labels: at("mc-wsl", { ...gone, [OWNERSHIP_LABELS.host]: "linux/devbox/Ubuntu" }) },
        { name: "mc-wsl-sbx", labels: at("mc-wsl", gone) },
        { name: "mc-legacy-relay", labels: at("mc-legacy") },
        { name: "mc-self-relay", labels: at("mc-self", gone) },
      ],
    });
    expect(await sweepAbandonedInstances({ docker, instance: "mc-self", log, context })).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("removes an expired test run's resources while its directory still exists", async () => {
    const expired = owned("C:\\repos\\live\\.managed-copilot\\data", { [OWNERSHIP_LABELS.expires]: String(NOW / 1000 - 1) });
    const { docker, removed } = fakeDocker({ volumes: [{ name: "mcg1abc-egress-data", labels: at("mcg1abc", expired) }] });
    await sweepAbandonedInstances({ docker, instance: "mc-self", log, context });
    expect(removed).toEqual(["volume:mcg1abc-egress-data"]);
  });
});
