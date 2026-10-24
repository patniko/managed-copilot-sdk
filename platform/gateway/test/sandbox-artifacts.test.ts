import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError, ManagedCopilotError, type SandboxOutputsManifest } from "@managed-copilot/protocol";
import { openDatabase } from "../src/db.js";
import { createLogger, type Logger } from "../src/log.js";
import type { SandboxAgentClient } from "../src/modules/sandbox/agent-client.js";
import { ArtifactService, contentTypeFor } from "../src/modules/sandbox/artifacts.js";
import { SandboxStore } from "../src/modules/sandbox/store.js";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A logger that records what was written at each level. */
function recordingLogger(): { log: Logger; lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void lines.push({ level, message });
  const log: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log };
  return { log, lines };
}

class FakeAgent {
  files = new Map<string, string>();
  rejected: { path: string; reason: string }[] = [];
  mutate: string | undefined;
  gate: Promise<void> | undefined;
  async outputsManifest(): Promise<SandboxOutputsManifest> {
    if (this.gate) await this.gate;
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
  let db: ReturnType<typeof openDatabase>;
  let agent: FakeAgent;
  let events: { type: string; data: Record<string, unknown> }[];
  let service: ArtifactService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-artifacts-"));
    db = openDatabase(":memory:");
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

  it("never attributes outputs to a turn once a later turn may have changed them", async () => {
    agent.files.set("report.md", "turn 1");
    let release!: () => void;
    agent.gate = new Promise((resolve) => (release = resolve));
    service.turnStarted(SESSION, "turn-1");
    const publishing = service.publish(SESSION, service.turnsCompleted(SESSION, "completed"), "completed");
    service.turnStarted(SESSION, "turn-2");
    agent.files.set("report.md", "turn 2 (unfinished)");
    release();
    await publishing;
    await expect(service.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toSatisfy(
      (error: unknown) => isManagedCopilotError(error, "publication_failed") && /Another turn started/.test((error as Error).message),
    );
    expect(service.list(SESSION)).toEqual([]);
  });

  it("fails publications a gateway restart interrupted instead of leaving them pending", async () => {
    service.turnStarted(SESSION, "turn-1");
    service.turnsCompleted(SESSION, "completed");
    expect(service.failInterruptedTurns()).toBe(1);
    await expect(service.waitForPublication(SESSION, { turnId: "turn-1", timeoutMs: 100 })).rejects.toSatisfy(
      (error: unknown) => isManagedCopilotError(error, "publication_failed") && /restarted/.test((error as Error).message),
    );
  });

  it("deletes a session's artifacts", async () => {
    agent.files.set("a.txt", "a");
    await turn("turn-1");
    await service.deleteSession(SESSION);
    expect(service.list(SESSION)).toEqual([]);
  });

  it("announces only new versions and records a deleted session's publication with a clear reason", async () => {
    agent.files.set("a.txt", "a");
    await turn("turn-1");
    await turn("turn-2");
    expect((await service.waitForPublication(SESSION, { turnId: "turn-2" })).artifacts.map((artifact) => `${artifact.path}@${artifact.version}`)).toEqual(["a.txt@1"]);
    expect(events).toHaveLength(1);

    let gone = false;
    const deleting = new ArtifactService({
      db,
      dataDir: dir,
      log: createLogger("test", "error"),
      agentFor: async () => {
        gone = true;
        throw new Error("The sandbox connection failed.");
      },
      track: (_sessionId, work) => work,
      ownerOf: () => 42,
      sessionGone: () => gone,
      events: () => undefined,
    });
    deleting.turnStarted(SESSION, "turn-3");
    await deleting.publish(SESSION, deleting.turnsCompleted(SESSION, "completed"), "completed");
    await expect(deleting.waitForPublication(SESSION, { turnId: "turn-3" })).rejects.toSatisfy(
      (error: unknown) => isManagedCopilotError(error, "publication_failed") && /deleted before its outputs were published/.test((error as Error).message),
    );
  });

  it("maps common content types", () => {
    expect(contentTypeFor("report.md")).toBe("text/markdown");
    expect(contentTypeFor("chart.PNG")).toBe("image/png");
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
  });

  describe("interrupted publications", () => {
    function interrupted(options: { gone?: () => boolean; settled?: () => Promise<void>; stopping?: () => boolean; agentFor?: () => Promise<SandboxAgentClient> }) {
      const { log, lines } = recordingLogger();
      const artifacts = new ArtifactService({
        db,
        dataDir: dir,
        log,
        agentFor: options.agentFor ?? (async () => agent as unknown as SandboxAgentClient),
        track: (_sessionId, work) => work,
        ownerOf: () => 42,
        ...(options.gone ? { sessionGone: options.gone } : {}),
        ...(options.settled ? { settled: options.settled } : {}),
        ...(options.stopping ? { stopping: options.stopping } : {}),
        events: () => undefined,
      });
      const publish = async (turnId: string) => {
        artifacts.turnStarted(SESSION, turnId);
        await artifacts.publish(SESSION, artifacts.turnsCompleted(SESSION, "completed"), "completed");
      };
      return { artifacts, lines, publish };
    }
    const connectionFailed = async (): Promise<SandboxAgentClient> => {
      throw new ManagedCopilotError("capability_unavailable", "The sandbox connection failed.");
    };

    it("records a deletion that removed the turn's records as deleted, even while the sandbox looks alive", async () => {
      const { artifacts, lines, publish } = interrupted({ gone: () => false });
      agent.files.set("a.txt", "a");
      let release!: () => void;
      agent.gate = new Promise((resolve) => (release = resolve));
      const publishing = publish("turn-1");
      await artifacts.deleteSession(SESSION);
      release();
      await publishing;
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
      expect(lines).toContainEqual({ level: "info", message: "Skipped publishing outputs of a session that is being deleted" });
      expect(artifacts.list(SESSION)).toEqual([]);
    });

    it("waits for queued sandbox work (such as the delete) before classifying a failure", async () => {
      let gone = false;
      const { artifacts, lines, publish } = interrupted({
        gone: () => gone,
        settled: async () => {
          gone = true;
        },
        agentFor: connectionFailed,
      });
      await publish("turn-1");
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "publication_failed") && /deleted before its outputs were published/.test((error as Error).message),
      );
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    });

    it("records a publication cut off by gateway shutdown as such, at info", async () => {
      const { artifacts, lines, publish } = interrupted({ gone: () => false, stopping: () => true, agentFor: connectionFailed });
      await publish("turn-1");
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "publication_failed") && /gateway stopped/.test((error as Error).message),
      );
      expect(lines).toContainEqual({ level: "info", message: "Did not publish a turn's outputs because the gateway is stopping" });
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    });

    it("judges a shutdown interruption when the failure surfaced, not after waiting out queued sandbox work", async () => {
      // The failure surfaces during the shutdown drain, while compute is still up; queued sandbox work (another operation
      // holding the session's lock) then outlasts the drain, and shutdown starts stopping compute during the wait.
      let stoppingCompute = false;
      const { artifacts, lines, publish } = interrupted({
        gone: () => false,
        stopping: () => stoppingCompute,
        settled: async () => {
          stoppingCompute = true;
        },
        agentFor: connectionFailed,
      });
      await publish("turn-1");
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toThrow(/^The sandbox connection failed\.$/);
      expect(lines).toContainEqual({ level: "warn", message: "Publication failed" });
      expect(lines.some((line) => /gateway is stopping/.test(line.message))).toBe(false);
    });

    it("logs a publication superseded by the caller's next turn at info, and the later turn publishes the outputs", async () => {
      const { artifacts, lines } = interrupted({ gone: () => false, settled: async () => undefined, stopping: () => false });
      agent.files.set("report.md", "turn 1");
      let release!: () => void;
      agent.gate = new Promise((resolve) => (release = resolve));
      artifacts.turnStarted(SESSION, "turn-1");
      const publishing = artifacts.publish(SESSION, artifacts.turnsCompleted(SESSION, "completed"), "completed");
      artifacts.turnStarted(SESSION, "turn-2");
      release();
      await publishing;
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "publication_failed") && /Another turn started/.test((error as Error).message),
      );
      expect(lines).toContainEqual({ level: "info", message: "A later turn started before this turn's outputs were captured; they publish with that turn" });
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);

      agent.gate = undefined;
      agent.files.set("report.md", "turn 2");
      await artifacts.publish(SESSION, artifacts.turnsCompleted(SESSION, "completed"), "completed");
      const later = await artifacts.waitForPublication(SESSION, { turnId: "turn-2" });
      expect(later.artifacts.map((artifact) => `${artifact.path}@${artifact.version}:${artifact.turnId}`)).toEqual(["report.md@1:turn-2"]);
    });

    it("still reports a publication's own failure as a warning", async () => {
      const { artifacts, lines, publish } = interrupted({ gone: () => false, settled: async () => undefined, stopping: () => false, agentFor: connectionFailed });
      await publish("turn-1");
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "publication_failed") && /connection failed/.test((error as Error).message),
      );
      expect(lines).toContainEqual({ level: "warn", message: "Publication failed" });
    });

    it("keeps the reason of a failure the publication decided itself, even once shutdown is stopping compute", async () => {
      const { artifacts, lines, publish } = interrupted({ gone: () => false, settled: async () => undefined, stopping: () => true });
      agent.files.set("ok.txt", "ok");
      agent.rejected = [{ path: "link", reason: "symbolic links are not published" }];
      await publish("turn-1");
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).rejects.toThrow(/outputs\/link \(symbolic links are not published\)/);
      agent.rejected = [];
      agent.mutate = "ok.txt";
      await publish("turn-2");
      await expect(artifacts.waitForPublication(SESSION, { turnId: "turn-2" })).rejects.toThrow(/outputs\/ok\.txt changed while it was being published/);
      expect(lines.filter((line) => line.level === "warn").map((line) => line.message)).toEqual(["Publication failed", "Publication failed"]);
      expect(lines.some((line) => /gateway is stopping/.test(line.message))).toBe(false);
    });

    it("drains publications under way", async () => {
      const { artifacts, publish } = interrupted({});
      expect(await artifacts.drain(10)).toBe(true);
      agent.files.set("a.txt", "a");
      let release!: () => void;
      agent.gate = new Promise((resolve) => (release = resolve));
      const publishing = publish("turn-1");
      expect(await artifacts.drain(50)).toBe(false);
      release();
      expect(await artifacts.drain(5_000)).toBe(true);
      await publishing;
      expect((await artifacts.waitForPublication(SESSION, { turnId: "turn-1" })).state).toBe("published");
    });
  });
});
