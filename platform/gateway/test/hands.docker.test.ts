// The hands tools' helper commands (`view`, `glob`, `grep`) and `bash` output handling, run for real in a container
// of the sandbox image as the workload identity (uid 10001, /workspace). Opt in with MANAGED_COPILOT_E2E=1; it needs
// Docker and the sandbox image (MANAGED_COPILOT_SANDBOX_IMAGE, default ghcr.io/patniko/managed-copilot-sandbox:0.1.0).
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExecResult } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformToolCallContext } from "../src/modules/core/contracts.js";
import type { SandboxesService } from "../src/modules/sandbox/contract.js";
import { HandsTools } from "../src/modules/orchestrator/hands.js";
import type { WorkerManager } from "../src/modules/orchestrator/service.js";

const enabled = process.env.MANAGED_COPILOT_E2E === "1";
const image = process.env.MANAGED_COPILOT_SANDBOX_IMAGE ?? "ghcr.io/patniko/managed-copilot-sandbox:0.1.0";
const container = `mc-hands-${randomUUID().slice(0, 8)}`;

describe.runIf(enabled)("hands tool commands in a real sandbox container", () => {
  let tools: HandsTools;
  let calls = 0;
  const context = (): PlatformToolCallContext => ({ sessionId: "s", ownerId: 1, environment: "operator", toolCallId: `t${++calls}`, idempotencyKey: `s:t${calls}`, actionId: `a${calls}` });
  const sh = (script: string, user = "10001") => spawnSync("docker", ["exec", "-u", user, "-w", "/workspace", container, "bash", "-c", script], { encoding: "utf8" });

  beforeAll(() => {
    execFileSync("docker", ["run", "-d", "--rm", "--name", container, "--network", "none", "--entrypoint", "sleep", image, "infinity"]);
    sh("mkdir -p /workspace && chown 10001:10001 /workspace", "0");
    sh(
      [
        "mkdir -p src/pkg .hidden outputs",
        "printf 'alpha\\nbeta TODO\\ngamma\\n' > src/main.py",
        "printf 'export const x = 1; // TODO later\\n' > src/pkg/util.ts",
        "printf 'secret\\n' > .hidden/h.txt",
        "(yes abcdefghi | head -c 30000) > big.txt",
        "printf '\\x00\\x01binary' > blob.bin",
        "ln -s /etc/passwd outside",
        "ln -s src/main.py inside",
      ].join(" && "),
    );
    const sandboxes = {
      exec: async (_session: string, command: string): Promise<ExecResult> => {
        const result = sh(command);
        const output = `${result.stdout}${result.stderr}`;
        return { id: "ex_1", sessionId: "s", command, state: "completed", background: false, exitCode: result.status ?? 0, startedAt: "", outputBytes: output.length, output, offset: output.length };
      },
    } as unknown as SandboxesService;
    const manager = { hands: async () => ({ record: { id: "s" }, sandboxId: "x" }) } as unknown as WorkerManager;
    tools = new HandsTools(manager, () => sandboxes);
  }, 120_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", container]);
  });

  it("views files with line numbers, ranges, truncation, directories, and links inside /workspace only", async () => {
    expect(await tools.view({ path: "/workspace/src/main.py" }, context())).toBe("1. alpha\n2. beta TODO\n3. gamma");
    expect(await tools.view({ path: "/workspace/src/main.py", view_range: [2, -1] }, context())).toBe("2. beta TODO\n3. gamma");
    expect(await tools.view({ path: "/workspace/src/main.py", view_range: [1, 1] }, context())).toBe("1. alpha");
    expect(await tools.view({ path: "/workspace/inside" }, context())).toBe("1. alpha\n2. beta TODO\n3. gamma");
    await expect(tools.view({ path: "/workspace/outside" }, context())).rejects.toMatchObject({ code: "forbidden" });
    await expect(tools.view({ path: "/workspace/missing.txt" }, context())).rejects.toMatchObject({ code: "not_found" });
    expect(await tools.view({ path: "/workspace/big.txt" }, context())).toContain("[File truncated: showing the first 20480 of 30000 bytes.");
    expect(await tools.view({ path: "/workspace/blob.bin" }, context())).toContain("is a binary file");
    const listing = await tools.view({ path: "/workspace" }, context());
    expect(listing.split("\n")).toEqual(expect.arrayContaining(["src", "src/main.py", "src/pkg", "big.txt"]));
    expect(listing).not.toContain(".hidden");
    expect(await tools.view({ path: "/workspace/outputs" }, context())).toBe("/workspace/outputs is an empty directory.");
  });

  it("globs and greps with ripgrep, skipping hidden files", async () => {
    expect((await tools.glob({ pattern: "**/*.{py,ts}" }, context())).split("\n").sort()).toEqual(["/workspace/src/main.py", "/workspace/src/pkg/util.ts"]);
    expect(await tools.glob({ pattern: "*.md" }, context())).toBe("No files matched the pattern.");
    expect(await tools.glob({ pattern: "*.py", paths: "/workspace/src" }, context())).toBe("/workspace/src/main.py");
    await expect(tools.glob({ pattern: "*", paths: ["/workspace/outside"] }, context())).rejects.toMatchObject({ code: "forbidden" });
    await expect(tools.glob({ pattern: "*", paths: ["/workspace/src", "/workspace/outside"] }, context())).rejects.toMatchObject({ code: "forbidden" });
    await expect(tools.glob({ pattern: "[unclosed" }, context())).rejects.toMatchObject({ code: "invalid_request" });

    expect((await tools.grep({ pattern: "TODO" }, context())).split("\n").sort()).toEqual(["/workspace/src/main.py", "/workspace/src/pkg/util.ts"]);
    expect(await tools.grep({ pattern: "todo", "-i": true, output_mode: "content", "-n": true, type: "py" }, context())).toBe("/workspace/src/main.py:2:beta TODO");
    expect(await tools.grep({ pattern: "TODO", output_mode: "count", glob: "*.ts" }, context())).toBe("/workspace/src/pkg/util.ts:1");
    expect(await tools.grep({ pattern: "secret" }, context())).toBe("No matches found.");
    expect(await tools.grep({ pattern: "alpha", output_mode: "content", "-A": 1, paths: "/workspace/src/main.py" }, context())).toBe("alpha\nbeta TODO");
    await expect(tools.grep({ pattern: "(" }, context())).rejects.toMatchObject({ code: "invalid_request" });
    // Arguments are data, never shell: a pattern can't run commands.
    expect(await tools.grep({ pattern: "$(touch /workspace/pwned)" }, context())).toBe("No matches found.");
    expect(sh("test -e /workspace/pwned && echo yes || echo no").stdout.trim()).toBe("no");
  });
});
