import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { ManagedCopilot } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { AppError } from "../src/server/errors.js";
import { ManagedPlatform, type Person } from "../src/server/platform.js";

type Acting = { readonly gitHubToken?: string; readonly appUser?: { readonly id: string; readonly name?: string } };

/** A stand-in for `ManagedCopilot`: records who it acts for and which environments its clients use. */
function fakeManaged(log: string[], options: { identity: string; environments?: { name: string; inference?: { foundry: string }; models?: string[] }[] }): ManagedCopilot {
  const managed = {
    url: "http://localhost:9400",
    account: { id: 1, login: options.identity },
    info: { environments: options.environments ?? [] },
    client: async (environment: string) => {
      log.push(`client ${options.identity} ${environment}`);
      return { ping: async () => ({}) };
    },
    sessions: { delete: async (id: string) => void log.push(`delete ${options.identity} ${id}`) },
    as: async (user: Acting) => {
      const identity = user.gitHubToken ? `github:${user.gitHubToken}` : `app-user:${user.appUser!.id}:${user.appUser!.name}`;
      log.push(`as ${identity}`);
      return fakeManaged(log, { identity });
    },
    close: async () => void log.push(`close ${options.identity}`),
  };
  return managed as unknown as ManagedCopilot;
}

const config = loadConfig({ PORT: "7450" });
const github: Person = { kind: "github", userId: "u_gh", login: "octo", token: "gho_one" };
const appUser: Person = { kind: "app", userId: "u_mail", name: "Ada Rivera", email: "ada@example.com" };
const FOUNDRY_ENVIRONMENTS = [{ name: "front-desk" }, { name: "front-desk-foundry", inference: { foundry: "mc-foundry-dev" }, models: ["grok-4.7"] }];

describe("platform, with an app key", () => {
  it("acts for GitHub users with their token and for everyone else as app users on Foundry", async () => {
    const log: string[] = [];
    const connects: unknown[] = [];
    const platform = new ManagedPlatform({
      config,
      appKey: "app-key",
      connect: async (credential) => {
        connects.push(credential);
        return fakeManaged(log, { identity: "app", environments: FOUNDRY_ENVIRONMENTS });
      },
    });
    platform.start();
    const forGitHub = await platform.open(github);
    await forGitHub.client();
    expect(forGitHub.route).toEqual({ route: "copilot", environment: "front-desk", model: "claude-sonnet-5" });

    expect(platform.appUsers()).toEqual({ available: true });
    const forAppUser = await platform.open(appUser);
    await forAppUser.client();
    await forAppUser.deleteSession("s1");
    expect(forAppUser.route).toEqual({ route: "foundry", environment: "front-desk-foundry", model: "grok-4.7" });

    expect(connects).toEqual([{ appKey: "app-key" }]);
    expect(log).toEqual(["as github:gho_one", "client github:gho_one front-desk", "as app-user:u_mail:Ada Rivera", "client app-user:u_mail:Ada Rivera front-desk-foundry", "delete app-user:u_mail:Ada Rivera s1"]);
    await platform.closeAll();
  });

  it("opens a new connection for a new GitHub token and closes the old one", async () => {
    const log: string[] = [];
    const platform = new ManagedPlatform({ config, appKey: "app-key", connect: async () => fakeManaged(log, { identity: "app", environments: FOUNDRY_ENVIRONMENTS }) });
    const first = await platform.open(github);
    expect(await platform.open(github)).toBe(first);
    const second = await platform.open({ ...github, token: "gho_two" });
    expect(second).not.toBe(first);
    expect(log).toEqual(["as github:gho_one", "close github:gho_one", "as github:gho_two"]);
  });

  it("says why people without GitHub can't chat when the deployment has no Foundry environment, and keeps GitHub users working", async () => {
    const platform = new ManagedPlatform({ config, appKey: "app-key", connect: async () => fakeManaged([], { identity: "app", environments: [{ name: "front-desk" }] }) });
    await platform.open(github);
    expect(platform.appUsers()).toEqual({ available: false, reason: expect.stringContaining('no "front-desk-foundry" environment') });
    await expect(platform.open(appUser)).rejects.toMatchObject({ code: "app_users_unavailable", status: 503 });

    const notFoundry = new ManagedPlatform({ config, appKey: "app-key", connect: async () => fakeManaged([], { identity: "app", environments: [{ name: "front-desk-foundry" }] }) });
    await notFoundry.open(github);
    expect(notFoundry.appUsers().reason).toContain("doesn't send model calls to Azure AI Foundry");
  });

  it("fails explicitly when the platform refuses the app key, never as the person's own problem or another account", async () => {
    const platform = new ManagedPlatform({
      config,
      appKey: "wrong-key",
      connect: async () => {
        throw new ManagedCopilotError("authentication_required", "Unknown app key");
      },
    });
    const refused = await platform.open(github).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: "app_key_rejected", status: 503 });
    expect(platform.appUsers()).toEqual({ available: false, reason: expect.stringContaining("didn't accept Front Desk's app key") });
    await platform.closeAll();
  });
});

describe("platform, without an app key", () => {
  it("connects as each GitHub user with their own token, and turns people without GitHub away with a reason", async () => {
    const log: string[] = [];
    const connects: unknown[] = [];
    const platform = new ManagedPlatform({
      config,
      connect: async (credential) => {
        connects.push(credential);
        return fakeManaged(log, { identity: `github:${credential.gitHubToken}` });
      },
    });
    const connection = await platform.open(github);
    await connection.client();
    expect(connects).toEqual([{ gitHubToken: "gho_one" }]);
    expect(log).toEqual(["client github:gho_one front-desk"]);
    expect(platform.appUsers()).toEqual({ available: false, reason: expect.stringContaining("no app key") });
    await expect(platform.open(appUser)).rejects.toMatchObject({ code: "app_users_unavailable" });
    expect(connects).toHaveLength(1);
  });

  it("reports a rejected GitHub token as the person's sign-in ending", async () => {
    const platform = new ManagedPlatform({
      config,
      connect: async () => {
        throw new ManagedCopilotError("authentication_required", "Bad credentials");
      },
    });
    await expect(platform.open(github)).rejects.toMatchObject({ code: "github_sign_in_expired", status: 401 });
  });
});
