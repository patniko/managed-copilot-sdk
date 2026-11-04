// Services Incident Commander knows: the bundled demo service (its production logs generated per incident) and, when
// INCIDENT_SERVICES_DIR is set, your own services' folders (code, tests, and the logs you export there). The coordinator
// gets a copy of the service's folder in its own sandbox; diffs and deploys compare against these originals.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DEMO_SERVICE, demoProduction, type DemoSeed, type DemoStats } from "./demo.js";

const SKIPPED = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "__pycache__"]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export interface ServiceEntry {
  readonly name: string;
  /** The bundled demo service: its "production" is simulated by this app. */
  readonly demo: boolean;
  readonly version?: string;
}

/** A service folder's text files, by path relative to the folder (POSIX separators). */
async function readFolder(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.size >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = (await stat(full)).size;
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      const bytes = await readFile(full);
      // Text only: the agent greps and edits these.
      if (bytes.includes(0)) continue;
      total += size;
      files.set(relative(root, full).split(sep).join("/"), bytes.toString("utf8").replace(/\r\n/g, "\n"));
    }
  };
  await walk(root);
  return files;
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export class ServiceCatalog {
  readonly #demoDir: string;
  readonly #ownDir: string | undefined;

  constructor(demoDir: string, ownDir?: string) {
    this.#demoDir = demoDir;
    this.#ownDir = ownDir;
  }

  /** The folder a service's files come from: your own first, then the bundled demo service. */
  async #folder(name: string): Promise<{ readonly path: string; readonly demo: boolean } | undefined> {
    if (!SERVICE_NAME.test(name)) return undefined;
    if (this.#ownDir && (await isFolder(join(this.#ownDir, name)))) return { path: join(this.#ownDir, name), demo: false };
    if (name === DEMO_SERVICE && (await isFolder(join(this.#demoDir, name)))) return { path: join(this.#demoDir, name), demo: true };
    return undefined;
  }

  async find(name: string): Promise<ServiceEntry | undefined> {
    const folder = await this.#folder(name);
    if (!folder) return undefined;
    let version: string | undefined;
    try {
      const manifest = JSON.parse(await readFile(join(folder.path, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version === "string") version = manifest.version;
    } catch {
      // Not a Node service, or no version: deploys then name no version.
    }
    return { name, demo: folder.demo, ...(version ? { version } : {}) };
  }

  /** What deployed today: the folder's files as they are. */
  async originals(name: string): Promise<Map<string, string>> {
    const folder = await this.#folder(name);
    return folder ? readFolder(folder.path) : new Map();
  }

  /** The files to copy into the coordinator's sandbox. The demo service adds its generated logs and deploy history. */
  async workspace(name: string, demo: DemoSeed | undefined): Promise<{ readonly files: Map<string, string>; readonly stats?: DemoStats }> {
    const folder = await this.#folder(name);
    if (!folder) return { files: new Map() };
    const files = await readFolder(folder.path);
    if (!folder.demo || !demo) return { files };
    const production = demoProduction(
      { discounts: files.get("src/discounts.js") ?? "", cart: files.get("src/cart.js") ?? "", server: files.get("src/server.js") ?? "" },
      demo,
    );
    files.set("logs/checkout.log", production.log);
    files.set("deploys/HISTORY.md", production.history);
    return { files, stats: production.stats };
  }
}
