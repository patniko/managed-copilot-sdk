import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError, type SandboxOutputsManifest } from "@managed-copilot/protocol";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
import type { SandboxAgentClient } from "../src/modules/sandbox/agent-client.js";
import { ArtifactService, contentTypeFor } from "../src/modules/sandbox/artifacts.js";
import { SandboxStore } from "../src/modules/sandbox/store.js";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

class FakeAgent {
  files = new Map<string, string>();
  rejected: { path: string; reason: string }[] = [];
  mutate: string | undefined;
  async outputsManifest(): Promise<SandboxOutputsManifest> {
    return {
      files: [...this.files].map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sha(content), modifiedAt: new Date().toISOString() })),
      rejected: this.rejected,
    };
  }
  async readOutput(path: string): Promise<Readable> {
    const content = this.files.get(path)!;
    return Readable.from([Buffer.from(this.mutate === path ? `${content}!` : content)]);
  }
}

describe("ArtifactService", () => {
  let dir: string;
  let agent: FakeAgent;
  let events: { type: string; data: Record<string, unknown> }[];
  let service: ArtifactService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-artifacts-"));
    const db = openDatabase(":memory:");
    new SandboxStore(db);
    agent = new FakeAgent();
    events = [];
    service = new ArtifactService({
      db,
      dataDir: dir,
      log: createLogger("test", "error"),
      agentFor: async () => agent as unknown as SandboxAgentClient,
      track: (_sessionId, work) => work,
      ownerOf: () => 42,
      events: () => ({ publish: (event) => events.push({ type: event.type, data: event.data as Record<string, unknown> }) }),
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function turn(id: string, outcome: "completed" | "cancelled" | "failed" = "completed") {
    service.turnStarted(SESSION, id);
    const ids = service.turnsCompleted(SESSION, outcome);
    await service.publish(SESSION, ids, outcome);
  }

  it("publishes outputs at completed turns with versions, digests, and immutable content", async () => {
    agent.files.set("report.md", "# Report v1\n");
    agent.files.set("charts/a.png", "png-bytes");
    await turn("turn-1");
    const first = await service.waitForPublication(SESSION);
    expect(first.state).toBe("published");
    expect(first.turnId).toBe("turn-1");
    expect(first.artifacts.map((artifact) => `${artifact.path}@${artifact.version}`).sort()).toEqual(["charts/a.png@1", "report.md@1"]);
    expect(first.artifacts.find((artifact) => artifact.path === "report.md")!.digest).toBe(`sha256:${sha("# Report v1\n")}`);
    expect(events[0]!.type).toBe("artifact.published");

    agent.files.set("report.md", "# Report v2\n");
    await turn("turn-2");
    const second = await service.waitForPublication(SESSION);
    expect(second.turnId).toBe("turn-2");
    const report = second.artifacts.find((artifact) => artifact.path === "report.md")!;
    expect(report.version).toBe(2);
    expect(report.turnId).toBe("turn-2");
    expect(second.artifacts.find((artifact) => artifact.path === "charts/a.png")!.version).toBe(1);

    expect(service.list(SESSION).map((artifact) => `${artifact.path}@${artifact.version}`)).toEqual(["charts/a.png@1", "report.md@2"]);
    expect(service.list(SESSION, { versions: "all" }).map((artifact) => `${artifact.path}@${artifact.version}`)).toEqual(["charts/a.png@1", "report.md@1", "report.md@2"]);
    const v1 = service.list(SESSION, { versions: "all" }).find((artifact) => artifact.path === "report.md" && artifact.version === 1)!;
    const opened = await service.open(SESSION, v1.id);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("# Report v1\n");
    expect(opened.info.contentType).toBe("text/markdown");
  });

  it("records failed publications instead of empty successes", async () => {
    agent.files.set("report.md", "ok");
    agent.rejected = [{ path: "link", reason: "symbolic link" }];
    await turn("turn-1");
    await expect(service.waitForPublication(SESSION)).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "publication_failed") && /symbolic link/.test((error as Error).message));
    expect(service.list(SESSION)).toEqual([]);

    agent.rejected = [];
    agent.mutate = "report.md";
    await turn("turn-2");
    await expect(service.waitForPublication(SESSION, { turnId: "turn-2" })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "publication_failed") && /changed while/.test((error as Error).message));

    agent.mutate = undefined;
    await turn("turn-3", "cancelled");
    await expect(service.waitForPublication(SESSION, { turnId: "turn-3" })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "publication_failed") && /cancelled/.test((error as Error).message));
  });

  it("waits for a running turn and reports timeouts and unknown turns explicitly", async () => {
    await expect(service.waitForPublication(SESSION)).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "not_found"));
    service.turnStarted(SESSION, "turn-1");
    await expect(service.waitForPublication(SESSION, { timeoutMs: 50 })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "timeout"));
    agent.files.set("out.txt", "x");
    const waiting = service.waitForPublication(SESSION, { timeoutMs: 5000 });
    const ids = service.turnsCompleted(SESSION, "completed");
    await service.publish(SESSION, ids, "completed");
    expect((await waiting).artifacts.map((artifact) => artifact.path)).toEqual(["out.txt"]);
    await expect(service.waitForPublication(SESSION, { turnId: "nope" })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "not_found"));
  });

  it("deletes a session's artifacts", async () => {
    agent.files.set("a.txt", "a");
    await turn("turn-1");
    await service.deleteSession(SESSION);
    expect(service.list(SESSION)).toEqual([]);
  });

  it("maps common content types", () => {
    expect(contentTypeFor("report.md")).toBe("text/markdown");
    expect(contentTypeFor("chart.PNG")).toBe("image/png");
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
  });
});
