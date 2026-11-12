import type { EnvironmentDef } from '../types';

const ORDER = ['citadel', 'desert', 'alpine', 'dream', 'dunes', 'city'];

/**
 * Load every environment module independently so a failing world never breaks the game.
 * Returns the successfully loaded environments in menu order.
 */
export async function loadEnvironments(): Promise<EnvironmentDef[]> {
  const mods = import.meta.glob(['./*.ts', '!./index.ts']);
  const entries = Object.entries(mods);
  const settled = await Promise.allSettled(entries.map(([, load]) => load()));
  const out: EnvironmentDef[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[env] failed to load ${entries[i][0]}`, r.reason);
      return;
    }
    for (const v of Object.values(r.value as Record<string, unknown>)) {
      const e = v as EnvironmentDef;
      if (e && typeof e === 'object' && typeof e.id === 'string' && e.terrain && e.course && !out.some((o) => o.id === e.id)) out.push(e);
    }
  });
  out.sort((a, b) => (ORDER.indexOf(a.id) + 99) % 99 - ((ORDER.indexOf(b.id) + 99) % 99));
  return out;
}
