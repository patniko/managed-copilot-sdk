import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/cli.js";
import type { CommandResult, HostTools } from "../src/host.js";

const TOKEN = "gho_secret_token_value";
const SUBSCRIPTION = "11111111-2222-3333-4444-555555555555";
const ENVIRONMENT = "/subscriptions/x/resourceGroups/managed-copilot-dev/providers/Microsoft.App/managedEnvironments/copilot-env";

interface App {
  name: string;
  tags?: Record<string, string>;
  properties: { managedEnvironmentId: string; configuration: { ingress: { external: boolean; fqdn: string; ipSecurityRestrictions: { name: string; ipAddressRange: string; action: string }[] } } };
}

function app(name: string, rules: [string, string][], environment = ENVIRONMENT, tags?: Record<string, string>): App {
  return {
    name,
    ...(tags ? { tags } : {}),
    properties: {
      managedEnvironmentId: environment,
      configuration: { ingress: { external: true, fqdn: `${name}.bravedesert.westus2.azurecontainerapps.io`, ipSecurityRestrictions: rules.map(([n, ip]) => ({ name: n, ipAddressRange: ip, action: "Allow" })) } },
    },
  };
}

/** An app published with `publishApp({ public: true })`: no IP rules, tagged by the Azure integration. */
const publicApp = (name: string) => app(name, [], ENVIRONMENT, { "aspire-resource-name": name, "managed-copilot-access": "public" });

class FakeHost implements HostTools {
  secrets: Record<string, string> = {};
  apps: App[] | undefined = undefined;
  installed = new Set(["aspire", "az", "docker"]);
  dockerRunning = true;
  azSignedIn = true;
  deployExit = 0;
  address: string | undefined = "198.51.100.9";
  failList = false;
  failUpdates = false;
  records = "";
  /** Subscriptions the Azure CLI can use besides its default one: their tenant and signed-in account. */
  tenants: Record<string, { tenantId: string; user: string }> = {};
  readonly calls: { command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];

  has(command: string) {
    return this.installed.has(command);
  }

  async capture(command: string, args: readonly string[], options?: { env?: Readonly<Record<string, string>> }): Promise<CommandResult> {
    this.calls.push({ command, args, ...(options?.env ? { env: options.env } : {}) });
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (command === "aspire" && args[0] === "secret") {
      if (args[1] === "list") return ok(JSON.stringify(this.secrets));
      if (args[1] === "set") {
        this.secrets[args[2]!] = args[3]!;
        return ok();
      }
      if (args[1] === "delete") {
        delete this.secrets[args[2]!];
        return ok();
      }
    }
    if (command === "docker") return this.dockerRunning ? ok("29.0.0") : { code: 1, stdout: "", stderr: "Cannot connect" };
    if (command === "az") {
      const line = args.join(" ");
      if (line.startsWith("account show --subscription")) {
        const id = args[args.indexOf("--subscription") + 1]!;
        const found = this.tenants[id];
        return found ? ok(JSON.stringify({ id, name: "Other subscription", tenantId: found.tenantId, user: { name: found.user, type: "user" } })) : { code: 1, stdout: "", stderr: "Subscription not found" };
      }
      if (line.startsWith("account show")) {
        return this.azSignedIn
          ? ok(JSON.stringify({ id: SUBSCRIPTION, name: "Demo subscription", tenantId: "tenant-a", user: { name: "dev@contoso.example", type: "user" } }))
          : { code: 1, stdout: "", stderr: "Please run az login" };
      }
      if (line.startsWith("containerapp list") && this.failList) return { code: 1, stdout: "", stderr: "AuthorizationFailed" };
      if (line.startsWith("containerapp list")) return this.apps ? ok(JSON.stringify(this.apps)) : { code: 3, stdout: "", stderr: "ResourceGroupNotFound" };
      if (line.startsWith("containerapp show")) {
        const found = this.apps?.find((candidate) => candidate.name === args[args.indexOf("-n") + 1]);
        return found ? ok(JSON.stringify(found)) : { code: 3, stdout: "", stderr: "not found" };
      }
      if (line.startsWith("containerapp ingress access-restriction") && this.failUpdates) return { code: 1, stdout: "", stderr: "AuthorizationFailed" };
      if (line.startsWith("containerapp ingress access-restriction")) {
        const target = this.apps!.find((candidate) => candidate.name === args[args.indexOf("-n") + 1])!;
        const rules = target.properties.configuration.ingress.ipSecurityRestrictions;
        const rule = args[args.indexOf("--rule-name") + 1]!;
        const index = rules.findIndex((candidate) => candidate.name === rule);
        if (args[3] === "set") {
          const entry = { name: rule, ipAddressRange: args[args.indexOf("--ip-address") + 1]!, action: "Allow" };
          if (index >= 0) rules[index] = entry;
          else rules.push(entry);
        } else rules.splice(index, 1);
        return ok();
      }
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  }

  async stream(command: string, args: readonly string[], options?: { env?: Readonly<Record<string, string>> }) {
    this.calls.push({ command, args, ...(options?.env ? { env: options.env } : {}) });
    if (command === "aspire" && args[0] === "deploy" && this.deployExit === 0 && !this.apps) this.apps = [app("copilot", [])];
    return this.deployExit;
  }

  githubToken = async () => TOKEN;
  githubLogin = async (token: string) => {
    if (token !== TOKEN) throw new Error("bad token");
    return "patniko";
  };
  publicAddress = async () => this.address;
  deploymentsDirectory = () => this.records;
}

let directory: string;
let previous: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mc-deploy-"));
  writeFileSync(join(directory, "apphost.mts"), "// AppHost\n");
  previous = process.cwd();
  process.chdir(directory);
});
afterEach(() => {
  process.chdir(previous);
  rmSync(directory, { recursive: true, force: true });
});

/** Writes an Aspire deployment record, as `aspire deploy` keeps one per AppHost path. */
function writeRecord(host: FakeHost, appHost: string | undefined, resourceGroup: string, subscription = SUBSCRIPTION): string {
  const name = appHost ? createHash("sha256").update(appHost.toLowerCase()).digest("hex").toUpperCase() : "ABCDEF0123456789";
  const recordDir = join(host.records, name);
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    join(recordDir, "production.json"),
    JSON.stringify({ "Parameters:copilot-platform-key": "secret-key", "Parameters:assistant-webhook-secret": "deployed-hook-secret", "Azure:SubscriptionId": subscription, "Azure:ResourceGroup": resourceGroup }),
  );
  return recordDir;
}

const thisAppHost = () => join(process.cwd(), "apphost.mts");

function harness(host: FakeHost, extra: Partial<CliIo> = {}) {
  if (!host.records) host.records = join(directory, "deployments");
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const io: CliIo = {
    stdout: { write: (text: string) => (stdout += text), isTTY: false },
    stderr: { write: (text: string) => (stderr += text), isTTY: false },
    env: { NO_COLOR: "1" },
    host,
    connect: async () => {
      throw new Error("access and deploy must not connect to a deployment");
    },
    confirm: async (question) => {
      prompts.push(question);
      return true;
    },
    ...extra,
  };
  return { io, out: () => stdout, err: () => stderr, prompts };
}

const deployedHost = () => {
  const host = new FakeHost();
  host.secrets = {
    "Azure:SubscriptionId": SUBSCRIPTION,
    "Azure:ResourceGroup": "managed-copilot-dev",
    "Parameters:copilot-github-users": "patniko",
    "Parameters:assistant-webhook-secret": "do-not-print-me",
  };
  host.apps = [
    app("copilot", []),
    app("dispatch", [["allow-1", "203.0.113.7/32"], ["platform", "10.42.0.0/23"]]),
    app("assistant", [["allow-1", "203.0.113.7/32"], ["platform", "10.42.0.0/23"], ["platform-ingress", "20.1.2.3/32"]]),
    app("egress", [], "/subscriptions/x/resourceGroups/managed-copilot-dev/providers/Microsoft.App/managedEnvironments/mc-egress-abc"),
  ];
  return host;
};

describe("access", () => {
  it("shows the lists and the running apps' allowlists without printing secrets", async () => {
    const host = deployedHost();
    const h = harness(host);
    expect(await run(["access"], h.io)).toBe(0);
    expect(h.out()).toContain("Platform users  @patniko");
    expect(h.out()).toContain("Operators       none");
    expect(h.out()).toContain("Apps act as     @patniko");
    expect(h.out()).toContain("this machine's public address at deploy time (default)");
    expect(h.out()).toContain("dispatch now: 203.0.113.7/32");
    expect(h.out()).not.toContain("egress");
    expect(h.out()).not.toContain("do-not-print-me");
    expect(h.out()).not.toContain(TOKEN);
  });

  it("adds people, resolving me to the GitHub sign-in, and replaces the whole list", async () => {
    const host = deployedHost();
    const h = harness(host);
    expect(await run(["access", "users", "add", "me", "@alice,bob", "Alice"], h.io)).toBe(0);
    expect(host.secrets["Parameters:copilot-github-users"]).toBe("patniko,alice,bob");
    expect(h.out()).toContain("Takes effect on the next `npx managed-copilot deploy`");

    expect(await run(["access", "users", "remove", "BOB"], h.io)).toBe(0);
    expect(host.secrets["Parameters:copilot-github-users"]).toBe("patniko,alice");

    expect(await run(["access", "operators", "set", "me"], h.io)).toBe(0);
    expect(host.secrets["Parameters:copilot-operator-users"]).toBe("patniko");
    expect(host.calls.some((call) => call.args.some((arg) => arg.includes(TOKEN)))).toBe(false);
  });

  it("rejects entries that are not logins or addresses", async () => {
    const h = harness(deployedHost());
    expect(await run(["access", "users", "add", "not a login!"], h.io)).toBe(2);
    expect(h.err()).toContain("is not a GitHub login");
    expect(await run(["access", "ips", "add", "300.1.1.1"], h.io)).toBe(2);
    expect(await run(["access", "teams", "add", "x"], h.io)).toBe(2);
    expect(h.err()).toContain("Unknown list");
  });

  it("keeps the deploying machine when adding an address to the default, and applies it to the running apps now", async () => {
    const host = deployedHost();
    const h = harness(host);
    expect(await run(["access", "ips", "add", "203.0.113.50"], h.io)).toBe(0);
    expect(host.secrets["Parameters:app-allowed-ips"]).toBe("198.51.100.9/32,203.0.113.50/32");
    const assistant = host.apps!.find((candidate) => candidate.name === "assistant")!.properties.configuration.ingress.ipSecurityRestrictions;
    expect(assistant.map((rule) => `${rule.name}=${rule.ipAddressRange}`)).toEqual([
      "allow-1=198.51.100.9/32",
      "platform=10.42.0.0/23",
      "platform-ingress=20.1.2.3/32",
      "allow-2=203.0.113.50/32",
    ]);
    expect(h.out()).toContain("Applied now to dispatch, assistant.");

    expect(await run(["access", "ips", "set", "me"], h.io)).toBe(0);
    expect(assistant.map((rule) => rule.name)).toEqual(["allow-1", "platform", "platform-ingress"]);
    expect(host.calls.filter((call) => call.args.includes("egress"))).toEqual([]);
  });

  it('asks before opening the apps to any address, and leaves "*" to the next deploy', async () => {
    const host = deployedHost();
    const declined = harness(host, { confirm: async () => false });
    expect(await run(["access", "ips", "set", "*"], declined.io)).toBe(1);
    expect(host.secrets["Parameters:app-allowed-ips"]).toBeUndefined();
    expect(declined.err()).toContain("anyone on the Internet");
    expect(declined.err()).toContain("publish it with public: true instead");

    const h = harness(host);
    expect(await run(["access", "ips", "set", "*", "--yes"], h.io)).toBe(0);
    expect(host.secrets["Parameters:app-allowed-ips"]).toBe("*");
    expect(h.out()).toContain("any address");
    expect(h.out()).toContain("Takes effect on the next");
    expect(host.calls.some((call) => call.args.includes("access-restriction"))).toBe(false);
  });

  it("updates nothing live when the named gateway isn't there", async () => {
    const host = deployedHost();
    const h = harness(host);
    expect(await run(["access", "ips", "add", "203.0.113.50", "--name", "misspelled"], h.io)).toBe(0);
    expect(h.out()).toContain('No gateway named "misspelled"');
    expect(host.calls.some((call) => call.args.includes("access-restriction"))).toBe(false);
  });

  it("shows public apps apart from the allowlist and never changes their ingress", async () => {
    const host = deployedHost();
    host.apps!.push(publicApp("front-desk"), app("gallery", []));
    const h = harness(host);
    expect(await run(["access"], h.io)).toBe(0);
    expect(h.out()).toContain("                gallery now: any address\nPublic apps     front-desk now: any address\n");
    expect(h.out()).toContain("publishApp's public: true");

    const json = harness(host);
    expect(await run(["access", "--json"], json.io)).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({ publicApps: [{ name: "front-desk", allowed: [] }], openApps: ["gallery"] });

    const update = harness(host);
    expect(await run(["access", "ips", "add", "203.0.113.50"], update.io)).toBe(0);
    expect(update.out()).toContain("Applied now to dispatch, assistant.");
    expect(update.out()).toContain("front-desk is public: open to any address, whatever this list says.");
    expect(host.apps!.find((candidate) => candidate.name === "front-desk")!.properties.configuration.ingress.ipSecurityRestrictions).toEqual([]);
    expect(host.calls.filter((call) => call.args.includes("access-restriction") && call.args.includes("front-desk"))).toEqual([]);
  });

  it("leaves a public app alone even if someone gave it a platform rule by hand", async () => {
    const host = deployedHost();
    const frontDesk = publicApp("front-desk");
    frontDesk.properties.configuration.ingress.ipSecurityRestrictions.push({ name: "platform", ipAddressRange: "10.42.0.0/23", action: "Allow" });
    host.apps = [app("copilot", []), frontDesk];
    const h = harness(host);
    expect(await run(["access", "ips", "set", "203.0.113.50", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ live: { status: "deferred", public: ["front-desk"] } });
    expect(host.calls.some((call) => call.args.includes("access-restriction"))).toBe(false);
  });

  it("fails, keeping the saved list, when the running apps can't be listed or updated", async () => {
    const host = deployedHost();
    host.failList = true;
    const listing = harness(host);
    expect(await run(["access", "ips", "set", "203.0.113.60"], listing.io)).toBe(1);
    expect(listing.err()).toContain("Could not list the apps");
    expect(listing.out()).toContain("(saved)");
    expect(host.secrets["Parameters:app-allowed-ips"]).toBe("203.0.113.60/32");

    const updating = deployedHost();
    updating.failUpdates = true;
    const h = harness(updating);
    expect(await run(["access", "ips", "set", "203.0.113.50", "--json"], h.io)).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ entries: ["203.0.113.50/32"], live: { status: "failed", failed: ["dispatch", "assistant"] } });
  });

  it("needs an AppHost and the Aspire CLI", async () => {
    rmSync(join(directory, "apphost.mts"));
    const h = harness(deployedHost());
    expect(await run(["access"], h.io)).toBe(2);
    expect(h.err()).toContain("No AppHost here.");

    const host = deployedHost();
    host.installed.delete("aspire");
    const missing = harness(host);
    expect(await run(["access"], missing.io)).toBe(1);
    expect(missing.err()).toContain("aspire is not installed.");
  });
});

describe("deploy", () => {
  it("fills in a first deployment's settings, adds the caller, and passes the apps' token only through the environment", async () => {
    const host = new FakeHost();
    const h = harness(host);
    expect(await run(["deploy", "--yes"], h.io)).toBe(0);
    expect(host.secrets).toMatchObject({
      "Azure:SubscriptionId": SUBSCRIPTION,
      "Azure:Location": "westus2",
      "Azure:ResourceGroup": "managed-copilot-dev",
      "Parameters:copilot-github-users": "patniko",
      "Parameters:copilot-operator-users": "patniko",
    });
    const deployCall = host.calls.find((call) => call.command === "aspire" && call.args[0] === "deploy")!;
    expect(deployCall.args).toEqual(["deploy", "--apphost", join(process.cwd(), "apphost.mts"), "--non-interactive"]);
    expect(deployCall.env).toEqual({
      "Parameters__app-github-token": TOKEN,
      "Azure__SubscriptionId": SUBSCRIPTION,
      "Azure__Location": "westus2",
      "Azure__ResourceGroup": "managed-copilot-dev",
      "Parameters__copilot-github-users": "patniko",
      "Parameters__copilot-operator-users": "patniko",
    });
    expect(host.calls.some((call) => call.args.some((arg) => arg.includes(TOKEN)))).toBe(false);
    expect(h.out()).toContain("Demo subscription");
    expect(h.out()).toContain("new deployment");
    expect(h.out()).toContain("198.51.100.9/32 (this machine)");
    expect(h.out()).toContain("Added you (@patniko) to platform users and operators.");
    expect(h.out()).toContain("Deployed: https://copilot.bravedesert.westus2.azurecontainerapps.io");
    expect(h.out()).not.toContain(TOKEN);
  });

  it("takes the target from options and keeps existing lists", async () => {
    const host = deployedHost();
    host.secrets["Parameters:copilot-operator-users"] = "alice";
    const h = harness(host);
    writeRecord(host, thisAppHost(), "managed-copilot-dev");
    expect(await run(["deploy", "--yes", "--location", "eastus"], h.io)).toBe(0);
    expect(host.secrets["Azure:Location"]).toBe("eastus");
    expect(host.secrets["Parameters:copilot-operator-users"]).toBe("alice");
    expect(h.out()).toContain("updates the deployment there");
    expect(h.out()).not.toContain("Added you");
  });

  it("passes the AppHost's own parameters from its user secrets, never the platform's keys or ones the deployment keeps", async () => {
    const host = deployedHost();
    Object.assign(host.secrets, {
      "Parameters:google-client-id": "google-id-value",
      "Parameters:google-client-secret": "google-secret-value",
      "Parameters:copilot-durable-key": "local-durable-key",
      "Parameters:app-github-token": "stale-token",
      "Parameters:front-desk-github-client-secret": "from-user-secrets",
      "ConnectionStrings:db": "not-a-parameter",
    });
    const h = harness(host, { env: { NO_COLOR: "1", "Parameters__front-desk-github-client-secret": "from-environment" } });
    writeRecord(host, thisAppHost(), "managed-copilot-dev");
    expect(await run(["deploy", "--yes"], h.io)).toBe(0);
    const env = host.calls.find((call) => call.command === "aspire" && call.args[0] === "deploy")!.env!;
    expect(env).toMatchObject({ "Parameters__google-client-id": "google-id-value", "Parameters__google-client-secret": "google-secret-value", "Parameters__app-github-token": TOKEN });
    // Generated by the platform, kept by the deployment's record, already in the environment, or not a parameter.
    for (const variable of ["Parameters__copilot-durable-key", "Parameters__copilot-platform-key", "Parameters__assistant-webhook-secret", "Parameters__front-desk-github-client-secret", "ConnectionStrings__db"]) {
      expect(env, variable).not.toHaveProperty(variable);
    }
    expect(h.out()).toContain("Passing 2 parameters from the AppHost's user secrets: google-client-id, google-client-secret");
    expect(h.out() + h.err()).not.toMatch(/google-secret-value|local-durable-key|do-not-print-me|from-user-secrets/);
    expect(host.calls.some((call) => call.args.some((arg) => arg.includes("google-secret-value")))).toBe(false);
  });

  it("says public apps are open to any address, and lists them once deployed", async () => {
    const host = deployedHost();
    host.apps!.push(publicApp("front-desk"));
    const h = harness(host);
    writeRecord(host, thisAppHost(), "managed-copilot-dev");
    expect(await run(["deploy", "--yes"], h.io)).toBe(0);
    expect(h.out()).toContain("Apps open to    198.51.100.9/32 (this machine); public apps: any address");
    expect(h.out()).toContain("Public apps: https://front-desk.bravedesert.westus2.azurecontainerapps.io (any address)");
  });

  it("deploys to a subscription in another tenant with that tenant, and says how to use another account's", async () => {
    const other = "99999999-8888-7777-6666-555555555555";
    const host = new FakeHost();
    host.tenants[other] = { tenantId: "tenant-b", user: "DEV@contoso.example" };
    const h = harness(host);
    expect(await run(["deploy", "--yes", "--subscription", other], h.io)).toBe(0);
    const deployCall = host.calls.find((call) => call.command === "aspire" && call.args[0] === "deploy")!;
    expect(deployCall.env).toMatchObject({ Azure__SubscriptionId: other, Azure__TenantId: "tenant-b" });

    // An explicit tenant wins over the subscription's.
    host.secrets["Azure:TenantId"] = "tenant-explicit";
    writeRecord(host, thisAppHost(), "managed-copilot-dev", other);
    host.calls.length = 0;
    expect(await run(["deploy", "--yes", "--subscription", other], harness(host).io)).toBe(0);
    expect(host.calls.find((call) => call.command === "aspire" && call.args[0] === "deploy")!.env).toMatchObject({ Azure__TenantId: "tenant-explicit" });

    const elsewhere = new FakeHost();
    elsewhere.tenants[other] = { tenantId: "tenant-c", user: "someone@fabrikam.example" };
    const switching = harness(elsewhere);
    expect(await run(["deploy", "--yes", "--subscription", other], switching.io)).toBe(1);
    expect(switching.err()).toContain("belongs to another account than the Azure CLI's current one");
    expect(switching.err()).toContain(`az account set --subscription ${other}`);
    expect(switching.err()).not.toContain("someone@fabrikam.example");
    expect(elsewhere.calls.some((call) => call.args[0] === "deploy")).toBe(false);

    // A tenant in the AppHost's settings doesn't skip the account check.
    elsewhere.secrets["Azure:TenantId"] = "tenant-c";
    const configured = harness(elsewhere);
    expect(await run(["deploy", "--yes", "--subscription", other], configured.io)).toBe(1);
    expect(configured.err()).toContain("belongs to another account than the Azure CLI's current one");
    expect(elsewhere.calls.some((call) => call.args[0] === "deploy")).toBe(false);
    expect(elsewhere.secrets["Azure:SubscriptionId"]).toBeUndefined();

    const unknown = new FakeHost();
    const refused = harness(unknown);
    expect(await run(["deploy", "--yes", "--subscription", "12345678-1234-1234-1234-123456789012"], refused.io)).toBe(1);
    expect(refused.err()).toContain("The Azure CLI can't use subscription 12345678-1234-1234-1234-123456789012.");
    expect(refused.err()).toContain("az login --tenant");
    expect(unknown.calls.some((call) => call.args[0] === "deploy")).toBe(false);
    expect(unknown.secrets).toEqual({});
  });

  it("asks first in a terminal, and needs --yes otherwise", async () => {
    const host = new FakeHost();
    const unattended = harness(host);
    expect(await run(["deploy"], unattended.io)).toBe(2);
    expect(unattended.err()).toContain("Pass --yes");

    const interactive = harness(host, { stdin: { isTTY: true }, stdout: { write: () => undefined, isTTY: true }, confirm: async () => false });
    expect(await run(["deploy"], interactive.io)).toBe(1);
    expect(host.calls.some((call) => call.args[0] === "deploy")).toBe(false);
    expect(host.secrets).toEqual({});
  });

  it("refuses to deploy over another checkout's deployment, even with settings already in place", async () => {
    const host = deployedHost();
    const h = harness(host);
    expect(await run(["deploy", "--yes"], h.io)).toBe(1);
    expect(h.err()).toContain("already has a Managed Copilot deployment that this AppHost didn't make");
    expect(h.err()).toContain("Nothing was changed.");
    expect(host.calls.some((call) => call.args[0] === "deploy")).toBe(false);
  });

  it("refuses when this AppHost's record is for another resource group", async () => {
    const host = deployedHost();
    const h = harness(host);
    writeRecord(host, thisAppHost(), "other-group");
    expect(await run(["deploy", "--yes"], h.io)).toBe(1);
    expect(h.err()).toContain("Deploy from the checkout that made it");
  });

  it("adopts another checkout's record for the deployment when you agree in a terminal", async () => {
    const host = deployedHost();
    const prompts: string[] = [];
    const h = harness(host, { stdin: { isTTY: true }, stdout: { write: () => undefined, isTTY: true }, confirm: async (question) => (prompts.push(question), true) });
    const source = writeRecord(host, undefined, "managed-copilot-dev");
    expect(await run(["deploy"], h.io)).toBe(0);
    expect(prompts[0]).toContain("Use that record for this AppHost");
    expect(h.err()).toContain(source);
    expect(h.err()).not.toContain("secret-key");
    const adopted = join(host.records, createHash("sha256").update(thisAppHost().toLowerCase()).digest("hex").toUpperCase(), "production.json");
    expect(existsSync(adopted)).toBe(true);
    expect(readFileSync(adopted, "utf8")).toBe(readFileSync(join(source, "production.json"), "utf8"));
    expect(host.calls.some((call) => call.args[0] === "deploy")).toBe(true);
  });

  it("explains missing tools, a stopped Docker, an Azure sign-in, and a failed deploy", async () => {
    const noAz = new FakeHost();
    noAz.installed.delete("az");
    const a = harness(noAz);
    expect(await run(["deploy", "--yes"], a.io)).toBe(1);
    expect(a.err()).toContain("az is not installed.");

    const stopped = new FakeHost();
    stopped.dockerRunning = false;
    const b = harness(stopped);
    expect(await run(["deploy", "--yes"], b.io)).toBe(1);
    expect(b.err()).toContain("Docker isn't running.");

    const signedOut = new FakeHost();
    signedOut.azSignedIn = false;
    const c = harness(signedOut);
    expect(await run(["deploy", "--yes"], c.io)).toBe(1);
    expect(c.err()).toContain("az login");

    const failing = new FakeHost();
    failing.deployExit = 5;
    const d = harness(failing);
    expect(await run(["deploy", "--yes"], d.io)).toBe(1);
    expect(d.err()).toContain("aspire deploy failed (exit 5).");
  });
});
