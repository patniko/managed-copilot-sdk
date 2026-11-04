// Owner: sandbox workstream. Streams workspace files to and from an isolated session's sandbox (spec section 5).
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ManagedCopilotError, ROUTES, type FileEntry } from "@managed-copilot/protocol";
import type { HttpClient } from "../http.js";
import type { ManagedContext, ManagedFiles } from "../types.js";

/** Writes a response body to `localPath` atomically (a partial file never replaces an existing one). */
export async function saveResponse(response: Response, localPath: string): Promise<void> {
  const target = resolve(localPath);
  await fs.mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial-${randomBytes(4).toString("hex")}`;
  try {
    if (response.body) await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(partial));
    else await fs.writeFile(partial, new Uint8Array());
    await fs.rename(partial, target);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
}

async function put(http: HttpClient, sessionId: string, remotePath: string, body: RequestInit["body"], size: number, overwrite: boolean | undefined): Promise<FileEntry> {
  const response = await http.fetch("PUT", ROUTES.fileContent(sessionId), {
    query: { path: remotePath, ...(overwrite === false ? { overwrite: "false" } : {}) },
    rawBody: body,
    duplex: "half",
    headers: { "content-type": "application/octet-stream", "content-length": String(size) },
  });
  return (await response.json()) as FileEntry;
}

export function createFilesApi(ctx: ManagedContext, sessionId: string): ManagedFiles {
  const http = () => ctx.httpFor(sessionId);
  const content = (remotePath: string) => http().fetch("GET", ROUTES.fileContent(sessionId), { query: { path: remotePath } });
  return {
    list: (path = "", options) => http().get<FileEntry[]>(ROUTES.files(sessionId), { query: { path, ...(options?.recursive ? { recursive: true } : {}) } }),

    async upload(localPath, remotePath, options) {
      let size: number;
      try {
        const stat = await fs.stat(localPath);
        if (!stat.isFile()) throw new ManagedCopilotError("invalid_request", `${localPath} is not a file.`);
        size = stat.size;
      } catch (error) {
        if (error instanceof ManagedCopilotError) throw error;
        throw new ManagedCopilotError("invalid_request", `Cannot read the local file ${localPath}: ${(error as Error).message}`);
      }
      const body = Readable.toWeb(createReadStream(localPath)) as unknown as RequestInit["body"];
      return put(http(), sessionId, remotePath, body, size, options?.overwrite);
    },

    write(remotePath, data, options) {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      return put(http(), sessionId, remotePath, bytes, bytes.length, options?.overwrite);
    },

    async download(remotePath, localPath) {
      await saveResponse(await content(remotePath), localPath);
    },

    async read(remotePath) {
      return (await content(remotePath)).text();
    },

    async readBytes(remotePath) {
      return new Uint8Array(await (await content(remotePath)).arrayBuffer());
    },
  };
}
