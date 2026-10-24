// Dev probe: resume the assistant conversation read-only and print the persisted event type sequence.
import { ManagedCopilot } from "@managed-copilot/sdk";

const sessionId = process.argv[2];
const managed = await ManagedCopilot.connect({ clientName: "assistant-probe" });
const client = await managed.client("assistant");
const session = await client.resumeSession(sessionId, { suppressResumeEvent: true, onPermissionRequest: () => ({ kind: "no-result" }) });
const events = await session.getEvents();
console.log(events.map((e) => `${e.type}${e.ephemeral ? "(eph)" : ""}`).join("\n"));
await session.disconnect();
await managed.close();
