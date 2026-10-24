import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The image's registry guard (image/check-registry-url.sh) runs before any registry URL is written into the image's
// npm or pip configuration. Runs wherever a POSIX sh is available (Linux, macOS, Git for Windows).
const sh = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;
const dir = mkdtempSync(join(tmpdir(), "mc-registry-guard-"));
const script = join(dir, "check-registry-url.sh");
// The image build normalizes line endings the same way (sed) before running it.
writeFileSync(script, readFileSync(join(import.meta.dirname, "..", "image", "check-registry-url.sh"), "utf8").replace(/\r\n/g, "\n"));

// Passed the way the Dockerfile passes it: from a variable (a build argument), quoted. Windows command lines cannot
// carry every character (Git for Windows' sh cuts an argument at a line break), but environment values can.
function guard(value: string): { status: number | null; stderr: string } {
  const result = spawnSync("sh", ["-c", 'sh "$0" NPM_REGISTRY "${GUARD_VALUE}"', script], { encoding: "utf8", env: { ...process.env, GUARD_VALUE: value } });
  return { status: result.status, stderr: result.stderr };
}

describe.runIf(sh)("image registry guard", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts plain registry URLs and an empty optional setting", () => {
    for (const value of ["", "https://registry.npmjs.org/", "http://proxy.internal:8080/npm/", "HTTPS://packagefeedproxy.microsoft.io/pypi/simple/", "https://host/npm/@scope/"]) {
      expect(guard(value), value).toEqual({ status: 0, stderr: "" });
    }
  });

  it("refuses credentials, query strings, fragments, and other schemes without printing the value", () => {
    const cases: [string, RegExp][] = [
      ["https://user:hunter2-secret@registry.example/", /credentials/],
      ["https://tok_hunter2-secret@registry.example/npm/", /credentials/],
      ["https://@registry.example/", /credentials/],
      // URL parsers (and so npm and pip) skip extra slashes before the host: these carry or could hide user info.
      ["https:///user:hunter2-secret@registry.example/", /extra slashes/],
      ["https:////hunter2-secret@registry.example/", /extra slashes/],
      ["HTTPS:///registry.example/hunter2-secret/", /extra slashes/],
      ["https://", /extra slashes/],
      ["https://registry.example\\user:hunter2-secret@evil.example/", /backslashes/],
      ["https://registry.example/simple?token=hunter2-secret", /query string or fragment/],
      ["https://registry.example/simple#hunter2-secret", /query string or fragment/],
      ["ftp://hunter2-secret.example/", /http\(s\) URL/],
      ["https:/registry.example/hunter2-secret", /http\(s\) URL/],
      // A line break, or an escape that a shell's echo expands, would add its own npmrc line, such as an auth token.
      ["https://registry.example/\n//registry.example/:_authToken=hunter2-secret", /line breaks/],
      ["https://registry.example/\\n//registry.example/:_authToken=hunter2-secret", /backslashes/],
      ["https://registry.example/\thunter2-secret", /line breaks/],
      ["https://registry.example/ hunter2-secret", /line breaks/],
    ];
    for (const [value, message] of cases) {
      const result = guard(value);
      expect(result.status, value).toBe(1);
      expect(result.stderr, value).toMatch(message);
      expect(result.stderr, value).not.toContain("hunter2");
    }
  });
});

describe("image registry configuration", () => {
  it("runs the guard before writing the URLs, and writes them with printf %s (dash's echo would expand escapes)", () => {
    const dockerfile = readFileSync(join(import.meta.dirname, "..", "image", "Dockerfile"), "utf8").replace(/\r\n/g, "\n");
    const guarded = dockerfile.indexOf('sh /tmp/check-registry-url.sh NPM_REGISTRY "${NPM_REGISTRY}"');
    const pipGuarded = dockerfile.indexOf('sh /tmp/check-registry-url.sh PIP_INDEX_URL "${PIP_INDEX_URL}"');
    const npmWritten = dockerfile.indexOf(`printf 'registry=%s\\n' "\${NPM_REGISTRY}" >> /usr/local/lib/node_modules/npm/npmrc`);
    const pipWritten = dockerfile.indexOf(`printf '[global]\\nindex-url = %s\\n' "\${PIP_INDEX_URL}" > /etc/pip.conf`);
    expect([guarded, pipGuarded, npmWritten, pipWritten].every((index) => index > 0)).toBe(true);
    expect(guarded < npmWritten && pipGuarded < pipWritten).toBe(true);
    expect(dockerfile).not.toMatch(/echo[^\n]*\$\{(NPM_REGISTRY|PIP_INDEX_URL)\}/);
  });
});
