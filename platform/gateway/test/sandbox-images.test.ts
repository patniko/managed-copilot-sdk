import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isManagedCopilotError } from "@managed-copilot/protocol";
import { createLogger } from "../src/log.js";
import type { DockerClient } from "../src/modules/sandbox/providers/docker/docker.js";
import { checkRegistryUrl, registrySettingProblems, SandboxImages } from "../src/modules/sandbox/providers/docker/images.js";

const SECRET = "hunter2-secret";
const source = { setting: "MANAGED_COPILOT_NPM_REGISTRY", fix: "Use a plain URL." };

function refusal(run: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isManagedCopilotError(caught, "capability_unavailable"), String(caught)).toBe(true);
  expect((caught as Error).message).toMatch(message);
  expect((caught as Error).message).not.toContain("hunter2");
}

describe("checkRegistryUrl", () => {
  it("accepts plain http(s) registry URLs, trimmed", () => {
    for (const value of ["https://registry.npmjs.org/", "http://proxy.internal:8080/npm/", "https://packagefeedproxy.microsoft.io/pypi/simple/", "https://host/npm/@scope/"]) {
      expect(checkRegistryUrl(value, source)).toBe(value);
    }
    expect(checkRegistryUrl("  https://registry.npmjs.org/\n", source)).toBe("https://registry.npmjs.org/");
  });

  it("refuses URLs that carry credentials, without repeating them", () => {
    refusal(() => checkRegistryUrl(`https://user:${SECRET}@registry.example/npm/`, source), /MANAGED_COPILOT_NPM_REGISTRY contains credentials \(https:\/\/<credentials>@registry\.example\)/);
    refusal(() => checkRegistryUrl(`https://${SECRET}@registry.example/`, source), /contains credentials/);
    refusal(() => checkRegistryUrl(`https://registry.example/simple?token=${SECRET}`, source), /query string or fragment \(https:\/\/registry\.example\)/);
    refusal(() => checkRegistryUrl(`https://registry.example/simple#${SECRET}`, source), /query string or fragment/);
    refusal(() => checkRegistryUrl(`ftp://${SECRET}.example/`, source), /must be an http\(s\) URL/);
    refusal(() => checkRegistryUrl(`not a url ${SECRET}`, source), /without spaces/);
    refusal(() => checkRegistryUrl(`notaurl-${SECRET}`, source), /is not a valid URL/);
    // Parsers normalize this to user info, so it is refused too.
    refusal(() => checkRegistryUrl(`  https://user:${SECRET}@registry.example/  `, source), /contains credentials/);
    // As written, this carries user info that URL parsing hides (an empty `@`).
    refusal(() => checkRegistryUrl("https://@registry.example/", source), /contains credentials/);
    // A line break, or an escape that a shell's echo expands, would add its own npmrc or pip.conf line, such as an
    // auth token; backslashes also hide user info from URL parsing.
    refusal(() => checkRegistryUrl(`https://registry.example/\n//registry.example/:_authToken=${SECRET}`, source), /line breaks/);
    refusal(() => checkRegistryUrl(`https://registry.example/\\n//registry.example/:_authToken=${SECRET}`, source), /backslashes/);
    refusal(() => checkRegistryUrl(`https://registry.example/\t${SECRET}`, source), /line breaks/);
    refusal(() => checkRegistryUrl(`https:\\\\user:${SECRET}@registry.example/`, source), /backslashes/);
    refusal(() => checkRegistryUrl(`https://registry.example\\user:${SECRET}@evil.example/`, source), /backslashes/);
    // The image's guard requires the scheme's `//` and refuses an empty query; so does the gateway.
    refusal(() => checkRegistryUrl("https:/registry.example/", source), /must start with http:\/\/ or https:\/\//);
    refusal(() => checkRegistryUrl("https://registry.example/simple/?", source), /query string or fragment/);
    // Messages never show the path, which some registries use for tokens.
    refusal(() => checkRegistryUrl(`https://registry.example/${SECRET}/npm/?x=1`, source), /query string or fragment/);
  });

  it("reports explicitly configured settings that will be refused, for the startup warning", () => {
    expect(registrySettingProblems({ MANAGED_COPILOT_NPM_REGISTRY: "https://registry.npmjs.org/", MANAGED_COPILOT_PIP_INDEX_URL: "" })).toEqual([]);
    const problems = registrySettingProblems({ MANAGED_COPILOT_NPM_REGISTRY: `https://u:${SECRET}@r.example/`, MANAGED_COPILOT_PIP_INDEX_URL: `https://r.example/simple?key=${SECRET}` });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^MANAGED_COPILOT_NPM_REGISTRY contains credentials/);
    expect(problems[1]).toMatch(/^MANAGED_COPILOT_PIP_INDEX_URL has a query string/);
    expect(problems.join("\n")).not.toContain("hunter2");
  });
});

describe("SandboxImages registries", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function images(env: Record<string, string | undefined>, host: Record<string, string | undefined> = {}) {
    const docker = { inspectImage: vi.fn(async () => undefined), tagImage: vi.fn(async () => undefined) };
    const context = mkdtempSync(join(tmpdir(), "mc-images-"));
    dirs.push(context);
    mkdirSync(join(context, "image"), { recursive: true });
    mkdirSync(join(context, "dist", "sandboxd"), { recursive: true });
    writeFileSync(join(context, "image", "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(context, "dist", "sandboxd", "main.js"), "\n");
    const read = vi.fn(async (command: string) => (command.startsWith("npm") ? host.npm : host.pip));
    const built = new SandboxImages({ docker: docker as unknown as DockerClient, log: createLogger("test", "error"), env, appHostDir: context, contextDir: context, hostConfig: read });
    return { built, docker, read };
  }

  it("refuses credentialed registries from settings or the host's tools before anything is built", async () => {
    for (const [env, host, message] of [
      [{ MANAGED_COPILOT_NPM_REGISTRY: `https://u:${SECRET}@registry.example/` }, {}, /^MANAGED_COPILOT_NPM_REGISTRY contains credentials/],
      [{}, { npm: `https://u:${SECRET}@registry.example/` }, /^The host's npm registry \(`npm config get registry`\) contains credentials.*MANAGED_COPILOT_NPM_REGISTRY/s],
      [{ MANAGED_COPILOT_NPM_REGISTRY: "https://registry.npmjs.org/" }, { pip: `global.index-url='https://u:${SECRET}@pypi.example/simple/'` }, /^The host's pip index.*contains credentials.*MANAGED_COPILOT_PIP_INDEX_URL.*empty value/s],
      [{ MANAGED_COPILOT_NPM_REGISTRY: "https://registry.npmjs.org/", MANAGED_COPILOT_PIP_INDEX_URL: `https://pypi.example/simple/?t=${SECRET}` }, {}, /^MANAGED_COPILOT_PIP_INDEX_URL has a query string/],
    ] as const) {
      const { built, docker } = images({ ...env }, { ...host });
      const error = await built.ensureBase().catch((caught: unknown) => caught);
      expect(isManagedCopilotError(error, "capability_unavailable"), String(error)).toBe(true);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain("hunter2");
      // Refused before the image tag is even looked up, so no build (and no build argument) ever sees it.
      expect(docker.inspectImage).not.toHaveBeenCalled();
    }
  });

  it("passes plain registries through, honors an empty pip setting, and re-reads a refused configuration", async () => {
    const env: Record<string, string | undefined> = { MANAGED_COPILOT_PIP_INDEX_URL: "" };
    const { built, read } = images(env, { npm: `https://u:${SECRET}@registry.example/`, pip: `global.index-url='https://u:${SECRET}@pypi.example/'` });
    await expect(built.registries()).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "capability_unavailable"));
    env.MANAGED_COPILOT_NPM_REGISTRY = "https://registry.npmjs.org/";
    expect(await built.registries()).toEqual({ npm: "https://registry.npmjs.org/", pip: undefined });
    // An explicitly empty pip setting means pip's default index; the host's (credentialed) one is never read.
    expect(read.mock.calls.map(([command]) => command)).toEqual(["npm config get registry"]);
  });
});
