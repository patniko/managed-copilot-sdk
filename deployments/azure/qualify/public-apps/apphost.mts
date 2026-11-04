// Qualifies public apps on Azure (docs/deployment.md, "Who can open the apps"): a platform with one shared environment
// and the demo gallery's image published twice, once public and once as an app that acts as the deployer's account.
// Deploy it into a resource group of its own with Parameters:app-allowed-ips set to an address that isn't yours, run
// check.mjs, then delete the group. QUALIFY_DEPLOYER_GALLERY=no-token|public redeploys the second app with
// githubToken: false or public: true, to check the two-deploy switch to public. See README.md.
import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot, publishApp } from "@managed-copilot/aspire";

const builder = await createBuilder();
const copilot = await addManagedCopilot(builder, "copilot", { environments: { chat: { type: "shared" } } });

const stage = process.env.QUALIFY_DEPLOYER_GALLERY ?? "default";
if (!["default", "no-token", "public"].includes(stage)) throw new Error(`QUALIFY_DEPLOYER_GALLERY must be default, no-token, or public (got "${stage}").`);

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
  // By default it acts as the deployer's account (Parameters:app-github-token) and opens only from
  // Parameters:app-allowed-ips.
  await publishApp(builder, copilot, {
    name: "deployer-gallery",
    dockerfile: "demos/gallery/Dockerfile",
    port: 7462,
    healthPath: "/api/health",
    allowedHostsEnv: "GALLERY_ALLOWED_HOSTS",
    ...(stage === "no-token" ? { githubToken: false } : stage === "public" ? { public: true } : {}),
  });
}

await builder.build().run();
