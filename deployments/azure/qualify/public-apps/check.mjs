// Checks a deployment of this folder's AppHost: the public app answers from this machine with no IP rules and no
// GitHub token, while the app that acts as the deployer's account keeps its allowlist and refuses this machine (when
// Parameters:app-allowed-ips doesn't include it). Prints names, rules, and statuses only, never environment values.
//
//   node check.mjs --subscription <id> --resource-group <group> [--expect-restricted 403|200]
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { subscription: { type: "string" }, "resource-group": { type: "string" }, "expect-restricted": { type: "string", default: "403" } } });
const subscription = values.subscription;
const group = values["resource-group"];
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(subscription ?? "") || !/^[-\w.]{1,90}$/.test(group ?? "")) {
  console.error("Usage: node check.mjs --subscription <id> --resource-group <group> [--expect-restricted 403|200]");
  process.exit(2);
}

// The Azure CLI is a script on Windows, so it runs through the shell; both arguments are validated above.
const apps = JSON.parse(execSync(`az containerapp list --subscription ${subscription} -g ${group} -o json`, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }));
const byName = new Map(apps.map((app) => [app.name, app]));

/** What the check needs from a container app, without any environment values. */
function describe(name) {
  const app = byName.get(name);
  if (!app) return undefined;
  const ingress = app.properties?.configuration?.ingress ?? {};
  const env = (app.properties?.template?.containers ?? []).flatMap((container) => (container.env ?? []).map((variable) => variable.name));
  return {
    fqdn: ingress.fqdn,
    access: app.tags?.["managed-copilot-access"] ?? null,
    rules: (ingress.ipSecurityRestrictions ?? []).map((rule) => `${rule.name}=${rule.ipAddressRange}`),
    actsAsAccount: env.includes("MANAGED_COPILOT_GITHUB_TOKEN"),
  };
}

async function status(fqdn) {
  try {
    const response = await fetch(`https://${fqdn}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return response.status;
  } catch (error) {
    return `unreachable (${error.cause?.code ?? error.message})`;
  }
}

const results = [];
const check = (what, ok, detail) => results.push({ what, ok, detail });

const open = describe("public-gallery");
const restricted = describe("deployer-gallery");
check("public-gallery exists", Boolean(open?.fqdn), open?.fqdn ?? "missing");
check("deployer-gallery exists", Boolean(restricted?.fqdn), restricted?.fqdn ?? "missing");
if (open?.fqdn && restricted?.fqdn) {
  check("public-gallery is tagged public", open.access === "public", `managed-copilot-access: ${open.access}`);
  check("public-gallery has no IP rules", open.rules.length === 0, open.rules.join(", ") || "none");
  check("public-gallery holds no GitHub token", !open.actsAsAccount, open.actsAsAccount ? "MANAGED_COPILOT_GITHUB_TOKEN is set" : "no MANAGED_COPILOT_GITHUB_TOKEN");
  check("deployer-gallery isn't tagged public", restricted.access === null, `managed-copilot-access: ${restricted.access}`);
  check("deployer-gallery keeps its allowlist and the platform rule", restricted.rules.some((rule) => rule.startsWith("allow-")) && restricted.rules.some((rule) => rule.startsWith("platform=")), restricted.rules.join(", "));
  check("deployer-gallery acts as the deployer's account", restricted.actsAsAccount, restricted.actsAsAccount ? "MANAGED_COPILOT_GITHUB_TOKEN is set (secret reference)" : "no token");
  const [openStatus, restrictedStatus] = await Promise.all([status(open.fqdn), status(restricted.fqdn)]);
  check("public-gallery answers this machine", openStatus === 200, `GET /api/health → ${openStatus}`);
  check(`deployer-gallery answers this machine with ${values["expect-restricted"]}`, String(restrictedStatus) === values["expect-restricted"], `GET /api/health → ${restrictedStatus}`);
}

for (const { what, ok, detail } of results) console.log(`${ok ? "✓" : "✗"} ${what}: ${detail}`);
const failed = results.filter((result) => !result.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
