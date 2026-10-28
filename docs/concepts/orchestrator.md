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
| `message_worker` | Sends a follow-up to a worker that finished its work (a working one is waited for first) |
| `list_workers` | Shows the worker environments, their agents, and each worker's state |
| `read_worker_file` | Reads a file a worker wrote, or lists a folder |
| `copy_worker_files` | Copies files from one worker's `/workspace` to another's, for example from a builder to a reviewer |
| `stop_worker` | Stops a worker and deletes its sandbox |

## A conversation, not just a job

A coordinator is an ordinary session, so any frontend can talk to it: your app's chat, a pipeline like the software
factory, Copilot CLI (`npx managed-copilot attach <session>`), or a script. Across messages it decides, for each part
of the work, whether to create a sandbox or to reuse one it already has:

- Its instructions list your worker environments (description, size, network, agents), so it picks the right one.
- A follow-up on earlier work goes to the worker that did it (`message_worker`), which still has its files. New,
  independent work, or work that needs another environment, gets a new worker. It stops workers it no longer needs.
- While it waits for workers, a new message from you ends the wait, so it answers right away and the workers keep
  working. Send it with `mode: "immediate"` to reach the coordinator in the same turn.

## Three ways to get work done

Workers are the right shape for independent, long-running parts of a job. A harness that already has its own planning
and sub-agents often just wants them to *act* inside an isolated machine. One setting picks the shape:

```ts
environments: {
  coder: { type: "isolated", size: "medium" },
  team: { type: "orchestrator", workers: ["coder"] },                          // delegate (the default)
  operator: { type: "orchestrator", workers: ["coder"], execution: "direct" }, // acts in a coder sandbox itself
  lead: { type: "orchestrator", workers: ["coder"], execution: "mixed" },      // both; the model chooses
},
```

```mermaid
flowchart LR
  subgraph D["delegate"]
    C1["coordinator"] -- start_worker --> W1["worker agent"] --> S1[("sandbox")]
  end
  subgraph X["direct"]
    C2["coordinator + its sub-agents"] -- "bash, view, create, edit, glob, grep" --> S2[("hands sandbox<br/>no agent")]
  end
  subgraph M["mixed"]
    C3["coordinator"] -- "bash, edit, …" --> S3[("its sandbox")]
    C3 -- start_worker --> W3["worker agent"] --> S4[("sandbox")]
  end
```

| | Delegate | Direct | Mixed |
| --- | --- | --- | --- |
| **Who thinks** | The coordinator, plus one agent per worker | The coordinator and the stock sub-agents it starts (`task`) | Either, per part of the job |
| **Model loops** | One per worker, each in its sandbox | All in the shared runtime; the sandbox runs only commands | Both |
| **Tools** | The worker tools above | `bash`, `read_bash`, `write_bash`, `stop_bash`, `list_bash`, `view`, `create`, `edit`, `glob`, `grep`: the built-in names and shapes, acting on the sandbox | Both sets; `self` names its own sandbox in `copy_worker_files` |
| **Approvals** | One per worker (`start_worker`) | One per `bash`, `write_bash`, `create`, and `edit` call; reads don't ask | Both |
| **Sub-agents' sandboxes** | Sub-agents off | `subagents: "shared"` (default): one sandbox; `"own"`: one each, whose `outputs/` come back to the coordinator's sandbox when they finish | Like direct |
| **Fits** | Long, independent parts; factories, research swarms | Tight edit-run loops, data analysis, a harness with its own planning: "do it yourself, but not on my host" | A conversation with both kinds of work |

- **The hands sandbox is a sandbox like any other.** `managed.workers(session).list()` lists it with `role: "hands"`,
  `managed.files(hands.id)` and `managed.artifacts(hands.id)` read it, and every command in it is recorded with the
  agent that ran it (`managed.exec.list(hands.id)`). It starts with the first tool call that needs it, counts toward
  `maxWorkers`, and goes with the coordinator.
- **Long commands keep going.** A `bash` call waits up to `initial_wait` seconds (default 120, at most 1,800), then
  returns what the command printed so far and a `shellId`; the command keeps running, and `read_bash` picks it up. A
  command is never run twice: after a restart, an interrupted call reattaches to its command or says it may have run.
- **Parallel sub-agents on one sandbox.** `edit` fails instead of overwriting a file that changed underneath it, so
  the agent reads it again. Use `subagents: "own"` when sub-agents should not share a disk.
- **Sandbox output is data.** It enters the same context that can call your own tools, so decide approvals of those
  tools with that in mind.

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
  attach Copilot CLI to the worker to answer them. The coordinator's reports say when a worker is waiting for a person.

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
> their sandboxes, and [walkthrough 12](../../samples/12-direct-execution/README.md) runs the same job directly and
> then gives a mixed coordinator the choice. [Dispatch](../../demos/dispatch/README.md) is a whole app around one coordinator: each message
> shows the sandboxes it created or reused, you approve each new one, and Copilot CLI can join the same conversation.
> The [assistant](../../demos/assistant/README.md) is a coordinator too: it asks before starting a Python or web
> research sandbox for hands-on work, and sends follow-ups to the same one.

<details>
<summary><strong>Under the hood</strong></summary>

- [Spec section 17: orchestrator](../spec/developer-experience.md#17-orchestrator-a-coordinator-with-workers) and its
  contract.
- [Architecture: orchestrator (as built)](../architecture.md#orchestrator-as-built): admission, the worker tools,
  approvals, waiting, cleanup, and recovery.

</details>

---

**Next:** [Identity and access](identity.md) · **Previous:** [Promotion](promotion.md) · **All topics:** [Start here](../README.md)
