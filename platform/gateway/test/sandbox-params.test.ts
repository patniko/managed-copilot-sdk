import { describe, expect, it } from "vitest";
import { isManagedCopilotError } from "@managed-copilot/protocol";
import { resolveDockerEndpoints } from "../src/modules/sandbox/docker.js";
import { deferAgentSelection, relativeWithin, rewriteSessionParams } from "../src/modules/sandbox/params.js";

describe("deferAgentSelection", () => {
  it("moves a named agent out of create/resume params so the gateway selects it after credentials are installed", () => {
    expect(deferAgentSelection({ agent: "builder", model: "m" })).toEqual({ params: { model: "m" }, agent: "builder" });
    expect(deferAgentSelection({ model: "m" })).toEqual({ params: { model: "m" } });
    expect(deferAgentSelection({ agent: "", model: "m" })).toEqual({ params: { agent: "", model: "m" } });
  });
});

describe("rewriteSessionParams", () => {
  it("strips GitHub credential fields and defaults the working directory", () => {
    const out = rewriteSessionParams({ gitHubToken: "gho_x", gitHubTokenProviderRegistrationId: "reg", enableManagedSettings: true, model: "m" }, undefined);
    expect(out).toEqual({ model: "m", workingDirectory: "/workspace" });
    expect(rewriteSessionParams({ workingDirectory: "/workspace/app" }, undefined)["workingDirectory"]).toBe("/workspace/app");
  });

  it("rejects custom model providers", () => {
    expect(() => rewriteSessionParams({ provider: { type: "openai", baseUrl: "https://example.com" } }, undefined)).toThrowError(/brokered/);
    try {
      rewriteSessionParams({ provider: {} }, undefined);
    } catch (error) {
      expect(isManagedCopilotError(error, "policy_violation")).toBe(true);
    }
  });

  it("maps the pinned customizations bundle to its read-only mount", () => {
    const root = process.platform === "win32" ? "C:\\data\\customizations\\abc123" : "/data/customizations/abc123";
    const join = (...parts: string[]) => (process.platform === "win32" ? parts.join("\\") : parts.join("/"));
    const out = rewriteSessionParams(
      { skillDirectories: [join(root, "skills"), "/workspace/my-skills"], agentDirectories: [join(root, "agents")], instructionDirectories: [root] },
      root,
    );
    expect(out["skillDirectories"]).toEqual(["/opt/managed-copilot/customizations/skills", "/workspace/my-skills"]);
    expect(out["agentDirectories"]).toEqual(["/opt/managed-copilot/customizations/agents"]);
    expect(out["instructionDirectories"]).toEqual(["/opt/managed-copilot/customizations"]);
  });

  it("matches path prefixes on segment boundaries", () => {
    expect(relativeWithin("/data/bundle/skills/x", "/data/bundle", "linux")).toBe("skills/x");
    expect(relativeWithin("/data/bundle2/skills", "/data/bundle", "linux")).toBeUndefined();
    expect(relativeWithin("/data/bundle", "/data/bundle/", "linux")).toBe("");
  });
});

describe("resolveDockerEndpoints", () => {
  it("honors DOCKER_HOST and platform defaults", () => {
    expect(resolveDockerEndpoints({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" })[0]).toMatchObject({ socketPath: "/run/user/1000/docker.sock" });
    expect(resolveDockerEndpoints({ DOCKER_HOST: "tcp://10.0.0.5:2376" })[0]).toMatchObject({ host: "10.0.0.5", port: 2376 });
    expect(resolveDockerEndpoints({ DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine" })[0]).toMatchObject({ socketPath: "\\\\.\\pipe\\dockerDesktopLinuxEngine" });
    expect(resolveDockerEndpoints({}, "win32").map((endpoint) => endpoint.socketPath)).toEqual(["\\\\.\\pipe\\docker_engine", "\\\\.\\pipe\\dockerDesktopLinuxEngine"]);
    expect(resolveDockerEndpoints({}, "linux")[0]).toMatchObject({ socketPath: "/var/run/docker.sock" });
  });
});
