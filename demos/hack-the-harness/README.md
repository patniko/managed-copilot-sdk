# Hack the Harness

This demo shows five agent deployment architectures, each trading off flexibility, power and operating cost
differently. They all run the same staff assistant app, built on the stock Copilot SDK:

1. **Shared**: every session on one runtime, no sandboxes.
2. **Isolated**: every session in its own sandbox.
3. **Promotable**: sessions move into a sandbox when needed.
4. **Direct**: agent stays shared; only its tools are sandboxed.
5. **Workers**: disposable worker sandboxes for each job.

It runs locally only, and accepts any username and password.

## Quick run

From the repository root:

```sh
pnpm install
pnpm build
aspire run
```

Open http://localhost:7415, sign in with any username and password, and select the gamepad button to switch to the 3D
office.

## Agent deployment architectures

The code starts out in the Shared architecture with the agent's shell and file tools turned off. Each step below
changes the previous one. After making a step's changes, run `pnpm build`, restart `aspire run`, and start a new chat.

To try each step, select **New chat**, attach [`demo-data/conference-leads.xlsx`](demo-data/conference-leads.xlsx) with
the paperclip, and ask:

> Look at this spreadsheet and make a cleaned up version that includes only people who live in one of the cities
> where we have a US office and showed interest in space travel.

Containers show up in Docker Desktop, and each one's **Files** tab shows what's inside it. On the host, the shared
runtime keeps its files under `.managed-copilot/data/runtime/shared` in the repository root: each session's state
(including `events.jsonl`) in `copilot-home/session-state/<session ID>`, and its working directory in
`workspaces/<session ID>`. Uploads stay in the app until the agent copies them into its workspace with the
`copy_upload` tool, and `share_file` is the tool the UI shows as a download card.

### 1. Shared

Every chat is a session on one shared runtime with no sandbox, which is the cheapest option, but once the agent can
run commands, nothing stops it reading every other session on the machine.

**To run**

As it is, the agent has no shell or file tools, so it can chat but can't work on the spreadsheet. To give it those
tools, change this in `apphost.mts`:

```diff
         type: "shared",
-        unsafeHostTools: false,
+        unsafeHostTools: true,
```

This is only for a demo on your own machine: never turn on `unsafeHostTools` for real users. The agent's commands run
on your machine, so it needs Python with `openpyxl`.

**What to observe**

- No containers appear.
- Each chat's `events.jsonl` and uploads sit side by side with every other user's on the host.
- Tell one chat a secret, then sign in as someone else and ask the agent to search nearby folders for it: it finds it.

### 2. Isolated

Every chat gets its own sandbox holding its runtime, history and files, so one user's agent can no longer reach
another's, at the cost of a container for every chat, even ones that only ask a quick question.

**To run**

In `apphost.mts`:

```diff
-        type: "shared",
-        unsafeHostTools: true,
+        type: "isolated",
+        size: "small",
+        image: here("sandbox-image"),
```

**What to observe**

- A container appears for each chat as soon as it starts.
- Inside it, uploads and the agent's outputs are under `/workspace`, and the chat's `events.jsonl` is under
  `/var/lib/managed-copilot/runtime/session-state/<session ID>`.
- The secret search from Shared finds nothing outside the chat's own sandbox.
- Deleting the chat removes its container and volumes.

### 3. Promotable

Chats start on the shared runtime and move into their own sandbox only when they need to run code, so quick questions
cost no container, but once moved, the whole session stays in that container until the chat is deleted.

**To run**

In `apphost.mts`:

```diff
-        type: "isolated",
-        size: "small",
-        image: here("sandbox-image"),
+        type: "promotable",
+        promoteTo: HACK_THE_HARNESS_WORKER_ENVIRONMENT,
```

The platform gives the agent a `request_sandbox` tool, which it calls when it needs to run code.

**What to observe**

- A plain question creates no container, and its `events.jsonl` is in the shared runtime's folder on the host.
- Asking for the spreadsheet job makes the agent call `request_sandbox`, which creates a container, and the platform
  console shows a `session.promoted` event with the same session ID.
- The session's `events.jsonl`, including the earlier question, is now in the container under
  `/var/lib/managed-copilot/runtime/session-state/<session ID>`, next to the upload in `/workspace`.
- The container stays until the chat is deleted.

### 4. Direct (head and hands)

The agent always stays on the shared runtime and only its shell and file commands run in a sandbox, so the app can
throw that workspace away while the conversation carries on, but the app now has to keep track of that workspace.

**To run**

In `apphost.mts`:

```diff
-        type: "promotable",
-        promoteTo: HACK_THE_HARNESS_WORKER_ENVIRONMENT,
+        type: "orchestrator",
+        execution: "direct",
+        workers: [HACK_THE_HARNESS_WORKER_ENVIRONMENT],
```

In `src/app/server/main.ts`, have `getWorkspace` find the workspace sandbox instead of the session itself:

```diff
-  if (true) {
+  if (false) {
     return sessionId;
```

And in `src/app/web-ui/App.tsx`, show the **Release workspace** button:

```diff
-            {false && activeId && (
+            {true && activeId && (
```

**What to observe**

- No container appears until the agent's first shell or file command.
- The container holds only `/workspace` (the copied upload, the agent's script and its output). There's no runtime in
  it, and the chat's `events.jsonl` stays in the shared runtime's folder on the host.
- **Release workspace** removes the container. The download still works, and the next message carries on with the
  full history, starting a new container at its next command.
- Uploads and shared files are kept in the app's memory, so they're lost when the app restarts.

### 5. Workers

The assistant stays on the shared runtime and hands each job to a worker agent in its own clean sandbox, which runs in
parallel with other jobs and is deleted when done, so nothing lingers between jobs, at the cost of more orchestration.

**To run**

In `apphost.mts`:

```diff
         type: "orchestrator",
-        execution: "direct",
         workers: [HACK_THE_HARNESS_WORKER_ENVIRONMENT],
+        maxWorkers: 2,
```

In `src/app/server/main.ts`, switch `agentTools` to the tools that move files to and from workers:

```diff
-  if (false) {
+  if (true) {
     return [
       // Uploads stay in the app until the agent sends them to a worker.
```

**What to observe**

- No container appears for a plain question. When a job starts, a worker container appears, and the platform console
  shows it as a child session of the chat.
- Inside the worker's container, its input and output are under `/workspace`, and the worker's own `events.jsonl` is
  under `/var/lib/managed-copilot/runtime/session-state/<worker session ID>`. The chat's own `events.jsonl` stays in the
  shared runtime's folder on the host.
- Two jobs at once run as two containers side by side.
- Each container disappears once its result comes back as a download card.
- Uploads and shared files are kept in the app's memory, so they're lost when the app restarts.

## Third-party notices

The chat components are adapted from [github/copilot-sdk-server-sample](https://github.com/github/copilot-sdk-server-sample)
under the MIT license; see [third-party notices](THIRD_PARTY_NOTICES.md). The office models are from
[Kenney](https://kenney.nl) under CC0; see [their license](src/app/web-ui/office/assets/LICENSE.txt).
