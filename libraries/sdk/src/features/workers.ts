// An orchestrator session's workers (spec section 17).
import { ROUTES, type WorkerInfo } from "@managed-copilot/protocol";
import type { ManagedState } from "../connection.js";
import type { ManagedWorkers } from "../types.js";

export function createWorkersApi(ctx: ManagedState, sessionId: string): ManagedWorkers {
  // Workers belong to their coordinator's owner: helpers for them (`managed.files(worker.id)`, ...) act as the identity
  // that created or resumed the coordinator.
  const adopt = (workers: WorkerInfo[]): WorkerInfo[] => {
    const identity = ctx.identities.get(sessionId);
    if (identity) for (const worker of workers) if (!ctx.identities.has(worker.id)) ctx.identities.set(worker.id, identity);
    return workers;
  };
  return {
    list: async () => adopt(await ctx.httpFor(sessionId).get<WorkerInfo[]>(ROUTES.workers(sessionId))),
    get: async (worker) => adopt([await ctx.httpFor(sessionId).get<WorkerInfo>(ROUTES.worker(sessionId, worker))])[0]!,
  };
}
