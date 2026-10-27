# Orchestrator: split a job across workers

A session in an `orchestrator` environment is a **coordinator**: an agent on the shared runtime that splits a job,
hands each part to a **worker**, and puts their reports together. Each worker is an ordinary session of one of your
isolated environments, in its own sandbox. Your app makes one `sendAndWait` call and gets the finished answer.

```mermaid
sequenceDiagram
  participant App as Your app
  participant C as Coordinator (shared runtime)
  participant GW as Gateway
  participant W1 as prime-counter (sandbox)
  participant W2 as fib-digits (sandbox)
  App->>C: "In parallel: count primes, and Fibonacci digits"
  C-->>App: approve start_worker? (twice)
  App-->>GW: yes (your onPermissionRequest)
  GW->>W1: new session of coder, its own sandbox, the task
  GW->>W2: new session of coder, its own sandbox, the task
  C->>GW: wait_for_workers
  W1-->>GW: approve shell?
  GW-->>W1: yes, within the approval you gave
  W1-->>GW: report: 9,592
  W2-->>GW: report: 209 digits
  GW-->>C: both reports
  C-->>App: the answer
```

This is a live run of [walkthrough 11](../../samples/11-orchestrator/README.md): two workers in two sandboxes, both
done inside one `sendAndWait`.

## Declare one

```ts
environments: {
  coder: { type: "isolated", size: "medium" },
  team: {
    type: "orchestrator",
    workers: ["coder"], // isolated environments its workers run in; the first is the default
    maxWorkers: 3,      // workers one session can have at once (default 4, at most 16)
  },
},
```

The coordinator has no sandbox of its own, so an orchestrator takes no `image`, `size`, or setup. Workers get
everything from their environment: image, size, setup, network rules, vaults, and idle timeout.

## What the coordinator can do

| Tool | What it does |
| --- | --- |
| `start_worker` | Starts a worker with a name and a self-contained task; returns while its sandbox starts |
| `wait_for_workers` | Waits until workers finish, then returns their reports; no polling and no model time |
| `message_worker` | Sends a worker a follow-up |
| `list_workers` | Shows the worker environments, their agents, and each worker's state |
| `read_worker_file` | Reads a file a worker wrote, or lists a folder |
| `copy_worker_files` | Copies files from one worker's `/workspace` to another's, for example from a builder to a reviewer |
| `stop_worker` | Stops a worker and deletes its sandbox |

## Who approves what

```mermaid
flowchart LR
  S["start_worker"] -- "asks" --> Y["you: onPermissionRequest<br/>or Copilot CLI"]
  Y -- "approve" --> W["the worker runs"]
  W -- "its shell and file prompts" --> P["answered by the platform<br/>once each, like approveAll"]
  W -. "a prompt policy reserves for a person" .-> H["waits for a person"]
```

- **Starting a worker is the approval.** It comes to your handler like any tool call. Approving it approves the
  worker's work inside its sandbox, which is bounded by that sandbox's network rules and vaults.
- **The coordinator's model never approves anything.** The platform answers worker prompts only within the approval
  you gave, and records each answer as `platform:orchestrator`.
- **A person stays in charge where policy says so.** Prompts that managed policy reserves for a person wait for one:
  attach Copilot CLI to the worker to answer them.

## Workers are sessions

| You can… | How |
| --- | --- |
| List a coordinator's workers | `managed.workers(session).list()`, or `npx managed-copilot workers <session>` |
| Read a worker's files and outputs | `managed.files(worker.id)`, `managed.artifacts(worker.id)` |
| Watch one in Copilot CLI | `npx managed-copilot attach <worker>` |
| Know which coordinator started it | `SessionInfo.parentSessionId` |
| Follow progress | `managed.on("worker.started" \| "worker.idle" \| "worker.failed" \| "worker.stopped")` |

Workers run as you: while a worker has no client of its own, your connected app serves its model calls, then your
background sign-in. Nothing broadens: a worker uses the coordinator's model when its environment allows it, your
client's network narrowing applies to workers too, and workers cannot start workers. Deleting the coordinator deletes
its workers.

> [!TIP]
> **Try it:** [walkthrough 11](../../samples/11-orchestrator/README.md) runs two workers in parallel and prints
> their sandboxes.

<details>
<summary><strong>Under the hood</strong></summary>

- [Spec section 17: orchestrator](../spec/developer-experience.md#17-orchestrator-a-coordinator-with-workers) and its
  contract.
- [Architecture: orchestrator (as built)](../architecture.md#orchestrator-as-built): admission, the worker tools,
  approvals, waiting, cleanup, and recovery.

</details>

---

**Next:** [Identity and access](identity.md) · **Previous:** [Promotion](promotion.md) · **All topics:** [Start here](../README.md)
