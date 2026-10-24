import { approveAll } from "@github/copilot-sdk";
import { ROUTES, type AttachMaterial } from "@managed-copilot/protocol";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { HttpClient, resolveToken } from "@managed-copilot/sdk/internal";
import { WebSocket } from "ws";
import { snippet } from "./harness.js";

/** Drives the attach path as an AHP client when there is no terminal to run Copilot CLI in. */
async function probeAttach(url: string, sessionId: string): Promise<{ catalog: string[]; creationDenied: boolean }> {
  const material = await new HttpClient(url, await resolveToken()).post<AttachMaterial>(ROUTES.attach(sessionId));
  const socket = new WebSocket(material.url.replace(/^wss?:\/\/[^/]+/, url.replace(/^http/, "ws")), { headers: { authorization: `Bearer ${material.token}` } });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => reject(new Error(`attach refused (HTTP ${response.statusCode})`)));
  });
  const pending = new Map<number, (message: { result?: any; error?: any }) => void>();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: unknown };
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const call = (method: string, params: object) =>
    new Promise<{ result?: any; error?: any }>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  try {
    await call("initialize", { channel: "ahp-root://", protocolVersions: ["0.9.0"], clientId: "managed-copilot-quickstart", initialSubscriptions: [] });
    const listed = await call("listSessions", { channel: "ahp-root://" });
    const created = await call("createSession", { channel: `ahp-session:/${crypto.randomUUID()}`, config: { mode: "interactive" } });
    return { catalog: (listed.result?.items ?? []).map((item: { resource: string }) => item.resource), creationDenied: Boolean(created.error) };
  } finally {
    socket.close();
  }
}

export default snippet(import.meta.url, { title: "Open a session in Copilot CLI", section: "spec §14", requires: ["attach.cli"] }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  const session = await managed.createSession({ environment: "chat", model: "claude-sonnet-5", onPermissionRequest: approveAll });
  await session.sendAndWait({ prompt: "Remember the codeword PELICAN. Reply with exactly: ready" });

  if (t.interactive) {
    console.log("Ask Copilot CLI for the codeword, then /exit to come back.");
    const code = await managed.openCli(session); // runs Copilot CLI in this terminal, attached to the live session
    t.check(code === 0, "Copilot CLI attached to the live session and exited cleanly");
    return;
  }

  // Acceptance checks (no terminal): the same owner-scoped attach path, driven as an AHP client.
  t.cleanup(() => managed.sessions.delete(session.sessionId));
  const { catalog, creationDenied } = await probeAttach(managed.url, session.sessionId);
  t.check(catalog.length === 1 && catalog[0] === `ahp-session:/${session.sessionId}`, "the attach socket publishes exactly this session, not the runtime's catalog");
  t.check(creationDenied, "attached clients cannot create sessions outside admission");
  console.log(`Attach interactively with: npx managed-copilot attach ${session.sessionId.slice(0, 8)}`);
});
