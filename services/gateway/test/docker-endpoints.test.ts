import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { DockerClient, discoverDockerEndpoints } from "../src/modules/sandbox/providers/docker/docker.js";
import { createDockerSandboxProvider } from "../src/modules/sandbox/providers/docker/provider.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: inspect,
}));

function context(host: string, tlsMaterial: string[] = []): void {
  inspect.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify({
    Endpoints: { docker: { Host: host } },
    TLSMaterial: { docker: tlsMaterial },
  })));
}

beforeEach(() => {
  inspect.mockReset();
});

describe("Docker endpoint discovery", () => {
  it("keeps explicit DOCKER_HOST behavior without requiring the Docker CLI", async () => {
    expect(await discoverDockerEndpoints({ DOCKER_HOST: "unix:///explicit/docker.sock" })).toEqual([{ socketPath: "/explicit/docker.sock", label: "unix:///explicit/docker.sock" }]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ["unix:///Users/example/.docker/run/docker.sock", "/Users/example/.docker/run/docker.sock"],
    ["unix:///Users/example/.colima/default/docker.sock", "/Users/example/.colima/default/docker.sock"],
    ["unix:///run/user/1000/docker.sock", "/run/user/1000/docker.sock"],
    ["unix:///var/run/docker.sock", "/var/run/docker.sock"],
    ["npipe:////./pipe/docker_engine", "\\\\.\\pipe\\docker_engine"],
  ])("uses Docker's selected endpoint: %s", async (host, socketPath) => {
    context(host);
    expect(await discoverDockerEndpoints({})).toEqual([{ socketPath, label: host }]);
  });

  it("passes context, host, and configuration overrides to Docker to resolve their precedence", async () => {
    const env = { DOCKER_CONTEXT: "custom", DOCKER_CONFIG: "/custom/docker-config", DOCKER_HOST: "tcp://127.0.0.1:2375" };
    context("unix:///custom/selected.sock");
    expect(await discoverDockerEndpoints(env)).toEqual([{ socketPath: "/custom/selected.sock", label: "unix:///custom/selected.sock" }]);
    expect(inspect).toHaveBeenCalledWith("docker", ["context", "inspect", "--format", "{{json .}}"], expect.objectContaining({ env, timeout: 5_000, windowsHide: true }), expect.any(Function));
  });

  it("does not fall back to another daemon for unsupported contexts", async () => {
    context("ssh://host");
    await expect(discoverDockerEndpoints({})).rejects.toMatchObject({ code: "capability_unavailable" });
    context("tcp://host:2376", ["ca.pem", "cert.pem", "key.pem"]);
    await expect(discoverDockerEndpoints({})).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("rejects malformed discovery output without exposing it", async () => {
    for (const output of ["invalid-secret", "{}"]) {
      inspect.mockImplementation((_file, _args, _options, callback) => callback(null, output));
      await expect(discoverDockerEndpoints({})).rejects.toMatchObject({ code: "capability_unavailable", message: "Docker endpoint discovery returned invalid context metadata." });
    }
  });

  it("reports failed discovery through readiness and retries instead of preventing provider construction", async () => {
    inspect.mockImplementation((_file, _args, _options, callback) => callback({ code: "ENOENT" }));
    const provider = createDockerSandboxProvider({ env: {}, log: createLogger("test", "error"), instance: "test", platformKey: "test", appHostDir: process.cwd(), dataDir: process.cwd() });
    expect(inspect).not.toHaveBeenCalled();
    await expect(provider.ready()).rejects.toMatchObject({ code: "capability_unavailable", message: expect.stringContaining("Docker CLI could not be found") });
    await expect(provider.ready()).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("pings the discovered endpoint and retains it after discovery", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Version: "test", Os: "linux", Arch: "arm64" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      context(`tcp://127.0.0.1:${port}`);
      const docker = new DockerClient(() => discoverDockerEndpoints({}));
      await expect(docker.ping()).resolves.toEqual({ version: "test", os: "linux", arch: "arm64" });
      await docker.ping();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(docker.endpoint.label).toBe(`tcp://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
