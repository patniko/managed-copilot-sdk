# Managed Copilot SDK

Run **stock** Copilot SDK clients and sessions in environments you deploy, locally under Aspire or in your Azure
subscription. Only the setup lines change:

```ts
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect(); // your local `aspire run`, or your Azure deployment
const client = await managed.client("chat");    // a stock CopilotClient for the "chat" environment

const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
const reply = await session.sendAndWait({ prompt: "Summarize what changed in Aspire 13" });
console.log(reply?.data.content);
```

**Status: under construction.** The foundation (shared contracts, SDK surface, gateway skeleton) is in place; the
platform, demos, and Aspire integration are being built in parallel workstreams.

- [Developer experience spec](docs/spec/developer-experience.md): the customer contract, decisions, and delivery gates.
- [Architecture and workstreams](docs/architecture.md): topology, protocol facts, ownership, and integration points.
- [Repository guidance](AGENTS.md): hard rules, environment facts, commands, and conventions.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/protocol` | Shared contracts: AppHost config schema, REST DTOs, errors, events, network policy |
| `packages/sdk` | `@managed-copilot/sdk`: `ManagedCopilot.connect()`, stock clients over a secure bridge |
| `platform/gateway` | Authenticated gateway: admission, routing, session ledger, platform services |
| `docs/` | Spec and architecture |

## Develop

```powershell
pnpm install
pnpm build
pnpm test
```