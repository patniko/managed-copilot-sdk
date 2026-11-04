import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachMaterial } from "@managed-copilot/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import { copilotSpawnArguments, findCopilot, launchAttachedCli } from "../src/features/cli.js";
import { HttpClient } from "../src/http.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new actual.ChildProcess();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }),
  };
});

const windows = process.platform === "win32";
// Spaces, parentheses, and an ampersand in the folder exercise cmd.exe's own parsing of the command path.
const folder = mkdtempSync(join(tmpdir(), "mc spawn (a&b) "));
const echo = join(folder, "echo.cjs");
writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
const shim = join(folder, windows ? "copilot.cmd" : "copilot");
// The same shape as npm's cmd-shim: the batch file forwards its arguments with %*.
writeFileSync(shim, windows ? `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n` : "#!/bin/sh\n");

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("launching the stock Copilot CLI", () => {
  it("explicitly enables GitHub authentication to the loopback relay", async () => {
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("MANAGED_COPILOT_HOME", folder);
    const http = new HttpClient("http://127.0.0.1:7400", "test-token");
    vi.spyOn(http, "get").mockResolvedValue({ owner: { id: 42, login: "octo" } });
    const material: AttachMaterial = {
      transport: "ahp",
      url: "ws://127.0.0.1:7400/v1/sessions/s1/ahp",
      token: "test-ticket",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ahpSessionId: "ahp-session:/s1",
    };
    vi.spyOn(http, "post").mockResolvedValue(material);
    try {
      await expect(launchAttachedCli(
        { url: "http://127.0.0.1:7400", httpFor: () => http },
        "s1",
        { copilotPath: process.execPath },
      )).resolves.toEqual({ exitCode: 0 });
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ["--ahp", expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/ahp\//), "--ahp-authenticate", "github"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    } finally {
      if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it("resolves an explicit path without an extension, and copilot on PATH", () => {
    const explicit = findCopilot(join(folder, "copilot"));
    expect(explicit).toEqual({ file: shim, shell: windows });
    const path = process.env.PATH;
    process.env.PATH = folder;
    try {
      expect(findCopilot().file.toLowerCase()).toBe(shim.toLowerCase());
    } finally {
      process.env.PATH = path;
    }
    expect(() => findCopilot(join(folder, "missing"))).toThrow(/Copilot CLI was not found at/);
  });

  it("passes executables their arguments unchanged", () => {
    expect(copilotSpawnArguments({ file: "/usr/bin/copilot", shell: false }, ["--ahp", "ws://x"])).toEqual({
      file: "/usr/bin/copilot",
      args: ["--ahp", "ws://x"],
      windowsVerbatimArguments: false,
    });
  });

  it.runIf(windows)("runs a .cmd shim through cmd.exe with every argument arriving verbatim", () => {
    const args = [
      "--ahp",
      "ws://127.0.0.1:52144/ahp/Zm9v_YmFy-123",
      'quote " inside',
      "100% %PATH% %USERNAME",
      "a & b | c > d < e ^ f",
      "(paren) !bang! `tick` ;,=",
      "trailing backslash\\",
      'back\\\\slash \\"quoted\\"',
      "",
    ];
    const command = copilotSpawnArguments({ file: shim, shell: true }, args);
    const result = spawnSync(command.file, command.args, { windowsVerbatimArguments: command.windowsVerbatimArguments, encoding: "utf8", windowsHide: true });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});
