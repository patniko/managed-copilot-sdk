# 07 · Network rules and secrets

Limit a sandbox to one host, give it a credential through a vault, and see three things: the sandbox only ever holds a
placeholder, the allowed host receives the real value, and every other host is blocked.

**You need:** the platform running with Docker (`aspire run`), and Internet access to `postman-echo.com`.
**Concepts:** [network and secrets](../../docs/concepts/network-and-secrets.md).

```mermaid
flowchart LR
  SB["sandbox<br/>ECHO_KEY = mcv_placeholder_…"] -- "every request" --> EP["egress proxy"]
  EP -- "real value in X-Echo-Key" --> PE["postman-echo.com"]
  EP -. "403, not on the list" .-x EX["example.com"]
```

## Run it

```powershell
pnpm sample 07
```

## What you'll see

```text
  [platform] network.blocked: api.enterprise.githubcopilot.com:443 (host_not_allowed)
  [platform] network.blocked: example.com:443 (host_not_allowed)

The real value:                demo-dbf68a4f9722f34e
$ECHO_KEY inside the sandbox:  mcv_placeholder_0f469456773cee246a55ca35d9ec610d54490744
postman-echo.com received the real value. Its echo came back as: [redacted]
example.com is not allowed:    curl: (56) CONNECT tunnel failed, response 403
  [platform] network.blocked: telemetry.enterprise.githubcopilot.com:443 (host_not_allowed)
```

## What happened

1. `managed.vaults.create` sealed a throwaway value on the platform. No API returns it again.
2. `managed.client("coder", { network: ["postman-echo.com"], vaults: [vault.id] })` narrowed `coder`, which allows any
   host, to one host for this client's sessions, and attached the vault.
3. In the sandbox, `$ECHO_KEY` held only a placeholder. When `curl` sent it in the `X-Echo-Key` header to
   `postman-echo.com`, the egress proxy swapped in the real value on the way out.
4. postman-echo.com echoed the header back; the proxy replaced the real value in the response with `[redacted]`. That
   redaction is the proof the substitution happened.
5. `example.com` isn't on the list, so the proxy refused the connection with a 403, and the platform reported a
   `network.blocked` event to your app.
6. The other blocked hosts are the runtime's own direct calls to GitHub. They're blocked too, and nothing breaks:
   model calls go through the gateway, not the network.

## The code

```ts
const vault = await managed.vaults.create({
  name: `walkthrough-07-${randomBytes(3).toString("hex")}`,
  credentials: [{ env: "ECHO_KEY", value: secret, hosts: ["postman-echo.com"], headers: ["x-echo-key"] }],
});

const client = await managed.client("coder", { network: ["postman-echo.com"], vaults: [vault.id] });
managed.on("network.blocked", ({ data }) => console.log(`network.blocked: ${data["host"]}:${data["port"]}`));
```

Full script: [`main.ts`](main.ts). It uses a throwaway value on purpose: never send a real credential to an echo
service.

## Try next

- Declare a vault for a whole environment in the AppHost instead, with the value in an Aspire secret parameter
  ([network and secrets](../../docs/concepts/network-and-secrets.md#secrets-vaults)).
- Use `{ network: false }` instead: `curl` fails (exit code 56 in a live run), yet the agent still answers, because
  model calls go through the gateway, not the network.
- Next walkthrough: [08 · Keep working while your app is offline](../08-offline/README.md).
