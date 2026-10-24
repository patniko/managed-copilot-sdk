// Owner: sandbox workstream. Turn-scoped immutable artifacts from /workspace/outputs (spec section 6).
import { isManagedCopilotError, ManagedCopilotError, ROUTES, type ArtifactInfo, type PublicationResult } from "@managed-copilot/protocol";
import type { ManagedArtifacts, ManagedContext } from "../types.js";
import { saveResponse } from "./files.js";

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const SERVER_WAIT_MS = 60_000;

/** Accepts `report.md`, `outputs/report.md`, or `/workspace/outputs/report.md`; strips exactly one such prefix. */
function outputsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\/?workspace\/outputs\/|\.?\/?outputs\/|\.\/)/, "");
}

export function createArtifactsApi(ctx: ManagedContext, sessionId: string): ManagedArtifacts {
  const http = () => ctx.httpFor(sessionId);
  const list = (options?: { versions?: "latest" | "all" }) =>
    http().get<ArtifactInfo[]>(ROUTES.artifacts(sessionId), { query: { versions: options?.versions ?? "latest" } });

  const find = async (path: string, version?: number): Promise<ArtifactInfo> => {
    const wanted = outputsPath(path);
    const artifacts = await list({ versions: version === undefined ? "latest" : "all" });
    const match = artifacts.find((artifact) => artifact.path === wanted && (version === undefined || artifact.version === version));
    if (!match) {
      const versions = artifacts.filter((artifact) => artifact.path === wanted).map((artifact) => artifact.version);
      throw new ManagedCopilotError(
        "not_found",
        version !== undefined && versions.length > 0
          ? `outputs/${wanted} has no version ${version} (published versions: ${versions.join(", ")}).`
          : `No published artifact outputs/${wanted} in this session. Save it under /workspace/outputs and call waitForPublication() after the turn completes.`,
        { path: wanted, ...(version !== undefined ? { version } : {}) },
      );
    }
    return match;
  };

  const content = async (path: string, version?: number) => http().fetch("GET", ROUTES.artifactContent(sessionId, (await find(path, version)).id));

  return {
    async waitForPublication(options = {}) {
      const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // The first answer pins the turn, so a newer turn starting meanwhile cannot change what this call waits for.
      let turnId = options.turnId;
      for (;;) {
        const remaining = Math.max(0, deadline - Date.now());
        try {
          return await http().get<PublicationResult>(ROUTES.artifactPublication(sessionId), {
            query: { ...(turnId ? { turnId } : {}), timeoutMs: Math.min(remaining, SERVER_WAIT_MS) },
          });
        } catch (error) {
          if (isManagedCopilotError(error, "timeout")) {
            turnId ??= typeof error.details?.["turnId"] === "string" ? (error.details["turnId"] as string) : undefined;
            if (Date.now() < deadline) continue;
          }
          throw error;
        }
      }
    },

    list,

    async read(path, options) {
      return (await content(path, options?.version)).text();
    },

    async readBytes(path, options) {
      return new Uint8Array(await (await content(path, options?.version)).arrayBuffer());
    },

    async download(path, localPath, options) {
      await saveResponse(await content(path, options?.version), localPath);
    },
  };
}
