/**
 * AppHost fragment for Pattern Race: one job raced through six lanes, one per pattern. Plain data: no Aspire imports.
 *
 * Pattern Race declares no environments of its own. It races the root AppHost's six pattern environments as they are,
 * so its lanes differ only in the environment name each one passes to `managed.client(...)` (`src/shared/lanes.ts`):
 *
 * | Lane       | Environment | Declared in the root AppHost as                                     |
 * | ---------- | ----------- | ------------------------------------------------------------------- |
 * | Shared     | `chat`      | `{ type: "shared" }`                                                |
 * | Isolated   | `coder`     | `{ type: "isolated" }`                                              |
 * | Promotable | `helper`    | `{ type: "promotable", promoteTo: "coder" }`                        |
 * | Direct     | `operator`  | `{ type: "orchestrator", workers: ["coder"], execution: "direct" }` |
 * | Delegate   | `team`      | `{ type: "orchestrator", workers: ["coder"] }`                      |
 * | Mixed      | `lead`      | `{ type: "orchestrator", workers: ["coder"], execution: "mixed" }`  |
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { patternRace } from "./demos/pattern-race/apphost.mts";
 *
 * const race = patternRace();
 * // Run `node <race.app.script>` in race.app.workingDirectory (after `pnpm build`) with PORT and MANAGED_COPILOT_URL.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";

export const PATTERN_RACE_DEFAULT_PORT = 7420;

export interface PatternRaceOptions {
  /** Port for the UI and API. Defaults to 7420. */
  port?: number;
}

export interface PatternRaceApp {
  /** Aspire resource name. */
  readonly name: "pattern-race";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface PatternRaceFragment {
  readonly app: PatternRaceApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Pattern Race's app resource. */
export function patternRace(options: PatternRaceOptions = {}): PatternRaceFragment {
  return {
    app: {
      name: "pattern-race",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? PATTERN_RACE_DEFAULT_PORT,
      healthPath: "/api/health",
    },
  };
}
