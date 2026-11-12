/**
 * The scripted happy path: one real pass of Help Desk through its HTTP API. It simulates 5 customers, answers the
 * refunds and cancellations they ask for (approves the first, declines any others), checks that every session stayed
 * on its own customer's orders and on one shared runtime, lists the software issues the agents reported (Aisha's promo
 * code, among the first five; it doesn't send them to Software Factory), then ends the simulation, which deletes its
 * sessions. When an agent proposes a fact for the team knowledge base (Noah's usually does: his boots run small), it
 * adds the first (checking the app stored it) and declines the others, then removes the one it added, so the
 * knowledge base is left as it was.
 *
 *   pnpm --filter @managed-copilot/demo-help-desk happy-path                 # http://localhost:7440 + MANAGED_COPILOT_PORT_OFFSET
 *   pnpm --filter @managed-copilot/demo-help-desk happy-path --url https://help-desk.<environment-domain>
 *
 * It replaces a simulation that is already running. About 5 customer messages: a couple of premium requests.
 * Exits 0 when every check passes; 1 otherwise.
 */
import { parseArgs } from "node:util";
import type { ApiErrorBody, CustomerCard, HelpDeskState, Ticket, ToolItem } from "../shared/types.js";

const { values } = parseArgs({ options: { url: { type: "string" }, timeout: { type: "string", default: "6" } } });
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const base = (values.url ?? `http://localhost:${7440 + offset}`).replace(/\/+$/, "");
const timeoutMs = Number(values.timeout) * 60_000;
const SIZE = 5;
const started = Date.now();
/** Set once this run started a simulation, which it then ends on failure too. */
let ours = false;

function log(message: string): void {
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${message}`);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(error?.error.message ?? `HTTP ${response.status} for ${method} ${path}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLED = new Set(["waiting", "resolved", "failed"]);

/** Every order a tool call of this ticket read or changed: they must all be the customer's own. */
function ordersTouched(ticket: Ticket): string[] {
  const ids: string[] = [];
  for (const item of ticket.items) {
    if (item.kind !== "tool" || item.status !== "done" || !item.result) continue;
    const result = item.result as { orderId?: unknown; orders?: { orderId?: unknown }[] };
    if (typeof result.orderId === "string") ids.push(result.orderId);
    for (const order of result.orders ?? []) if (typeof order.orderId === "string") ids.push(order.orderId);
  }
  return ids;
}

async function main(): Promise<boolean> {
  log(`Help Desk at ${base}`);
  let state = await api<HelpDeskState>("GET", "/api/state");
  for (let waited = 0; state.platform.state !== "connected"; waited += 2_000) {
    if (waited > 60_000) throw new Error(`Help Desk isn't connected to Managed Copilot: ${state.platform.message ?? state.platform.state}`);
    await sleep(2_000);
    state = await api<HelpDeskState>("GET", "/api/state");
  }
  log(`Connected to ${state.platform.deployment} (${state.platform.mode}); model ${state.desk.model ?? "default"}`);
  if (state.run) log(`Replacing the current simulation of ${state.run.size} customers`);
  const customers = new Map<string, CustomerCard>(state.customers.map((customer) => [customer.id, customer]));
  const name = (id: string) => customers.get(id)?.name ?? id;

  const run = await api<{ id: string }>("POST", "/api/simulation", { size: SIZE });
  ours = true;
  log(`Simulating ${SIZE} customers (simulation ${run.id})`);
  const statuses = new Map<string, string>();
  const answered = new Set<string>();
  const decisions: string[] = [];
  const memories: string[] = [];
  let added: { readonly subject: string; readonly fact: string } | undefined;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    state = await api<HelpDeskState>("GET", "/api/state");
    if (state.run?.id !== run.id) {
      ours = false;
      throw new Error("The simulation was replaced or ended by someone else.");
    }
    for (const ticket of state.tickets) {
      if (statuses.get(ticket.customerId) !== ticket.status) {
        statuses.set(ticket.customerId, ticket.status);
        log(`${name(ticket.customerId).padEnd(16)} ${ticket.status}${ticket.problem ? ` (${ticket.problem})` : ""}`);
      }
      const memory = ticket.memory;
      if (memory && !answered.has(memory.id)) {
        answered.add(memory.id);
        const approve = added === undefined;
        await api("POST", `/api/tickets/${ticket.customerId}/approvals/${encodeURIComponent(memory.id)}`, { approve });
        if (approve) added = memory;
        const decision = `${approve ? "Added" : "Didn't add"} ${name(ticket.customerId)}'s agent's fact "${memory.subject}: ${memory.fact}"`;
        memories.push(decision);
        log(decision);
      }
      const approval = ticket.approval;
      if (approval && !answered.has(approval.id)) {
        answered.add(approval.id);
        const approve = decisions.length === 0;
        await api("POST", `/api/tickets/${ticket.customerId}/approvals/${encodeURIComponent(approval.id)}`, { approve });
        const decision = `${approve ? "Approved" : "Declined"} ${name(ticket.customerId)}'s ${approval.action} of ${approval.orderId} ($${approval.amount.toFixed(2)})`;
        decisions.push(decision);
        log(decision);
      }
    }
    if (state.tickets.length === SIZE && state.tickets.every((ticket) => SETTLED.has(ticket.status))) break;
    if (Date.now() > deadline) throw new Error(`Not every conversation finished within ${values.timeout} minutes.`);
    await sleep(1_500);
  }
  // The counters follow the platform's session records, which Help Desk lists every few seconds.
  await sleep(5_000);
  state = await api<HelpDeskState>("GET", "/api/state");
  // Proposals don't hold up a conversation, so a second one from the same agent can still be waiting.
  for (const proposal of state.proposals.filter((proposal) => proposal.source.sessionId.startsWith(`hd-${run.id}-`) && !answered.has(proposal.id))) {
    answered.add(proposal.id);
    await api("POST", `/api/knowledge/proposals/${encodeURIComponent(proposal.id)}`, { approve: false });
    const decision = `Didn't add ${proposal.source.name}'s agent's fact "${proposal.subject}: ${proposal.fact}"`;
    memories.push(decision);
    log(decision);
  }

  const problems: string[] = [];
  const { counters } = state;
  if (counters.sessions !== SIZE) problems.push(`Expected ${SIZE} sessions, the counters show ${counters.sessions}.`);
  if (counters.runtimes !== 1) problems.push(`Expected 1 runtime, the counters show ${counters.runtimes}.`);
  if (counters.sandboxes !== 0) problems.push(`Expected no sandboxes, the counters show ${counters.sandboxes}.`);
  if (!(counters.premiumRequests > 0)) problems.push("No premium requests were counted.");
  if (decisions.length === 0) problems.push("No refund or cancellation asked for approval.");
  for (const ticket of state.tickets) {
    const who = name(ticket.customerId);
    if (ticket.status === "failed") problems.push(`${who}: ${ticket.problem ?? "failed"}`);
    if (!ticket.items.some((item) => item.kind === "message" && item.from === "agent")) problems.push(`${who} got no answer.`);
    const own = new Set(customers.get(ticket.customerId)?.orderIds);
    const foreign = ordersTouched(ticket).filter((id) => !own.has(id));
    if (foreign.length) problems.push(`${who}'s session read other customers' orders: ${foreign.join(", ")}.`);
  }
  const blocked = state.tickets.flatMap((ticket) =>
    ticket.items.filter((item): item is ToolItem => item.kind === "tool" && item.blocked === true).map((item) => `${name(ticket.customerId)} asked for ${String(item.args["orderId"])}`),
  );

  if (added) {
    const stored = state.knowledge.find((entry) => entry.subject === added!.subject && entry.fact === added!.fact);
    if (!stored) problems.push(`The added fact "${added.subject}" isn't in the team knowledge base.`);
    else {
      await api("DELETE", `/api/knowledge/${encodeURIComponent(stored.id)}`);
      log(`Removed "${stored.subject}" from the team knowledge base again`);
    }
  }

  log("Ending the simulation");
  await api("DELETE", "/api/simulation");
  ours = false;
  const after = await api<HelpDeskState>("GET", "/api/state");
  if (after.run || after.counters.sessions !== 0) problems.push("The simulation didn't end cleanly.");

  console.log("");
  console.log(`Customers        ${state.tickets.map((ticket) => `${name(ticket.customerId)} (${ticket.status})`).join(", ")}`);
  console.log(`Counters         ${counters.sessions} sessions, ${counters.runtimes} runtime, ${counters.sandboxes} sandboxes, ${counters.messages} messages, ${counters.premiumRequests} premium requests`);
  console.log(`Approvals        ${decisions.length ? decisions.join("; ") : "none"}`);
  console.log(`Team knowledge   ${memories.length ? memories.join("; ") : "no facts proposed"}`);
  console.log(`Blocked lookups  ${blocked.length ? blocked.join("; ") : "none (the agent declined without calling a tool)"}`);
  const issues = state.issues ?? [];
  console.log(`Software issues  ${issues.length ? issues.map((issue) => `${issue.title} (${issue.reports.map((report) => report.name).join(", ")})`).join("; ") : "none reported"}`);
  for (const problem of problems) console.log(`✗ ${problem}`);
  if (problems.length === 0) console.log("✓ Every check passed");
  return problems.length === 0;
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch(async (error: unknown) => {
    console.error(`✗ ${(error as Error).message}`);
    // Leave nothing behind: end the simulation this run started.
    if (ours) await api("DELETE", "/api/simulation").catch(() => undefined);
    process.exitCode = 1;
  });
