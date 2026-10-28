# Demo gallery

One page with every demo and walkthrough, linked to your local platform and your Azure deployment. Use it as the
starting point for a live demo.

```powershell
pnpm gallery
```

It opens http://localhost:7460 in your browser.

![The demo gallery: four app cards with Local and Azure buttons, and the walkthroughs below](docs/gallery.png)

## What's on it

- **Apps**: Dispatch, the software factory, the assistant, and the operator console. Each card has a **Local** and an
  **Azure** button with a live status dot, plus its README.
  - Green: it answered. Amber: **IP-restricted**: the deployed app refused this network, because its ingress allows
    only `Parameters:app-allowed-ips` ([deploying to Azure](../../docs/deployment.md)). The button still opens it, for
    when you're on an allowed network. Grey: offline.
  - The operator console buttons sign you in with your GitHub sign-in, like `npx managed-copilot console`: the gallery
    asks the gateway for a one-time link and redirects to it. A deployment's console stays off until it names operators;
    the gallery says so instead of opening a broken page.
- **Walkthroughs**: the thirteen [samples](../../samples/README.md), each with its real output. Copy its **Local** or
  **Azure** command: `pnpm sample 01` after setting `MANAGED_COPILOT_URL` to that gateway. The variable stays set in
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

`src/shared/catalog.ts` lists the apps and walkthroughs. Add a demo there (with its Aspire resource name, local port,
and health path), then capture its screenshot.
