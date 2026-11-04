import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copilotSpawnArguments, findCopilot } from "../src/features/cli.js";

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
