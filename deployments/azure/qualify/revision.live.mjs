// Real revision-replacement check. Prepare before `aspire deploy`, then verify after the new gateway is ready:
//   node deployments/azure/qualify/revision.live.mjs prepare <gateway-url> <record.json>
//   node deployments/azure/qualify/revision.live.mjs verify <record.json>
// Only test-created sessions are deleted. The record contains their IDs and synthetic markers, never credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { ManagedCopilot } from "../../../libraries/sdk/dist/index.js";

const { approveAll } = createRequire(new URL("../../../libraries/sdk/package.json", import.meta.url))("@github/copilot-sdk");
const options = { model: "claude-sonnet-5", onPermissionRequest: approveAll };
const [mode, first, second] = process.argv.slice(2);
const markerPath = "qualify/revision-marker.txt";

if (mode === "prepare") {
  if (!first || !second) throw new Error("Usage: revision.live.mjs prepare <gateway-url> <record.json>");
  const record = { url: first, preparedAt: new Date().toISOString(), sessions: [] };
  const managed = await ManagedCopilot.connect({ url: first });
  try {
    for (const environment of ["chat", "coder", "coder"]) {
      const client = await managed.client(environment);
      const session = await client.createSession(options);
      const marker = `azure-revision-${randomUUID()}`;
      const item = { id: session.sessionId, environment, marker };
      record.sessions.push(item);
      await writeFile(second, JSON.stringify(record, null, 2), { mode: 0o600 });
      if (environment === "chat") {
        await session.sendAndWait({ prompt: `Remember this exact test marker for my next message: ${marker}. Reply only STORED.` }, 180_000);
      } else {
        await managed.files(session).write(markerPath, marker);
        item.sandboxId = (await managed.sessions.get(session.sessionId)).sandbox?.id;
        assert.ok(item.sandboxId, "isolated canary must have a sandbox");
      }
      await writeFile(second, JSON.stringify(record, null, 2), { mode: 0o600 });
    }
    assert.notEqual(record.sessions[1].sandboxId, record.sessions[2].sandboxId, "sessions must have distinct sandboxes");
    console.log(JSON.stringify({ check: "revision-canaries-prepared", passed: true, sessionCount: record.sessions.length }));
  } finally {
    await managed.close();
  }
} else if (mode === "verify") {
  if (!first) throw new Error("Usage: revision.live.mjs verify <record.json>");
  const record = JSON.parse(await readFile(first, "utf8"));
  const managed = await ManagedCopilot.connect({ url: record.url });
  try {
    for (const item of record.sessions) {
      const client = await managed.client(item.environment);
      const session = await client.resumeSession(item.id, options);
      assert.equal(session.sessionId, item.id, "revision change must preserve session identity");
      if (item.environment === "chat") {
        const reply = await session.sendAndWait({ prompt: "What exact test marker did I ask you to remember? Reply only with that marker." }, 180_000);
        assert.ok(reply?.data.content.includes(item.marker), "shared runtime must remember pre-deployment history");
      } else {
        assert.equal((await managed.files(session).read(markerPath)).trim(), item.marker, "each workspace must retain its own marker");
        assert.equal((await managed.sessions.get(item.id)).sandbox?.id, item.sandboxId, "sandbox identity must survive gateway replacement");
      }
      console.log(JSON.stringify({ check: "revision-session-restored", passed: true, sessionId: item.id, environment: item.environment }));
    }
    for (const item of record.sessions) await managed.sessions.delete(item.id);
    record.verifiedAt = new Date().toISOString();
    record.cleanedUp = true;
    await writeFile(first, JSON.stringify(record, null, 2), { mode: 0o600 });
  } finally {
    await managed.close();
  }
} else {
  throw new Error("Choose prepare or verify.");
}
