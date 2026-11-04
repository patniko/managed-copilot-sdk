# Public apps qualification

Checks `publishApp({ public: true })` on Azure ([deploying to Azure](../../../../docs/deployment.md#who-can-open-the-apps)).
The AppHost here declares a platform with one shared environment (no sandboxes, so it deploys in minutes) and
publishes the demo gallery's image twice:

| App | Published as | Expected |
| --- | --- | --- |
| `public-gallery` | `public: true` | Tagged `managed-copilot-access: public`, no IP rules, no `MANAGED_COPILOT_GITHUB_TOKEN`; answers any address |
| `deployer-gallery` | the default | Acts as the deployer's account (`Parameters:app-github-token`); its ingress admits only `Parameters:app-allowed-ips` and the platform subnet |

Run it from this folder, into a resource group of its own, with the allowlist set to an address that isn't yours. It's a
standalone pnpm project whose dependencies link to the repository's installed packages (Aspire installs it with
`pnpm install --ignore-workspace`), so run `pnpm install` and `pnpm build` at the repository root first:

```powershell
npx managed-copilot access ips set 203.0.113.7 --apphost apphost.mts
npx managed-copilot deploy --apphost apphost.mts --subscription <id> --resource-group <new group> --yes
node check.mjs --subscription <id> --resource-group <new group>
npx managed-copilot access --apphost apphost.mts    # Public apps: public-gallery now: any address
az group delete --subscription <id> --name <new group> --yes
```

`check.mjs` prints names, rules, and HTTP statuses, never environment values. After `access ips add me`, rerun it
with `--expect-restricted 200` to see the allowlist admit this machine (if Azure sees this machine at the address
`api.ipify.org` reports; corporate tunnels often differ).

To check the switch of an app that acts as the deployer to public, deploy again with `QUALIFY_DEPLOYER_GALLERY` set
in the environment:

| `QUALIFY_DEPLOYER_GALLERY` | `deployer-gallery` is published with | Expected |
| --- | --- | --- |
| `public` (straight after the default) | `public: true` | `check-deployer-gallery-public` refuses, naming the revision that holds the token; the app's ingress is unchanged |
| `no-token` | `githubToken: false` | Deploys; once the new revision serves, the token-holding one is no longer active |
| `public` (after `no-token`) | `public: true` | Deploys; the app is tagged `public`, has no IP rules, and answers any address |

Last run: 2026-11-04, westus2: 10/10 checks, and all three switch stages as expected (see "Live qualification" in
[deploying to Azure](../../../../docs/deployment.md#live-qualification)).
