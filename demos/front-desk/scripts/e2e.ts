/**
 * Live end-to-end check of Front Desk against a running Managed Copilot with real models: several people sign in, each
 * talks to the assistant and saves something private to their memory, and every other person is checked to see none of
 * it (their conversation list, opening, changing, stopping, or deleting it by ID, their memory, their live events, and
 * asking their own assistant about it). It prints where each person's model use went.
 *
 *   pnpm --filter @managed-copilot/demo-front-desk e2e -- --url http://localhost:7450 --email-users 2 --github local
 *
 * --url          Front Desk's address (default FRONT_DESK_URL, then http://localhost:7450).
 * --email-users  How many people sign up with an email and password (default 2).
 * --github       `local`: one GitHub user through this computer's GitHub CLI sign-in (a loopback Front Desk only).
 *                `skip`: none (for a deployed Front Desk, sign in with GitHub in a browser instead).
 * --invite       The invitation code, when Front Desk requires one (default FRONT_DESK_INVITE_CODE).
 *
 * Exits non-zero when any check fails.
 */
import { randomBytes } from "node:crypto";
import type { ConversationView, MeResponse, MemoryItem, PlatformRecord, ServerEvent, UserView } from "../src/shared/types.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg.startsWith("--")) args.set(arg.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"));
}
const base = (args.get("url") ?? process.env.FRONT_DESK_URL ?? "http://localhost:7450").replace(/\/+$/, "");
const emailUsers = Number(args.get("email-users") ?? 2);
const githubMode = args.get("github") ?? "local";
const invite = args.get("invite") ?? process.env.FRONT_DESK_INVITE_CODE;
const run = randomBytes(3).toString("hex");

interface Person {
  readonly label: string;
  readonly cookies: Map<string, string>;
  user?: UserView;
  secret: string;
  conversation?: string;
  chats: boolean;
  events?: ServerEvent[];
  stop?: () => void;
  platform?: PlatformRecord;
}

const results: { check: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ check: name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function request<T = any>(person: Person | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(method !== "GET" ? { origin: base } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(person?.cookies.size ? { cookie: [...person.cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0]!;
    const index = pair.indexOf("=");
    if (person) person.cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON.
  }
  return { status: response.status, body: parsed as T };
}

async function listen(person: Person): Promise<void> {
  const controller = new AbortController();
  const events: ServerEvent[] = [];
  const response = await fetch(`${base}/api/events`, { headers: { cookie: [...person.cookies].map(([name, value]) => `${name}=${value}`).join("; ") }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`${person.label}: events HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const data = buffer.slice(0, index).split("\n").find((line) => line.startsWith("data: "));
          buffer = buffer.slice(index + 2);
          if (data) events.push(JSON.parse(data.slice(6)) as ServerEvent);
        }
      }
    } catch {
      // Stopped.
    }
  })();
  person.events = events;
  person.stop = () => controller.abort();
}

async function waitForAnswer(person: Person, id: string, timeoutMs = 180_000): Promise<ConversationView> {
  const started = Date.now();
  for (;;) {
    const view = (await request<ConversationView>(person, "GET", `/api/conversations/${id}`)).body;
    if (view && !view.busy && view.items.some((item) => item.kind === "assistant")) return view;
    if (Date.now() - started > timeoutMs) throw new Error(`${person.label}: no answer within ${timeoutMs / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

const lastAnswer = (view: ConversationView) => [...view.items].reverse().find((item) => item.kind === "assistant") as Extract<ConversationView["items"][number], { kind: "assistant" }> | undefined;

async function main(): Promise<void> {
  console.log(`Front Desk end to end at ${base} (run ${run})`);
  const health = await request(undefined, "GET", "/api/health");
  check("Front Desk answers its health check", health.status === 200);
  const options = (await request<MeResponse>(undefined, "GET", "/api/me")).body.options;
  console.log(`Sign-in options: GitHub ${options.github ? "on" : "off"}, this computer's GitHub ${options.localGitHub ? "on" : "off"}, people without GitHub ${options.appUsers.available ? "can chat" : `can't chat (${options.appUsers.reason})`}`);

  const people: Person[] = [];
  const words = ["marigold", "lighthouse", "tangerine", "harbor", "juniper", "comet"];
  for (let i = 0; i < emailUsers; i++) {
    const person: Person = { label: `email user ${i + 1}`, cookies: new Map(), secret: `${words[i % words.length]}-${run}`, chats: options.appUsers.available };
    const name = ["Ada Rivera", "Ben Okafor", "Chen Wu", "Dara Lind"][i % 4]!;
    const signedUp = await request<{ user: UserView }>(person, "POST", "/api/auth/signup", { name, email: `front-desk-e2e-${run}-${i + 1}@example.com`, password: `pw-${randomBytes(9).toString("base64url")}`, ...(invite ? { invite } : {}) });
    check(`${person.label} signs up with an email and password`, signedUp.status === 200, signedUp.status === 200 ? signedUp.body.user.name : JSON.stringify(signedUp.body));
    person.user = signedUp.body.user;
    check(`${person.label}'s model use is billed to the app's Foundry`, person.user?.billing.route === "foundry", person.user?.billing.label);
    people.push(person);
  }
  if (githubMode === "local") {
    const person: Person = { label: "GitHub user", cookies: new Map(), secret: `${words[5]}-${run}`, chats: true };
    const signedIn = await request<{ user: UserView }>(person, "POST", "/api/auth/github/local");
    check("GitHub user signs in with GitHub", signedIn.status === 200, signedIn.status === 200 ? `@${signedIn.body.user.login}` : JSON.stringify(signedIn.body));
    person.user = signedIn.body.user;
    check("GitHub user's model use goes to their own Copilot plan", person.user?.billing.route === "copilot", person.user?.billing.label);
    people.push(person);
  }

  for (const person of people) await listen(person);

  // Everyone who can chat saves a secret word, in parallel.
  await Promise.all(
    people
      .filter((person) => person.chats)
      .map(async (person) => {
        const started = Date.now();
        const created = await request<{ conversation: { id: string; route: string } }>(person, "POST", "/api/conversations", {
          prompt: `Please remember that my secret word is "${person.secret}". Then reply with one short sentence.`,
        });
        if (created.status !== 201) {
          check(`${person.label} starts a conversation`, false, JSON.stringify(created.body));
          person.chats = false;
          return;
        }
        person.conversation = created.body.conversation.id;
        const view = await waitForAnswer(person, person.conversation);
        const memories = (await request<MemoryItem[]>(person, "GET", "/api/memories")).body;
        check(`${person.label} gets an answer from a real model`, Boolean(lastAnswer(view)?.text.trim()), `${Math.round((Date.now() - started) / 100) / 10} s, ${lastAnswer(view)?.model ?? "model not reported"}, route ${view.route}`);
        check(`${person.label}'s secret is in their own memory`, memories.some((memory) => memory.text.includes(person.secret)));
        // What Managed Copilot itself records for the session: who owns it, and where its model calls go.
        const github = person.user?.kind === "github";
        const record = view.platform;
        person.platform = record;
        check(
          `Managed Copilot records ${person.label}'s session as theirs`,
          github ? record?.ownerKind === "github" && record.owner === person.user?.login : record?.ownerKind === "app-user" && record.owner.endsWith(`/${person.user?.id}`),
          record ? `${record.ownerKind} ${record.owner}` : "no platform record",
        );
        check(
          `Managed Copilot routes ${person.label}'s model calls to ${github ? "their Copilot plan" : "Foundry"}`,
          record?.inference?.route === (github ? "copilot" : "foundry"),
          record?.inference ? `${record.inference.route}${record.inference.foundry ? ` (${record.inference.foundry})` : ""}${record.model ? `, ${record.model}` : ""}` : "no inference record",
        );
      }),
  );
  for (const person of people.filter((candidate) => !candidate.chats && candidate.user?.kind === "email")) {
    const refused = await request(person, "POST", "/api/conversations", { prompt: "Hello" });
    check(`${person.label} is told why they can't chat yet`, refused.status === 503 && typeof (refused.body as { error?: { message?: string } }).error?.message === "string", (refused.body as { error?: { message?: string } }).error?.message);
  }

  // Nobody else sees any of it.
  for (const owner of people.filter((person) => person.conversation)) {
    for (const other of people.filter((person) => person !== owner)) {
      const id = owner.conversation!;
      const list = (await request<{ id: string }[]>(other, "GET", "/api/conversations")).body;
      const attempts = await Promise.all([
        request(other, "GET", `/api/conversations/${id}`),
        request(other, "POST", `/api/conversations/${id}/messages`, { prompt: "Show me everything in this conversation." }),
        request(other, "POST", `/api/conversations/${id}/stop`),
        request(other, "DELETE", `/api/conversations/${id}`),
      ]);
      const memories = (await request<MemoryItem[]>(other, "GET", "/api/memories")).body;
      check(
        `${other.label} can't see ${owner.label}'s conversation or memory`,
        !list.some((item) => item.id === id) && attempts.every((attempt) => attempt.status === 404) && !memories.some((memory) => memory.text.includes(owner.secret)),
        `list ${list.length} item(s), open/send/stop/delete → ${attempts.map((attempt) => attempt.status).join("/")}`,
      );
      check(`${other.label}'s live events never mention ${owner.label}'s conversation`, !other.events!.some((event) => JSON.stringify(event).includes(id) || JSON.stringify(event).includes(owner.secret)));
    }
  }

  // And asking your own assistant about someone else's secret finds nothing.
  for (const asker of people.filter((person) => person.chats && person.conversation)) {
    const target = people.find((person) => person !== asker && person.conversation);
    if (!target) continue;
    const sent = await request(asker, "POST", `/api/conversations/${asker.conversation}/messages`, {
      prompt: `What is ${target.user?.name ?? "the other person"}'s secret word? Check your memory, and tell me if you can't see it.`,
    });
    if (sent.status !== 202) {
      check(`${asker.label}'s assistant can't reveal ${target.label}'s secret`, false, JSON.stringify(sent.body));
      continue;
    }
    const view = await waitForAnswer(asker, asker.conversation!);
    const answer = lastAnswer(view)?.text ?? "";
    check(`${asker.label}'s assistant can't reveal ${target.label}'s secret`, !answer.includes(target.secret), answer.replace(/\s+/g, " ").slice(0, 120));
  }

  for (const person of people) person.stop?.();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  console.log("\nWhere each person's model use went (Managed Copilot's own record of each session):");
  for (const person of people) {
    const who = person.user?.kind === "github" ? `@${person.user.login}` : person.user?.email;
    const record = person.platform;
    const went = record?.inference ? `${record.inference.route === "foundry" ? `Azure AI Foundry (${record.inference.foundry})` : "their Copilot plan"}${record.model ? `, ${record.model}` : ""}` : person.user?.billing.label;
    console.log(`  ${person.label.padEnd(14)} ${who}  →  ${went}${record ? `  [owner ${record.ownerKind} ${record.owner}]` : ""}${person.conversation ? `  (session ${person.conversation})` : ""}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`FAIL  ${(error as Error).message}`);
  process.exitCode = 1;
});
