import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactInfo } from "@managed-copilot/protocol";
import { resolveSession, type Context } from "../context.js";
import { UsageError } from "../errors.js";
import { formatBytes, relativeTime, shortId, table, type Style } from "../output.js";

function paintArtifactState(artifact: ArtifactInfo, style: Style): string {
  if (artifact.state === "published") return style.green("published");
  if (artifact.state === "failed") return style.red("failed");
  return style.yellow(artifact.state);
}

/** Characters Windows refuses in file names, and its reserved device names (with or without an extension). */
const WINDOWS_INVALID = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/** Maps a published artifact path (relative to /workspace/outputs) to a file inside `directory`, or refuses. */
export function downloadTarget(directory: string, artifactPath: string, platform: NodeJS.Platform = process.platform): string {
  const refuse = (why: string) => new UsageError(`Refusing to save artifact "${artifactPath}": ${why}.`);
  const segments = artifactPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw refuse("its path has an empty, '.', or '..' segment");
    if (/[\\\u0000-\u001f]/.test(segment)) throw refuse("its name contains a backslash or a control character");
    if (platform === "win32" && (WINDOWS_INVALID.test(segment) || WINDOWS_DEVICE.test(segment) || /[. ]$/.test(segment))) {
      throw refuse("its name isn't a valid Windows file name");
    }
  }
  const target = resolve(directory, ...segments);
  const inside = relative(resolve(directory), target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) throw refuse(`it would be written outside ${directory}`);
  return target;
}

/** Refuses a destination reached through a symlink or junction, which could point outside `directory`. */
export async function assertNoLinks(directory: string, target: string): Promise<void> {
  let current = resolve(directory);
  for (const segment of relative(current, target).split(sep)) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new UsageError(`Refusing to save an artifact through the link ${current}.`, "Choose a download folder without links in it.");
  }
}

export async function artifacts(ctx: Context): Promise<void> {
  const { style, options } = ctx;
  const managed = await (await ctx.deployment()).managed();
  const session = await resolveSession(managed, ctx.args[0]);
  const api = managed.artifacts(session.id);
  const all = options.all === true;
  const list = await api.list({ versions: all ? "all" : "latest" });
  const directory = options.download as string | undefined;

  if (ctx.json && !directory) return ctx.out(JSON.stringify(list, null, 2));
  if (list.length === 0) {
    ctx.out(`No artifacts for ${style.bold(shortId(session.id))} yet.`);
    ctx.out(style.dim("  Files the agent saves under /workspace/outputs are published when a turn completes."));
    return;
  }
  if (!ctx.json) {
    const rows = list.map((artifact) => [
      style.bold(artifact.path),
      formatBytes(artifact.size),
      `v${artifact.version}`,
      paintArtifactState(artifact, style),
      style.dim(relativeTime(artifact.publishedAt, ctx.now())),
    ]);
    ctx.out(table(["PATH", "SIZE", "VERSION", "STATE", "PUBLISHED"], rows, style));
  }
  if (!directory) return;

  const newest = new Map<string, ArtifactInfo>();
  for (const artifact of list) {
    if (artifact.state !== "published") continue;
    const current = newest.get(artifact.path);
    if (!current || artifact.version > current.version) newest.set(artifact.path, artifact);
  }
  const saved: string[] = [];
  // Validate every name first, so a bad one never leaves a partial download behind.
  const targets = new Map<ArtifactInfo, string>();
  const claimed = new Map<string, string>();
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  for (const artifact of newest.values()) {
    const target = downloadTarget(directory, artifact.path);
    const key = caseInsensitive ? target.toLowerCase() : target;
    const other = claimed.get(key);
    if (other !== undefined) throw new UsageError(`Artifacts "${other}" and "${artifact.path}" would be saved to the same file in ${directory}.`);
    claimed.set(key, artifact.path);
    targets.set(artifact, target);
  }
  for (const [artifact, target] of targets) {
    await assertNoLinks(directory, target);
    await mkdir(dirname(target), { recursive: true });
    await api.download(artifact.path, target);
    saved.push(target);
  }
  if (ctx.json) return ctx.out(JSON.stringify({ artifacts: list, saved }, null, 2));
  ctx.out();
  ctx.out(`${style.green(style.ok)} Saved ${saved.length} file${saved.length === 1 ? "" : "s"} to ${resolve(directory)}`);
}
