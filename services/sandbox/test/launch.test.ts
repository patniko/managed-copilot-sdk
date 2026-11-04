import { describe, expect, it } from "vitest";
import { asWorkload } from "../src/sandboxd/exec.js";

describe("asWorkload", () => {
  const identity = { uid: 10001, gid: 10001 };

  it("keeps the workload's environment away from the launcher that still runs as root", () => {
    const launch = asWorkload(identity, "/workspace", "/bin/bash", ["-c", "true"], { LD_AUDIT: "/workspace/audit.so", GLIBC_TUNABLES: "x", HOME: "/home/agent" });
    // setpriv is exec'd as root: it must only ever see the fixed launch environment.
    expect(launch.command).toBe("/usr/bin/setpriv");
    expect(launch.env).toEqual({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
    expect(launch.cwd).toBe("/");
    const drop = launch.args.indexOf("--");
    expect(launch.args.slice(0, drop)).toEqual(["--reuid=10001", "--regid=10001", "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all"]);
    // The workload's environment is installed only after the drop, by env(1) running as the workload identity.
    expect(launch.args.slice(drop + 1)).toEqual(["/usr/bin/env", "-i", "-C", "/workspace", "--", "LD_AUDIT=/workspace/audit.so", "GLIBC_TUNABLES=x", "HOME=/home/agent", "/bin/bash", "-c", "true"]);
  });

  it("refuses names env(1) would misread and values the kernel cannot carry", () => {
    expect(() => asWorkload(identity, "/", "/bin/true", [], { "A=B": "x" })).toThrow(/Invalid environment variable name/);
    expect(() => asWorkload(identity, "/", "/bin/true", [], { "-i": "x" })).toThrow(/Invalid environment variable name/);
    expect(() => asWorkload(identity, "/", "/bin/true", [], { OK: "a\u0000b" })).toThrow(/NUL/);
  });
});
