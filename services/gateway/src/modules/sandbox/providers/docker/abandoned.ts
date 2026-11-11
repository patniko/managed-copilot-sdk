// Removes the Docker resources of other gateway instances on this engine once they are abandoned (docker-ownership.ts):
// a deleted worktree's or test run's sandboxes, volumes, networks, relay, and egress proxy. An instance goes only when
// at least one of its resources is abandoned and none is live or owned from another host; resources from before
// ownership labels never decide anything on their own.
import { classifyOwnership, type Ownership, type OwnershipContext } from "../../../../docker-ownership.js";
import type { Logger } from "../../../../log.js";
import type { DockerClient } from "./docker.js";

const INSTANCE_LABEL = "managed-copilot.instance";

type SweepDocker = Pick<DockerClient, "listContainers" | "listVolumes" | "listNetworks" | "inspectNetwork" | "removeContainer" | "removeVolume" | "removeNetwork" | "disconnectNetwork">;

export interface AbandonedInstance {
  readonly instance: string;
  readonly containers: number;
  readonly volumes: number;
  readonly networks: number;
}

interface Found {
  containers: string[];
  volumes: string[];
  networks: string[];
  ownership: Set<Ownership>;
}

export async function sweepAbandonedInstances(options: {
  readonly docker: SweepDocker;
  /** This gateway's instance, never swept here (its own reconciliation owns it). */
  readonly instance: string;
  readonly log: Logger;
  readonly context?: Partial<OwnershipContext>;
}): Promise<AbandonedInstance[]> {
  const { docker, instance: own, log } = options;
  const filter = { label: [INSTANCE_LABEL] };
  const found = new Map<string, Found>();
  const entry = (instance: string | undefined): Found | undefined => {
    if (!instance || instance === own) return undefined;
    let current = found.get(instance);
    if (!current) found.set(instance, (current = { containers: [], volumes: [], networks: [], ownership: new Set() }));
    return current;
  };
  for (const container of await docker.listContainers(filter)) {
    const target = entry(container.Labels[INSTANCE_LABEL]);
    if (!target) continue;
    target.containers.push(container.Names[0]?.replace(/^\//, "") ?? container.Id);
    target.ownership.add(classifyOwnership(container.Labels, options.context));
  }
  for (const volume of await docker.listVolumes(filter)) {
    const target = entry(volume.Labels?.[INSTANCE_LABEL]);
    if (!target) continue;
    target.volumes.push(volume.Name);
    target.ownership.add(classifyOwnership(volume.Labels, options.context));
  }
  for (const network of await docker.listNetworks(filter)) {
    const target = entry(network.Labels?.[INSTANCE_LABEL]);
    if (!target) continue;
    target.networks.push(network.Name);
    target.ownership.add(classifyOwnership(network.Labels, options.context));
  }

  const removed: AbandonedInstance[] = [];
  for (const [instance, resources] of found) {
    const { ownership } = resources;
    if (!ownership.has("abandoned") || ownership.has("live") || ownership.has("foreign")) continue;
    // The egress proxy's CA volume predates ownership labels on older gateways; it is named for the instance.
    const volumes = new Set([...resources.volumes, `${instance}-egress-data`]);
    log.info("Removing Docker resources abandoned by another Managed Copilot instance (its data directory is gone or it expired)", {
      instance,
      containers: resources.containers.length,
      volumes: resources.volumes.length,
      networks: resources.networks.length,
    });
    try {
      for (const name of resources.containers) await docker.removeContainer(name);
      for (const name of resources.networks) {
        const inspected = await docker.inspectNetwork(name);
        for (const endpoint of Object.values(inspected?.Containers ?? {})) await docker.disconnectNetwork(name, endpoint.Name);
        if (inspected) await docker.removeNetwork(name);
      }
      for (const name of volumes) await docker.removeVolume(name);
      removed.push({ instance, containers: resources.containers.length, volumes: resources.volumes.length, networks: resources.networks.length });
    } catch (error) {
      log.warn("Could not remove all abandoned Docker resources; the next sweep retries", { instance, error: (error as Error).message });
    }
  }
  return removed;
}
