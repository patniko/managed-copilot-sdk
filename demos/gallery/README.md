# Demo gallery

One page with the six patterns, every demo, and every walkthrough, linked to your local platform and your Azure
deployment. Use it as the starting point for a live demo.

```powershell
pnpm gallery
```

It opens http://localhost:7460 in your browser.

![The gallery's first row: the three building blocks, then six pattern cards, each with the managed.client call that picks it, where its brain and hands run, the apps that show it, and its walkthrough](docs/gallery.png)

## What's on it

- **Patterns**: the three building blocks (single container, virtualized multi-tenant, container orchestration) and
  the six patterns made from them: isolated, shared, promotable, direct, delegate, and mixed
  ([patterns](../../docs/concepts/patterns.md)). Each card shows the `managed.client("<environment>")` call that picks
  it in this repository's AppHost, where its brain and hands run, which apps show it (opened when they're up, their
  README otherwise), and a link to its walkthrough below.
- **Apps**: Dispatch, the software factory, the assistant, and the operator console. Each card has a **Local** and an
  **Azure** button with a live status dot, plus its README.
  - Green: it answered. Amber: **IP-restricted**: the deployed app refused this network, because its ingress allows
    only `Parameters:app-allowed-ips` ([deploying to Azure](../../docs/deployment.md)). The button still opens it, for
    when you're on an allowed network. Grey: offline.
  - The operator console buttons sign you in with your GitHub sign-in, like `npx managed-copilot console`: the gallery
    asks the gateway for a one-time link and redirects to it. A deployment's console stays off until it names operators;
    the gallery says so instead of opening a broken page.
- **Walkthroughs**: the thirteen [samples](../../walkthroughs/README.md), each with its real output. Copy its **Local** or
  **Azure** command: `pnpm walkthrough 01` after setting `MANAGED_COPILOT_URL` to that gateway. The variable stays set in
  that terminal, so each copy names its target.

The page checks every link every 15 seconds; the header shows whether the local and Azure gateways are up.

## Where the links come from

- **Local**: the AppHost's fixed ports (gateway 7400, Dispatch 7470, software factory 7480, assistant 7490), shifted by
  `MANAGED_COPILOT_PORT_OFFSET` like `aspire run`. Start the platform with `aspire run`; the gallery doesn't need it to
  start.
- **Azure**, the first of:
  1. `--cloud https://copilot.<environment-domain>`
  2. `MANAGED_COPILOT_URL`, when it isn't a local address
  3. the `copilot` container app the signed-in Azure CLI (`az login`) finds in your subscription

  `aspire deploy` gives every app `https://<app>.<environment-domain>`, so the apps' URLs come from the gateway's.

```text
pnpm gallery [--cloud <gateway url>] [--port <port>] [--no-open] [--no-azure]
```

## Deployed

`aspire deploy` (or `npx managed-copilot deploy`) also publishes the gallery at `https://gallery.<environment-domain>`,
a link you can share. The deployed copy shows that deployment only:

- **Azure links only.** There's no Local column: it can't see visitors' machines.
- **No console sign-in.** Locally, the console button signs you in with your GitHub sign-in. Deployed, that would sign
  every visitor in as one account, so the console card copies `npx managed-copilot console --url <gateway>` instead,
  which each operator runs with their own sign-in. The gallery holds no GitHub token (`publishApp`'s
  `githubToken: false`).
- **Same audience as the demos.** It opens only from `Parameters:app-allowed-ips` (`npx managed-copilot access ips`).
  It checks the apps from inside the deployment, which the allowlist always admits, so its dots say whether an app is
  up, not whether a visitor's network may open it; the page says so.

The image is [`Dockerfile`](Dockerfile) (`GALLERY_HOSTED=1`; `GALLERY_ALLOWED_HOSTS` names the host names it answers).

## Screenshots

The cards' screenshots are in [`shots/`](shots). Each app's is the real app on a local platform, after a real run;
each walkthrough's is the output its README shows, in a terminal window. To refresh them, start the platform, run
some work in each demo, then:

```powershell
pnpm --filter @managed-copilot/demo-gallery capture                  # everything
pnpm --filter @managed-copilot/demo-gallery capture --only dispatch  # one card (ids: dispatch, software-factory, assistant, console, sample-01 ...)
```

The script drives Microsoft Edge through `playwright-core`; set `GALLERY_BROWSER_CHANNEL=chrome` for Chrome.

## Develop

```powershell
pnpm --filter @managed-copilot/demo-gallery build
pnpm --filter @managed-copilot/demo-gallery test
```

`src/shared/catalog.ts` lists the patterns, apps, and walkthroughs. Add a demo there (with its Aspire resource name,
local port, and health path), then capture its screenshot. A pattern names an environment of the root AppHost and the
settings that make it that pattern; the tests check both against `apphost.mts`.
