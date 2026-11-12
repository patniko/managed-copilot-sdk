// The storefront code checkout runs: Contoso Outdoors' storefront as it shipped (read-only, from
// demos/help-desk/storefront), overlaid with the files of the latest deploy. Each deploy is a folder in the data
// directory named by its version, holding every file deployed so far. The server only reads these files and serves them
// to browsers, at versioned, content-addressed URLs that never change; it never imports or runs them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StorefrontInfo } from "../shared/shop.js";
import { readJsonFile, writeJsonFile } from "./files.js";

/** One deploy: the version it activated and where it came from. */
export interface DeployRecord {
  readonly version: string;
  readonly previousVersion: string;
  readonly incident: string;
  readonly summary: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly tests?: string;
  readonly deployedAt: string;
  readonly idempotencyKey?: string;
  /** The files this deploy changed. */
  readonly files: readonly string[];
}

/** What a deploy brings: Incident Commander's approved fix. */
export interface DeployInput {
  readonly incident: string;
  readonly summary: string;
  readonly version?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly tests?: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly idempotencyKey?: string;
}

interface State {
  current?: string;
  deploys: DeployRecord[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE = /^(\d+\.\d+\.\d+)-([0-9a-f]{10})$/;
const MODULE_PATH = /^src\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/;
const SKIPPED = new Set(["node_modules", ".git", "dist", "coverage"]);

function parts(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

/** Whether version `a` comes after `b`. */
export function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** `2.3.0` → `2.3.1`. */
export function nextPatch(version: string): string {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** `package.json` with its version set to `version` (as a release pipeline stamps it). */
function stamped(manifest: string, version: string): string {
  try {
    return `${JSON.stringify({ ...(JSON.parse(manifest) as Record<string, unknown>), version }, null, 2)}\n`;
  } catch {
    return manifest;
  }
}

/** A folder's text files by POSIX path, for the parts a storefront has: package.json, README.md, src/, and test/. */
function readTree(root: string, entries: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (path: string): void => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort()) if (!SKIPPED.has(entry)) walk(join(path, entry));
      return;
    }
    if (!info.isFile()) return;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return;
    files.set(relative(root, path).split(sep).join("/"), bytes.toString("utf8").replace(/\r\n/g, "\n"));
  };
  for (const entry of entries) walk(join(root, entry));
  return files;
}

export class Storefront {
  readonly #originalDir: string;
  readonly #versionsDir: string;
  readonly #stateFile: string;
  #state: State;

  /** `originalDir`: the storefront as it shipped (never written); `dataDir`: where deployed versions are kept. */
  constructor(originalDir: string, dataDir: string) {
    this.#originalDir = originalDir;
    this.#versionsDir = join(dataDir, "storefront");
    this.#stateFile = join(dataDir, "storefront.json");
    const saved = readJsonFile<Partial<State>>(this.#stateFile);
    this.#state = { deploys: Array.isArray(saved?.deploys) ? saved.deploys : [], ...(typeof saved?.current === "string" ? { current: saved.current } : {}) };
    if (this.#state.current && !existsSync(join(this.#versionsDir, this.#state.current))) this.#state = { deploys: [] };
  }

  /** The storefront as it shipped. */
  originals(): Map<string, string> {
    const files = readTree(this.#originalDir, ["package.json", "README.md", "src", "test"]);
    if (!files.has("src/promotions.js")) throw new Error(`The storefront code isn't at ${this.#originalDir} (set DOWNHILL_STOREFRONT_DIR).`);
    return files;
  }

  /** The version the storefront shipped as: its package.json's. */
  originalVersion(): string {
    try {
      const version = (JSON.parse(this.originals().get("package.json") ?? "{}") as { version?: unknown }).version;
      return typeof version === "string" && SEMVER.test(version) ? version : "1.0.0";
    } catch {
      return "1.0.0";
    }
  }

  /** The version checkout runs now, and the deploy that activated it (none: the storefront as it shipped). */
  current(): { readonly version: string; readonly deploy?: DeployRecord } {
    const version = this.#state.current;
    const deploy = version ? this.#state.deploys.findLast((record) => record.version === version) : undefined;
    return version && deploy ? { version, deploy } : { version: this.originalVersion() };
  }

  deploys(): readonly DeployRecord[] {
    return this.#state.deploys;
  }

  /** When checkout was first fixed: the first deploy's time. */
  fixedAt(): number | undefined {
    const first = this.#state.deploys[0];
    return first ? Date.parse(first.deployedAt) : undefined;
  }

  /** When the version checkout runs now was deployed (none: the storefront as it shipped). */
  deployedAt(): number | undefined {
    const version = this.#state.current;
    const deploy = version ? this.#state.deploys.findLast((record) => record.version === version) : undefined;
    return deploy ? Date.parse(deploy.deployedAt) : undefined;
  }

  findDeploy(idempotencyKey: string): DeployRecord | undefined {
    return this.#state.deploys.find((record) => record.idempotencyKey === idempotencyKey);
  }

  #overlay(version: string): Map<string, string> {
    const dir = join(this.#versionsDir, version);
    return existsSync(dir) ? readTree(dir, ["package.json", "README.md", "src", "test"]) : new Map();
  }

  #isDeployed(version: string): boolean {
    return this.#state.deploys.some((record) => record.version === version);
  }

  /** A version's files: the originals overlaid with every file deployed up to that version. */
  files(version = this.current().version): Map<string, string> {
    const files = this.originals();
    if (this.#isDeployed(version)) for (const [path, content] of this.#overlay(version)) files.set(path, content);
    return files;
  }

  /** `2.3.1-<hash>`: names a version's browser modules by their content, so their URLs can be cached for good. */
  #release(version: string, files: ReadonlyMap<string, string>): string {
    const hash = createHash("sha256");
    for (const path of [...files.keys()].filter((p) => MODULE_PATH.test(p)).sort()) hash.update(`${path}\n${files.get(path)}\n`);
    return `${version}-${hash.digest("hex").slice(0, 10)}`;
  }

  /** What checkout runs now, and where browsers import it from. */
  info(): StorefrontInfo {
    const { version, deploy } = this.current();
    const release = this.#release(version, this.files(version));
    return {
      version,
      source: deploy ? "deployed" : "original",
      ...(deploy ? { deployedAt: deploy.deployedAt, incident: deploy.incident, ...(deploy.approvedBy ? { approvedBy: deploy.approvedBy } : {}) } : {}),
      modules: { promotions: `/storefront/${release}/src/promotions.js`, cart: `/storefront/${release}/src/cart.js` },
    };
  }

  /** A browser module of a release (`src/….js`), if that release exists with exactly that content. */
  module(release: string, path: string): string | undefined {
    const match = RELEASE.exec(release);
    if (!match || !MODULE_PATH.test(path)) return undefined;
    const version = match[1]!;
    if (version !== this.originalVersion() && !this.#isDeployed(version)) return undefined;
    const files = this.files(version);
    return this.#release(version, files) === release ? files.get(path) : undefined;
  }

  /** Activates a deploy as the next version: its files over everything deployed so far. */
  activate(input: DeployInput, now: number): DeployRecord {
    const previous = this.current().version;
    let version = input.version && SEMVER.test(input.version) && newer(input.version, previous) ? input.version : nextPatch(previous);
    while (this.#isDeployed(version) || existsSync(join(this.#versionsDir, version))) version = nextPatch(version);
    const overlay = this.#isDeployed(previous) ? this.#overlay(previous) : new Map<string, string>();
    for (const file of input.files) overlay.set(file.path, file.content.replace(/\r\n/g, "\n"));
    const manifest = overlay.get("package.json") ?? this.originals().get("package.json");
    if (manifest) overlay.set("package.json", stamped(manifest, version));

    // Write the version's folder under a temporary name, then move it into place.
    const target = join(this.#versionsDir, version);
    const staging = `${target}.${process.pid}.tmp`;
    rmSync(staging, { recursive: true, force: true });
    for (const [path, content] of overlay) {
      const file = resolve(staging, ...path.split("/"));
      if (!file.startsWith(resolve(staging) + sep)) throw new Error(`Refusing to write ${path} outside the version's folder.`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    renameSync(staging, target);

    const record: DeployRecord = {
      version,
      previousVersion: previous,
      incident: input.incident,
      summary: input.summary,
      ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
      ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
      ...(input.tests ? { tests: input.tests } : {}),
      deployedAt: new Date(now).toISOString(),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      files: input.files.map((file) => file.path),
    };
    this.#state = { current: version, deploys: [...this.#state.deploys, record] };
    writeJsonFile(this.#stateFile, this.#state);
    return record;
  }

  /** Back to the storefront as it shipped: every deployed version is deleted. */
  reset(): void {
    rmSync(this.#versionsDir, { recursive: true, force: true });
    this.#state = { deploys: [] };
    writeJsonFile(this.#stateFile, this.#state);
  }
}
