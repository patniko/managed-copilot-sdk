import { describe, expect, it } from "vitest";
import { LogRing } from "../src/log.js";
import { Metrics } from "../src/metrics.js";
import { harnessOf } from "../src/modules/core/harness.js";
import { sanitizeEventData } from "../src/modules/core/operator.js";
import { looksSecret, redactPath, redactUrl, redactValue, scrubArgs } from "../src/redaction.js";
import { certificateFingerprint } from "../src/modules/network/index.js";

describe("operator redaction", () => {
  it("recognizes credential shapes without masking ordinary identifiers", () => {
    for (const secret of ["ghp_0123456789abcdefghijABCDEFGHIJ", "github_pat_11ABCDEFG0123456789_abcdefghijk", "sk-proj-0123456789abcdefABCD", "xoxb-1234567890-abcdefghij", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "Bearer abc", "mcc_abcdefghijkl", "Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A="]) {
      expect(looksSecret(secret), secret).toBe(true);
    }
    for (const plain of ["", "npx", "@modelcontextprotocol/server-filesystem", "/workspace/data/reports-2026-quarterly", "7f3a2c10-1b2c-4d5e-8f90-0123456789ab", "my-long-kebab-case-name-of-a-thing", "claude-sonnet-5"]) {
      expect(looksSecret(plain), plain).toBe(false);
    }
  });

  it("masks URL query values and user information", () => {
    expect(redactUrl("https://mcp.example.com/mcp?key=abc&key=def&mode=x")).toBe("https://mcp.example.com/mcp?key=***&mode=***");
    expect(redactUrl("https://user:pass@example.com/path")).toBe("https://***@example.com/path");
    expect(redactUrl("https://example.com/plain")).toBe("https://example.com/plain");
    expect(redactUrl("ghp_0123456789abcdefghijABCDEFGHIJ")).toBe("[redacted]");
  });

  it("masks secret-looking path segments and query values of request paths", () => {
    expect(redactPath("/services/T0001/B0002/abcdefghijklmnopqrstuvwxyz123456?token=x&token=y&v=1#frag")).toBe("/services/T0001/B0002/[redacted]?token=***&v=***");
    expect(redactPath("/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1/sendMessage")).toBe("/[redacted]/sendMessage");
    expect(redactPath("/repos/octo/hello/issues")).toBe("/repos/octo/hello/issues");
    expect(redactPath("/v1/ghp_0123456789abcdefghijABCDEFGHIJ/x#only-a-fragment")).toBe("/v1/[redacted]/x");
  });

  it("masks credential arguments of local commands", () => {
    expect(scrubArgs(["-y", "@scope/server", "--token", "plain-value", "--api-key=xyz", "--port", "3000", "ghp_0123456789abcdefghijABCDEFGHIJ", "--url=https://h.example/?sig=1"])).toEqual([
      "-y",
      "@scope/server",
      "--token",
      "[redacted]",
      "--api-key=[redacted]",
      "--port",
      "3000",
      "[redacted]",
      "--url=https://h.example/?sig=***",
    ]);
  });

  it("masks free-form values by key and by shape, and keeps schema property names", () => {
    expect(redactValue({ apiKey: "x", nested: { password: "y", note: "ghp_0123456789abcdefghijABCDEFGHIJ", ok: "fine" } })).toEqual({ apiKey: "[redacted]", nested: { password: "[redacted]", note: "[redacted]", ok: "fine" } });
    expect(redactValue({ properties: { token: { type: "string" } } }, { keys: false })).toEqual({ properties: { token: { type: "string" } } });
  });

  it("computes certificate fingerprints, never exposing the certificate", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAECAwQF\n-----END CERTIFICATE-----\n";
    expect(certificateFingerprint(pem)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(certificateFingerprint("not a certificate")).toBeUndefined();
  });
});

describe("harness view", () => {
  const scrub = (value: unknown) => value;

  it("shows the admitted harness with MCP servers' real destinations and only their header and variable names", () => {
    const harness = harnessOf(
      {
        params: {
          model: "claude-sonnet-5",
          allowedModels: ["claude-sonnet-5"],
          agent: "support",
          systemMessage: { mode: "customize", content: "Be kind.", sections: { environment_context: { action: "replace", content: "<environment_context>…" }, code_change_rules: { action: "remove" } } },
          availableTools: ["builtin:ask_user", "custom:*"],
          mcpServers: {
            docs: { type: "http", url: "http://127.0.0.1:7400/v1/mcp/route_1", headers: { "x-managed-copilot-mcp": "ADAPTER-SECRET" }, tools: ["*"] },
            local: { command: "npx", args: ["-y", "@scope/server", "--token", "ARG-SECRET"], env: { API_KEY: "ENV-SECRET" } },
          },
          customAgents: [{ name: "refunds", description: "Refunds", prompt: "Process refunds.", mcpServers: { billing: { type: "sse", url: "https://billing.example/sse?token=Q-SECRET" } } }],
          skillDirectories: ["/opt/managed-copilot/customizations/skills"],
          enableSkills: true,
          enableConfigDiscovery: false,
          memory: { enabled: false },
          streaming: true,
          infiniteSessions: false,
          reasoningEffort: "high",
          someToken: "OPTION-SECRET",
          label: "ghp_0123456789abcdefghijABCDEFGHIJ",
        },
        requested: {
          mcpServers: { docs: { type: "http", url: "https://mcp.example.com/mcp?key=QUERY-SECRET", headers: { Authorization: "Bearer HEADER-SECRET" }, tools: ["*"] } },
        },
        tools: [{ name: "digest", description: "Daily digest" }],
        callbacks: { tools: [{ name: "lookup_order", parameters: { type: "object", properties: { secret: { type: "string" } } } }], flags: { requestPermission: true, hooks: true } },
        optionsPatch: {},
      },
      { placement: "shared", platformTools: [{ name: "web_fetch", description: "Fetch a page", parameters: { type: "object" }, skipPermission: true, overridesBuiltInTool: true } as never], scrub },
    );
    const text = JSON.stringify(harness);
    for (const secret of ["ADAPTER-SECRET", "ARG-SECRET", "ENV-SECRET", "Q-SECRET", "QUERY-SECRET", "HEADER-SECRET", "OPTION-SECRET", "ghp_0123456789"]) expect(text, secret).not.toContain(secret);
    expect(harness).toMatchObject({
      model: "claude-sonnet-5",
      agent: "support",
      reasoningEffort: "high",
      systemMessage: { mode: "customize", content: "Be kind.", sections: { code_change_rules: { action: "remove" } } },
      availableTools: ["builtin:ask_user", "custom:*"],
      customizations: { agents: false, skills: true, instructions: false },
      skills: { enabled: true },
      callbacks: { tools: ["lookup_order"], flags: ["hooks", "requestPermission"] },
      options: { streaming: true, infiniteSessions: false, label: "[redacted]" },
      enforced: ["enableConfigDiscovery = false", 'memory = {"enabled":false}'],
    });
    expect(harness.options).not.toHaveProperty("someToken");
    expect(harness.mcpServers).toEqual([
      { name: "docs", transport: "http", url: "https://mcp.example.com/mcp?key=***", headers: ["Authorization"], env: [], tools: ["*"], adapter: true },
      { name: "local", transport: "stdio", command: "npx", args: ["-y", "@scope/server", "--token", "[redacted]"], headers: [], env: ["API_KEY"] },
      { name: "billing", transport: "sse", url: "https://billing.example/sse?token=***", headers: [], env: [], agent: "refunds" },
    ]);
    expect(harness.customAgents).toEqual([{ name: "refunds", description: "Refunds", prompt: "Process refunds.", mcpServers: ["billing"] }]);
    expect(harness.tools.map((tool) => `${tool.source}:${tool.name}`)).toEqual(["client:lookup_order", "server:digest", "platform:web_fetch"]);
    expect(harness.tools[0]!.parameters).toEqual({ type: "object", properties: { secret: { type: "string" } } });
  });

  it("treats sessions stored before callback inventories as asking for permission decisions", () => {
    expect(harnessOf({ params: {}, optionsPatch: {} }, { placement: "sandbox", platformTools: [], scrub }).callbacks).toEqual({ tools: [], flags: ["requestPermission"] });
  });

  it("shows the effective configuration: option changes override the session's params", () => {
    const harness = harnessOf(
      {
        params: { model: "claude-sonnet-5", reasoningEffort: "low", availableTools: ["builtin:ask_user"], mcpServers: { docs: { type: "http", url: "http://127.0.0.1:7400/v1/mcp/route_1" } } },
        requested: { mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } },
        optionsPatch: { reasoningEffort: "high", excludedTools: ["web_fetch"], mcpServers: { docs: { type: "http", url: "http://127.0.0.1:7400/v1/mcp/route_2" } } },
        requestedOptions: { mcpServers: { docs: { type: "http", url: "https://docs2.example.com/mcp?key=SECRET" } } },
      },
      { placement: "shared", platformTools: [], scrub },
    );
    expect(harness).toMatchObject({ model: "claude-sonnet-5", reasoningEffort: "high", availableTools: ["builtin:ask_user"], excludedTools: ["web_fetch"] });
    expect(harness.mcpServers).toEqual([{ name: "docs", transport: "http", url: "https://docs2.example.com/mcp?key=***", headers: [], env: [], adapter: true }]);
  });
});

describe("operator event data", () => {
  it("keeps metadata and drops content, credentials, and nested payloads", () => {
    expect(
      sanitizeEventData({
        incarnation: "inc_1",
        status: "completed",
        message: "x".repeat(600),
        prompt: "Summarize the board meeting",
        capability: { token: "mcc_abc" },
        arguments: { q: 1 },
        actions: [{ id: "act_1", kind: "tool", state: "pending", tool: "lookup", idempotencyKey: "k", arguments: { secret: 1 } }],
        artifacts: [{ id: "art_1", path: "report.md", version: 2, size: 10, digest: "d" }],
        network: { access: "restricted", allowedDomains: ["example.com"], extra: 1 },
        path: "/services/T1/B2/abcdefghijklmnopqrstuvwxyz123456?sig=1",
        url: "https://hooks.example.com/x?code=abc",
        nested: { anything: "dropped" },
        apiToken: "x",
      }),
    ).toEqual({
      incarnation: "inc_1",
      status: "completed",
      message: `${"x".repeat(500)}…`,
      actions: [{ id: "act_1", kind: "tool", state: "pending", tool: "lookup" }],
      artifacts: [{ id: "art_1", path: "report.md", version: 2, size: 10 }],
      network: { access: "restricted", allowedDomains: ["example.com"] },
      path: "/services/T1/B2/[redacted]?sig=***",
      url: "https://hooks.example.com/x?code=***",
    });
  });
});

describe("traffic counters and the log ring", () => {
  it("keeps per-minute counts for the last hour", () => {
    let now = Date.UTC(2026, 9, 25, 12, 0, 30);
    const metrics = new Metrics(() => now);
    metrics.increment("rpc.requests", 3);
    now += 60_000;
    metrics.increment("rpc.requests");
    let series = metrics.snapshot()["rpc.requests"]!;
    expect(series.total).toBe(4);
    expect(series.perMinute).toHaveLength(60);
    expect(series.perMinute.slice(-2)).toEqual([3, 1]);
    now += 59 * 60_000;
    series = metrics.snapshot()["rpc.requests"]!;
    expect(series.perMinute.slice(0, 1)).toEqual([1]);
    expect(series.perMinute.reduce((sum, count) => sum + count, 0)).toBe(1);
    now += 3 * 60 * 60_000;
    expect(metrics.snapshot()["rpc.requests"]).toEqual({ total: 4, perMinute: new Array(60).fill(0) });
  });

  it("bounds the log ring, filters by level, and tells listeners without recursion", () => {
    const ring = new LogRing(3);
    const seen: string[] = [];
    ring.subscribe((entry) => {
      seen.push(entry.message);
      ring.push({ at: "t", level: "debug", logger: "listener", message: "from listener" });
    });
    for (const [level, message] of [["info", "a"], ["warn", "b"], ["error", "c"], ["info", "d"]] as const) ring.push({ at: "t", level, logger: "test", message });
    // Listeners hear every entry once; an entry a listener writes is recorded but not dispatched to it again.
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(ring.recent().map((entry) => entry.message)).toEqual(["from listener", "d", "from listener"]);
    expect(ring.recent({ level: "info" }).map((entry) => entry.message)).toEqual(["d"]);
    expect(ring.recent({ level: "warn" })).toEqual([]);
    expect(ring.recent({ limit: 1 })).toHaveLength(1);
    expect(ring.recent().map((entry) => entry.seq)).toEqual([6, 7, 8]);
  });
});
