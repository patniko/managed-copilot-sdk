// `pnpm reset`: stops the local platform (`aspire run`) and deletes its state so the next run starts fresh: the
// gateway's data directory (sessions, sandbox records, artifacts, runtime homes), every demo's `.data`, and the Docker
// sandboxes, networks, and volumes this checkout's gateway created. Deployments in Azure are not touched.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayDataDir = join(root, ".managed-copilot", "data");
const DATA_DIR_LABEL = "managed-copilot.data-dir";

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string; missing: boolean } {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim(), missing };
}

function samePath(a: string, b: string): boolean {
  const normalize = (path: string) => resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}

console.log("Stopping the local platform...");
const stop = run("aspire", ["stop", "--apphost", "apphost.mts", "--non-interactive"]);
if (!stop.ok) {
  const reason = stop.missing ? "the Aspire CLI isn't installed" : stop.stderr || stop.stdout.trim() || "aspire stop failed";
  console.error(`Couldn't stop the local platform: ${reason}.`);
  console.error("Stop `aspire run` yourself (Ctrl+C), then run `pnpm reset` again.");
  process.exit(1);
}

const directories = [
  gatewayDataDir,
  ...readdirSync(join(root, "demos"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "demos", entry.name, ".data")),
].filter((directory) => existsSync(directory));
for (const directory of directories) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  console.log(`Deleted ${relative(root, directory)}`);
}
if (directories.length === 0) console.log("No local data to delete.");

// The gateway also removes these when it next starts; removing them now frees the space either way.
const kinds = [
  { name: "containers", id: "ID", list: ["ps", "-a"], remove: ["rm", "-f", "-v"] },
  { name: "networks", id: "ID", list: ["network", "ls"], remove: ["network", "rm"] },
  { name: "volumes", id: "Name", list: ["volume", "ls"], remove: ["volume", "rm", "-f"] },
] as const;
for (const kind of kinds) {
  const listed = run("docker", [...kind.list, "--filter", `label=${DATA_DIR_LABEL}`, "--format", `{{.${kind.id}}}\t{{.Label "${DATA_DIR_LABEL}"}}`]);
  if (!listed.ok) {
    console.log(listed.missing
      ? "Docker isn't installed, so there are no sandboxes to remove."
      : `Couldn't list Docker ${kind.name} (${listed.stderr || "is Docker running?"}); the gateway removes this checkout's leftovers when it starts.`);
    break;
  }
  const ids = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter(([id, dataDir]) => id && dataDir && samePath(dataDir, gatewayDataDir))
    .map(([id]) => id!);
  if (ids.length === 0) continue;
  const removed = run("docker", [...kind.remove, ...ids]);
  console.log(removed.ok
    ? `Removed ${ids.length} Docker ${kind.name}`
    : `Couldn't remove every Docker ${kind.name} (${removed.stderr}); the gateway removes the rest when it starts.`);
}

console.log("\nReset done. Run `aspire run` to start fresh.");
console.log("Browsers keep their own demo state, such as Downhill's purchases: use Downhill's Reset demo control or clear the site's data.");
