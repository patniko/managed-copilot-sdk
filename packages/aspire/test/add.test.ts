import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManagedCopilot } from "../src/add.js";
import type { AspireBuilder, AspireNodeAppBuilder, AspireNodeAppResource } from "../src/aspire.js";

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

class FakeEndpoint {
  constructor(readonly resource: string, readonly name: string) {}
}

class FakeNodeApp implements AspireNodeAppResource {
  constructor(readonly name: string) {}
  getEndpoint(name: string): PromiseLike<object> {
    return Promise.resolve(new FakeEndpoint(this.name, name));
  }
}

class FakeNodeAppBuilder implements AspireNodeAppBuilder {
  readonly calls: Call[] = [];
  constructor(readonly resource: FakeNodeApp) {}
  #record(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }
  withPnpm(...args: unknown[]) {
    return this.#record("withPnpm", args);
  }
  withHttpEndpoint(...args: unknown[]) {
    return this.#record("withHttpEndpoint", args);
  }
  withHttpHealthCheck(...args: unknown[]) {
    return this.#record("withHttpHealthCheck", args);
  }
  withEnvironment(...args: unknown[]) {
    return this.#record("withEnvironment", args);
  }
  withIconName(...args: unknown[]) {
    return this.#record("withIconName", args);
  }
  then<T1 = AspireNodeAppResource, T2 = never>(
    onfulfilled?: ((value: AspireNodeAppResource) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.resource as AspireNodeAppResource).then(onfulfilled, onrejected);
  }
}

class FakeParameter {
  constructor(readonly name: string) {}
}

class FakeBuilder implements AspireBuilder {
  readonly apps: { name: string; directory: string; script: string; builder: FakeNodeAppBuilder }[] = [];
  readonly parameters: { name: string; options: unknown }[] = [];
  constructor(readonly directory: string, readonly publish = false) {}
  appHostDirectory() {
    return Promise.resolve(this.directory);
  }
  executionContext() {
    return { isPublishMode: () => Promise.resolve(this.publish) };
  }
  addNodeApp(name: string, directory: string, script: string) {
    const builder = new FakeNodeAppBuilder(new FakeNodeApp(name));
    this.apps.push({ name, directory, script, builder });
    return builder;
  }
  addParameterWithGeneratedValue(name: string, _value: object, options?: object) {
    this.parameters.push({ name, options });
    return Promise.resolve(new FakeParameter(name));
  }
}

function environmentOf(builder: FakeNodeAppBuilder): Map<string, unknown> {
  return new Map(builder.calls.filter((call) => call.method === "withEnvironment").map((call) => [call.args[0] as string, call.args[1]]));
}

describe("addManagedCopilot", () => {
  let appHost: string;
  let gatewayDirectory: string;

  beforeAll(() => {
    appHost = mkdtempSync(join(tmpdir(), "mc-apphost-"));
    gatewayDirectory = join(appHost, "gateway");
    mkdirSync(join(gatewayDirectory, "dist"), { recursive: true });
    writeFileSync(join(gatewayDirectory, "dist", "main.js"), "");
  });

  afterAll(() => rmSync(appHost, { recursive: true, force: true }));

  it("adds a healthy gateway with configuration, data directory, platform key, and secret environment", async () => {
    const builder = new FakeBuilder(appHost);
    const webhookSecret = new FakeParameter("webhook-secret");
    const copilot = await addManagedCopilot(builder, "copilot", {
      gatewayDirectory,
      port: 7444,
      environments: { chat: { type: "shared" } },
      webhooks: { orders: { url: "https://contoso.example/hook", environments: ["chat"], events: ["session.idle"], secret: webhookSecret } },
    });

    expect(builder.apps).toHaveLength(1);
    const app = builder.apps[0]!;
    expect([app.name, app.directory, app.script]).toEqual(["copilot", gatewayDirectory, "dist/main.js"]);
    const calls = app.builder.calls;
    expect(calls).toContainEqual({ method: "withPnpm", args: [{ install: false }] });
    expect(calls).toContainEqual({ method: "withHttpEndpoint", args: [{ port: 7444, env: "PORT", isProxied: false }] });
    expect(calls).toContainEqual({ method: "withHttpHealthCheck", args: [{ path: "/healthz" }] });

    const env = environmentOf(app.builder);
    expect(env.get("MANAGED_COPILOT_MODE")).toBe("local");
    expect(env.get("MANAGED_COPILOT_PUBLIC_URL")).toBe("http://localhost:7444");
    expect(env.get("MANAGED_COPILOT_DATA_DIR")).toBe(join(appHost, ".managed-copilot", "data"));
    expect(env.get("MANAGED_COPILOT_APPHOST_DIR")).toBe(appHost);
    expect(env.get("MANAGED_COPILOT_INSTANCE")).toMatch(/^mc-[0-9a-f]{8}$/);
    expect(env.get("MANAGED_COPILOT_PLATFORM_KEY")).toEqual(new FakeParameter("copilot-platform-key"));
    expect(env.get("MANAGED_COPILOT_SECRET_WEBHOOK_ORDERS_1C168ADB")).toBe(webhookSecret);
    const config = JSON.parse(env.get("MANAGED_COPILOT_CONFIG") as string);
    expect(config.webhooks.orders.secret).toEqual({ secretEnv: "MANAGED_COPILOT_SECRET_WEBHOOK_ORDERS_1C168ADB" });
    expect(builder.parameters).toEqual([{ name: "copilot-platform-key", options: { secret: true, persist: true } }]);

    expect(copilot.name).toBe("copilot");
    expect(copilot.port).toBe(7444);
    expect(copilot.gateway).toBe(app.builder.resource);
    expect(copilot.url).toEqual(new FakeEndpoint("copilot", "http"));
    expect(env.has("MANAGED_COPILOT_SANDBOX_PREPARE")).toBe(false);
  });

  it("prepares sandboxes at gateway start when an isolated environment exists, unless told not to", async () => {
    const environments = { chat: { type: "shared" as const }, coder: { type: "isolated" as const } };
    const prepared = new FakeBuilder(appHost);
    await addManagedCopilot(prepared, "copilot", { gatewayDirectory, environments });
    expect(environmentOf(prepared.apps[0]!.builder).get("MANAGED_COPILOT_SANDBOX_PREPARE")).toBe("1");
    const lazy = new FakeBuilder(appHost);
    await addManagedCopilot(lazy, "copilot", { gatewayDirectory, environments, prepareSandboxes: false });
    expect(environmentOf(lazy.apps[0]!.builder).has("MANAGED_COPILOT_SANDBOX_PREPARE")).toBe(false);
  });

  it("fails clearly when the gateway has not been built", async () => {
    const builder = new FakeBuilder(appHost);
    await expect(addManagedCopilot(builder, "copilot", { gatewayDirectory: join(appHost, "nowhere"), environments: { chat: { type: "shared" } } })).rejects.toThrow(
      /not built.*Run `pnpm build` first/,
    );
  });

  it("refuses publish mode until the Azure gate is qualified", async () => {
    const builder = new FakeBuilder(appHost, true);
    await expect(addManagedCopilot(builder, "copilot", { gatewayDirectory, environments: { chat: { type: "shared" } } })).rejects.toThrow(/Azure deployment is not available yet/);
  });

  it("rejects invalid resource names", async () => {
    const builder = new FakeBuilder(appHost);
    await expect(addManagedCopilot(builder, "Copilot_1", { gatewayDirectory, environments: { chat: { type: "shared" } } })).rejects.toThrow(/must start with a lowercase letter/);
  });
});
