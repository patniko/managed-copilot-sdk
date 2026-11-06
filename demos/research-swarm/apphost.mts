/**
 * AppHost fragment for Research Swarm (spec section 17): an orchestrator whose workers are web researchers, each in a
 * sandbox of its own. Plain data: no Aspire imports.
 *
 * | Environment          | Type         | Size  | Network                          | What it's for                                  |
 * | -------------------- | ------------ | ----- | -------------------------------- | ---------------------------------------------- |
 * | `research-swarm`     | orchestrator | n/a   | off                              | the lead researcher: splits the question, writes the report |
 * | `research-swarm-web` | isolated     | small | a short allowlist of reference sites | one researcher per sub-question, reading the web |
 *
 * `customizations/researcher` gives every researcher its instructions and the `research` command (search the allowed
 * sites, read a page, and record it as a source). The lead's network is off: only pages a researcher read can be
 * cited.
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { researchSwarm } from "./demos/research-swarm/apphost.mts";
 *
 * const swarm = researchSwarm();
 * await addManagedCopilot(builder, "copilot", { environments: { ...swarm.environments, ...otherEnvironments } });
 * // Run `node <swarm.app.script>` in swarm.app.workingDirectory (after `pnpm build`) with PORT and MANAGED_COPILOT_URL.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The orchestrator environment: each research question is one session of it. */
export const RESEARCH_SWARM_ENVIRONMENT = "research-swarm";

/** The isolated environment every researcher runs in. */
export const RESEARCH_SWARM_RESEARCHERS = "research-swarm-web";

/** Researchers one question can have at once. */
export const RESEARCH_SWARM_MAX_RESEARCHERS = 4;

export const RESEARCH_SWARM_DEFAULT_PORT = 7425;

/** Reference sites the researchers may read, with search APIs the `research` command uses. */
export const RESEARCH_SWARM_HOSTS = [
  "en.wikipedia.org",
  "developer.mozilla.org",
  "learn.microsoft.com",
  "docs.python.org",
  "nodejs.org",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "arxiv.org",
  "export.arxiv.org",
];

/** Where the sandbox mounts the researcher customizations, and the `research` command's script in them. */
const RESEARCH_SCRIPT = "/opt/managed-copilot/customizations/skills/web-research/research.py";

export interface ResearchSwarmOptions {
  /** Port for the UI and API. Defaults to 7425. */
  port?: number;
}

export interface ResearchSwarmApp {
  /** Aspire resource name. */
  readonly name: "research-swarm";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface ResearchSwarmFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: ResearchSwarmApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Research Swarm's environment declarations and its app resource. */
export function researchSwarm(options: ResearchSwarmOptions = {}): ResearchSwarmFragment {
  const environments: Record<string, EnvironmentConfig> = {
    [RESEARCH_SWARM_ENVIRONMENT]: {
      type: "orchestrator",
      description: "Research Swarm: a lead researcher that splits a question across web researchers and writes a cited report",
      network: false,
      workers: [RESEARCH_SWARM_RESEARCHERS],
      maxWorkers: RESEARCH_SWARM_MAX_RESEARCHERS,
    },
    [RESEARCH_SWARM_RESEARCHERS]: {
      type: "isolated",
      size: "small",
      network: RESEARCH_SWARM_HOSTS,
      customizations: here("./customizations/researcher"),
      // Puts the `research` command on the researcher's PATH.
      setupCommands: [
        `mkdir -p "$HOME/.local/bin" && printf '#!/bin/sh\\nexec python3 ${RESEARCH_SCRIPT} "$@"\\n' > "$HOME/.local/bin/research" && chmod 0755 "$HOME/.local/bin/research"`,
      ],
      env: { CI: "1", NO_COLOR: "1" },
      description: `Web researcher: answers one sub-question from pages on ${RESEARCH_SWARM_HOSTS.join(", ")}, with the research command, and reports findings with their source URLs. No other sites.`,
    },
  };

  return {
    environments,
    app: {
      name: "research-swarm",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? RESEARCH_SWARM_DEFAULT_PORT,
      healthPath: "/api/health",
    },
  };
}
