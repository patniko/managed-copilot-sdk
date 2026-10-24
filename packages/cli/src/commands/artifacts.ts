import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactInfo } from "@managed-copilot/protocol";
import { resolveSession, type Context } from "../context.js";
import { UsageError } from "../errors.js";
import { formatBytes, relativeTime, shortId, table, type Style } from "../output.js";

function paintArtifactState(artifact: ArtifactInfo, style: Style): string {
  if (artifact.state === "published") return style.green("published");
  if (artifact.state === "failed") return style.red("failed");
  return style.yellow(artifact.state);
}

/** Maps a published artifact path (relative to /workspace/outputs) to a file inside `directory`, or refuses. */
export function downloadTarget(directory: string, artifactPath: string): string {
  const target = resolve(directory, ...artifactPath.split("/"));
  const inside = relative(resolve(directory), target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) {
    throw new UsageError(`Refusing to write artifact "${artifactPath}" outside ${directory}.`);
  }
  return target;
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
  for (const artifact of newest.values()) {
    const target = downloadTarget(directory, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await api.download(artifact.path, target);
    saved.push(target);
  }
  if (ctx.json) return ctx.out(JSON.stringify({ artifacts: list, saved }, null, 2));
  ctx.out();
  ctx.out(`${style.green(style.ok)} Saved ${saved.length} file${saved.length === 1 ? "" : "s"} to ${resolve(directory)}`);
}
