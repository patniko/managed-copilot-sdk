import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { approveAll, defineTool, type CopilotClient, type CopilotSession, type MessageOptions, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { auth, type User } from "./auth.js";
import { npcPersona, npcSessionId } from "./npcs.js";
import { DEFAULT_STAGE, findStage, STAGES, type Stage } from "./stages.js";

// The app connects to the platform once, as itself. Users sign in to the app, not to GitHub. The AppHost gives the
// platform's URL in MANAGED_COPILOT_URL.
const managed = await ManagedCopilot.connect({ clientName: "hack-the-harness" });

// One client per stage: each stage is its own environment, so a chat's stage is the environment it's created in.
const clients = new Map<string, CopilotClient>();
for (const stage of STAGES) {
  clients.set(stage.id, await managed.client(stage.environment));
}

const instructions = `You are a helpful internal staff assistant at Contoso, a software company.

Contoso has 20 offices:
- United States: San Francisco, New York, Seattle, Austin, Boston
- Europe: London, Dublin, Berlin, Amsterdam, Paris, Stockholm, Zurich
- Elsewhere: Tel Aviv, Bangalore, Singapore, Tokyo, Sydney, Toronto, São Paulo, Mexico City`;

// Everything but the tools, which depend on the stage.
const config: SessionConfig = {
  model: "claude-sonnet-5",
  streaming: true,
  systemMessage: { mode: "append", content: instructions },
  onPermissionRequest: approveAll,
};

// Uploaded and shared files, by session ID and path.
const files = new Map<string, Buffer>();

// Waits until the named worker has finished its first turn, so its sandbox is ready for files.
async function waitForWorker(sessionId: string, name: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const worker = (await managed.workers(sessionId).list()).find(w => w.role !== "hands" && w.name === name && w.state !== "stopped");
    if (worker?.state === "idle") {
      return worker.id;
    }
    if (!worker || worker.state === "failed") {
      throw new Error(`There is no running worker named ${name}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker ${name} is still busy.`);
}

async function findWorker(sessionId: string, name: string) {
  const worker = (await managed.workers(sessionId).list()).find(w => w.role !== "hands" && w.name === name && w.state !== "stopped");
  if (!worker) {
    throw new Error(`There is no running worker named ${name}.`);
  }
  return worker.id;
}

// The tools the agent uses to get files in and out of wherever its commands run. Uploads stay in the app until the
// agent asks for them, and shared files stay in the app too, so downloads still work once a sandbox is gone.
function agentTools(stage: Stage) {
  const tools = [];

  // Its own commands run in its session, or in a workspace sandbox (Direct and Mixed): copy uploads in there.
  if (stage.workspace) {
    tools.push(
      defineTool<{ path: string }>("copy_upload", {
        description: "Copy a file the user uploaded (a <file> element in their message) into your workspace, at that path, so your shell and file tools can use it.",
        parameters: { type: "object", properties: { path: { type: "string", description: "The file's path" } }, required: ["path"] },
        skipPermission: true,
        defer: "never",
        handler: async ({ path }, { sessionId }) => {
          const workspace = await getWorkspace(stage, sessionId);
          if (!workspace) {
            return "Your workspace starts at your first shell or file command. Run one, then try again.";
          }
          const bytes = files.get(`${sessionId}/${path.replace(/^\/workspace\//, "")}`);
          if (!bytes) {
            return `There is no uploaded file ${path}.`;
          }
          await managed.files(workspace).write(path, bytes);
          return `Copied ${path} into your workspace.`;
        },
      }),
    );
  }

  // It hands jobs to workers (Workers and Mixed): send uploads to a named worker instead.
  if (stage.workers) {
    tools.push(
      defineTool<{ worker: string; paths: string[] }>("send_files", {
        description: [
          "Copy files the user uploaded (<file> elements in their message) into a worker's /workspace, at the same paths.",
          "Start the worker with a task that only says to wait for your next message, call this, then message the worker with its real task.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            worker: { type: "string", description: "The worker's name" },
            paths: { type: "array", items: { type: "string" }, description: "The files' paths" },
          },
          required: ["worker", "paths"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ worker, paths }, { sessionId }) => {
          const id = await waitForWorker(sessionId, worker);
          for (const path of paths) {
            await managed.files(id).write(path, files.get(`${sessionId}/${path}`)!);
          }
          return `Copied ${paths.join(", ")} into ${worker}'s /workspace.`;
        },
      }),
    );
  }

  // The UI shows each shared file as a card the user can download.
  const fromWorker = stage.workers;
  const fromWorkspace = Boolean(stage.workspace);
  tools.push(
    defineTool<{ path: string; worker?: string }>("share_file", {
      description: fromWorker
        ? fromWorkspace
          ? "Give the user a file, as a download in the chat. Name the worker that made it, or leave worker out for a file in your own workspace. Call it once the file is final, before stopping any worker."
          : "Give the user a file a worker made, as a download in the chat. Call it once the file is final, before stopping the worker."
        : "Give the user a file you made, as a download in the chat. Call it once the file is final.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: fromWorker ? "The file's path in its /workspace" : "The file's path" },
          ...(fromWorker ? { worker: { type: "string", description: fromWorkspace ? "The worker's name, if a worker made it" : "The worker's name" } } : {}),
        },
        required: fromWorker && !fromWorkspace ? ["worker", "path"] : ["path"],
      },
      skipPermission: true,
      defer: "never",
      handler: async ({ path, worker }, { sessionId }) => {
        const source = worker ? await findWorker(sessionId, worker) : await getWorkspace(stage, sessionId);
        if (!source) {
          return "You have no workspace yet, so there is no file to share.";
        }
        const bytes = await managed.files(source).readBytes(path);
        files.set(worker ? `${sessionId}/${worker}/${path}` : `${sessionId}/${path}`, Buffer.from(bytes));
        return `Shared ${basename(path)} (${bytes.length} bytes) with the user.`;
      },
    }),
  );

  return tools;
}

// Finds where the agent's shell and file commands run, as a session ID for managed.files().
async function getWorkspace(stage: Stage, sessionId: string) {
  return stage.workspace === "hands" ? getHands(sessionId) : sessionId;
}

// In the Direct and Mixed architectures, the agent's shell and file commands run in a workspace-only sandbox (its
// "hands"), which the platform creates at the first one it uses.
async function getHands(sessionId: string) {
  const workers = await managed.workers(sessionId).list();
  return workers.find(worker => worker.role === "hands" && worker.state !== "stopped")?.id;
}

// The stage of an existing chat, from the environment it was created in.
async function stageOf(sessionId: string) {
  const { environment } = await managed.sessions.get(sessionId);
  const stage = STAGES.find(candidate => candidate.environment === environment);
  if (!stage) {
    throw Object.assign(new Error(`This chat is in ${environment}, which isn't one of the demo's stages.`), { status: 404 });
  }
  return stage;
}

function requestedStage(value: unknown) {
  const stage = findStage(value ?? DEFAULT_STAGE);
  if (!stage) {
    throw Object.assign(new Error(`Unknown stage: ${String(value)}. Pick one of ${STAGES.map(s => s.id).join(", ")}.`), { status: 400 });
  }
  return stage;
}

// Each session ID starts with its user's ID, so the app knows whose session it is.
function owns(user: User, sessionId: string) {
  return sessionId.startsWith(`${user.id}-`);
}

// Browsers listening for session events, and whose events they receive.
const listeners = new Set<{ user: User; send: (sessionId: string, event: SessionEvent) => void }>();

// Creates or resumes each SDK session once, then reuses it. Pass the stage to create it in.
const sessions = new Map<string, Promise<CopilotSession>>();

function getSession(id: string, createIn?: Stage): Promise<CopilotSession> {
  let session = sessions.get(id);

  if (!session) {
    const onEvent = (event: SessionEvent) => listeners.forEach(listener => owns(listener.user, id) && listener.send(id, event));
    // Office characters also get their persona.
    const persona = npcPersona(id);
    const systemMessage = persona ? { mode: "append" as const, content: `${instructions}\n\n${persona}` } : config.systemMessage;
    session = (async () => {
      const stage = createIn ?? (await stageOf(id));
      const client = clients.get(stage.id)!;
      const options = { ...config, systemMessage, tools: agentTools(stage), onEvent };
      return createIn ? client.createSession({ ...options, sessionId: id }) : client.resumeSession(id, options);
    })();
    session.catch(() => sessions.delete(id));
    sessions.set(id, session);
  }

  return session;
}

const app = express();

// The browser sends attachments inline as base64, so allow large request bodies.
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Sign-in routes. Everything after this has req.user.
app.use(auth());

// Users can only use their own sessions.
app.param("id", (req, res, next, id: string) => {
  if (owns(req.user, id)) {
    next();
  } else {
    res.status(404).json({ message: "Chat not found" });
  }
});

// List, create, and delete sessions. Each stage lists only its own chats.
app.get("/api/sessions", async (req, res) => {
  const stage = requestedStage(req.query.stage);
  const all = await managed.sessions.list({ environment: stage.environment });
  res.json(all.filter(session => owns(req.user, session.id)));
});

app.post("/api/sessions", async (req, res) => {
  const stage = requestedStage(req.body?.stage);
  const id = req.body?.npc ? npcSessionId(req.user.id, req.body.npc) : `${req.user.id}-${randomUUID()}`;
  await getSession(id, stage);
  res.status(201).json(await managed.sessions.get(id));
});

app.delete("/api/sessions/:id", async (req, res) => {
  const stage = await stageOf(req.params.id);
  await clients.get(stage.id)!.deleteSession(req.params.id);
  sessions.delete(req.params.id);
  res.status(204).end();
});

// Read a session's history, send it a message, or cancel its response.
app.get("/api/sessions/:id/events", async (req, res) => {
  const session = await getSession(req.params.id);
  res.json(await session.getEvents());
});

app.post("/api/sessions/:id/messages", async (req, res) => {
  const session = await getSession(req.params.id);
  const { prompt, attachments = [] }: MessageOptions = req.body;

  // Keep attached files in the app, and tell the agent their path with a <file> element before the prompt. The UI
  // shows these as file cards.
  let elements = "";
  for (const attachment of attachments) {
    if (attachment.type === "blob") {
      const path = `uploads/${basename(attachment.displayName ?? "file")}`;
      files.set(`${session.sessionId}/${path}`, Buffer.from(attachment.data, "base64"));
      elements += `<file path="${path}" />\n`;
    }
  }

  await session.send({ prompt: elements + prompt });
  res.status(204).end();
});

// Download a file the user uploaded or the agent shared.
app.get("/api/sessions/:id/files", async (req, res) => {
  const path = String(req.query.path);
  const bytes = files.get(req.query.worker ? `${req.params.id}/${req.query.worker}/${path}` : `${req.params.id}/${path}`);
  if (bytes) {
    res.attachment(basename(path)).send(bytes);
  } else {
    res.status(404).json({ message: "File not found" });
  }
});

// Delete the session's workspace sandbox, in the Direct and Mixed architectures. Its next shell or file command starts
// a new one.
app.post("/api/sessions/:id/release", async (req, res) => {
  const hands = await getHands(req.params.id);
  if (hands) {
    await managed.sessions.delete(hands);
  }
  res.status(204).end();
});

app.post("/api/sessions/:id/cancel", async (req, res) => {
  const session = await getSession(req.params.id);
  await session.abort();
  res.status(204).end();
});

// Stream the user's live session events to the browser using server-sent events.
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  res.flushHeaders();

  const listener = {
    user: req.user,
    send: (sessionId: string, event: SessionEvent) => res.write(`data: ${JSON.stringify({ sessionId, event })}\n\n`),
  };
  listeners.add(listener);
  req.on("close", () => listeners.delete(listener));
});

// Serve the React UI, built by `pnpm build`, from this same web application.
const webRoot = fileURLToPath(new URL("../web", import.meta.url));
app.use(express.static(webRoot));
app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: webRoot }));

// Report errors to the UI.
const onError: ErrorRequestHandler = (error, _req, res, _next) => {
  res.status(error.status ?? 500).json({ message: error.message });
};

app.use(onError);

const port = Number(process.env.PORT ?? 7415);
app.listen(port, "127.0.0.1", () => {
  console.log(`Staff assistant: http://127.0.0.1:${port}`);
});
