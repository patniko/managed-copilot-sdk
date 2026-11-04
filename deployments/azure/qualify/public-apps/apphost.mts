// Qualifies public apps on Azure (docs/deployment.md, "Who can open the apps"): a platform with one shared environment
// and the demo gallery's image published twice, once public and once as an app that acts as the deployer's account.
// Deploy it into a resource group of its own with Parameters:app-allowed-ips set to an address that isn't yours, run
// check.mjs, then delete the group. See README.md.
import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot, publishApp } from "@managed-copilot/aspire";

const builder = await createBuilder();
const copilot = await addManagedCopilot(builder, "copilot", { environments: { chat: { type: "shared" } } });

if (await builder.executionContext().isPublishMode()) {
  // Open to any address, with no GitHub token.
  await publishApp(builder, copilot, {
    name: "public-gallery",
    dockerfile: "demos/gallery/Dockerfile",
    port: 7461,
    healthPath: "/api/health",
    allowedHostsEnv: "GALLERY_ALLOWED_HOSTS",
    public: true,
  });
  // The default: acts as the deployer's account (Parameters:app-github-token) and opens only from Parameters:app-allowed-ips.
  await publishApp(builder, copilot, {
    name: "deployer-gallery",
    dockerfile: "demos/gallery/Dockerfile",
    port: 7462,
    healthPath: "/api/health",
    allowedHostsEnv: "GALLERY_ALLOWED_HOSTS",
  });
}

await builder.build().run();
