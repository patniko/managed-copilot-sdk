// Owner: network workstream. Per-user vaults created in code (spec section 8).
import { notImplemented } from "../connection.js";
import type { ManagedContext, ManagedVaults } from "../types.js";

export function createVaultsApi(_ctx: ManagedContext): ManagedVaults {
  const unavailable = () => notImplemented("managed.vaults");
  return { create: unavailable, list: unavailable, delete: unavailable };
}
