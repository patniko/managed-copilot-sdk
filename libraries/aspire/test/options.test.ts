import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ManagedCopilotOptionsError, normalizeOptions, toolDeclaration } from "../src/options.js";

class FakeParameter {
  constructor(readonly name: string) {}
}

describe("normalizeOptions", () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "mc-aspire-"));
    mkdirSync(join(base, "sandboxes", "coder"), { recursive: true });
    writeFileSync(join(base, "sandboxes", "coder", "Dockerfile"), "FROM ghcr.io/patniko/managed-copilot-sandbox:0.1.0\n");
    mkdirSync(join(base, "customizations", "chat", "agents"), { recursive: true });
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("normalizes the spec section 1 declaration", () => {
    const { config, secrets } = normalizeOptions(
      "copilot",
      {
        access: { githubOrgs: ["contoso"] },
        environments: {
          chat: { type: "shared", customizations: "./customizations/chat", models: ["claude-sonnet-5"], network: ["learn.microsoft.com"] },
          coder: { type: "isolated", image: "./sandboxes/coder", size: "medium", warm: 2 },
          helper: { type: "promotable", promoteTo: "coder" },
        },
        inline: { types: ["shared", "isolated"], sizes: ["small"] },
        port: 7999,
      },
      { baseDirectory: base },
    );
    expect(config.name).toBe("copilot");
    expect(config.environments.chat?.customizations).toBe(join(base, "customizations", "chat"));
    expect(config.environments.coder?.image).toBe(join(base, "sandboxes", "coder"));
    expect(config.environments.helper?.promoteTo).toBe("coder");
    expect(config).not.toHaveProperty("port");
    expect(secrets).toEqual([]);
  });

  it("turns Aspire secret parameters into secretEnv references without copying values", () => {
    const stripeKey = new FakeParameter("stripe-key");
    const docsToken = new FakeParameter("docs-mcp-token");
    const webhookSecret = new FakeParameter("webhook-secret");
    const { config, secrets } = normalizeOptions(
      "copilot",
      {
        vaults: {
          payments: [{ env: "STRIPE_API_KEY", value: stripeKey, hosts: ["api.stripe.com"] }],
          docs: [{ mcpServer: "https://mcp.contoso.example/docs", value: docsToken }],
        },
        webhooks: {
          orders: { url: "https://contoso.example/api/copilot-events", environments: ["chat"], events: ["session.idle"], secret: webhookSecret },
        },
        environments: {
          coder: { type: "isolated", vaults: ["payments"], network: ["api.stripe.com"] },
          chat: { type: "shared", vaults: ["docs"] },
        },
      },
      { baseDirectory: base },
    );
    expect(config.vaults?.payments?.[0]).toEqual({ env: "STRIPE_API_KEY", value: { secretEnv: "MANAGED_COPILOT_SECRET_VAULT_PAYMENTS_DF384AE9_0" }, hosts: ["api.stripe.com"] });
    expect(config.vaults?.docs?.[0]).toEqual({ mcpServer: "https://mcp.contoso.example/docs", value: { secretEnv: "MANAGED_COPILOT_SECRET_VAULT_DOCS_46B42B42_0" } });
    expect(config.webhooks?.orders?.secret).toEqual({ secretEnv: "MANAGED_COPILOT_SECRET_WEBHOOK_ORDERS_1C168ADB" });
    expect(secrets.map((secret) => [secret.env, secret.value, secret.source])).toEqual([
      ["MANAGED_COPILOT_SECRET_VAULT_PAYMENTS_DF384AE9_0", stripeKey, "vaults.payments[0].value"],
      ["MANAGED_COPILOT_SECRET_VAULT_DOCS_46B42B42_0", docsToken, "vaults.docs[0].value"],
      ["MANAGED_COPILOT_SECRET_WEBHOOK_ORDERS_1C168ADB", webhookSecret, "webhooks.orders.secret"],
    ]);
    expect(JSON.stringify(config)).not.toContain("stripe-key");
  });

  it("gives vaults whose names differ only in punctuation their own secret variables", () => {
    const prod = new FakeParameter("billing-prod-key");
    const other = new FakeParameter("billing-other-key");
    const { secrets } = normalizeOptions(
      "copilot",
      {
        vaults: {
          "billing-prod": [{ env: "BILLING_KEY", value: prod, hosts: ["billing.contoso.example"] }],
          "billing--prod": [{ env: "BILLING_KEY", value: other, hosts: ["billing.fabrikam.example"] }],
        },
        environments: { coder: { type: "isolated", vaults: ["billing-prod", "billing--prod"] } },
      },
      { baseDirectory: base },
    );
    expect(secrets.map((secret) => secret.env)).toEqual(["MANAGED_COPILOT_SECRET_VAULT_BILLING_PROD_5EC36BB9_0", "MANAGED_COPILOT_SECRET_VAULT_BILLING_PROD_CB7C304F_0"]);
  });

  it("passes existing secretEnv references through", () => {
    const { config, secrets } = normalizeOptions(
      "copilot",
      {
        vaults: { payments: [{ env: "STRIPE_API_KEY", value: { secretEnv: "OPERATOR_STRIPE_KEY" }, hosts: ["api.stripe.com"] }] },
        environments: { coder: { type: "isolated", vaults: ["payments"] } },
      },
      { baseDirectory: base },
    );
    expect(config.vaults?.payments?.[0]?.value).toEqual({ secretEnv: "OPERATOR_STRIPE_KEY" });
    expect(secrets).toEqual([]);
  });

  it("stores stock tool declarations for AppHost schedules, never their handlers", () => {
    const lookupOrder = {
      name: "lookup_order",
      description: "Look up an order by id",
      parameters: z.object({ id: z.string() }),
      handler: async ({ id }: { id: string }) => ({ id, status: "shipped" }),
    };
    const { config } = normalizeOptions(
      "copilot",
      {
        webhooks: { orders: { url: "https://contoso.example/hook", environments: ["chat"], events: ["session.action_required"], secret: new FakeParameter("hook") } },
        environments: { chat: { type: "shared", scheduling: true } },
        schedules: {
          "weekday-triage": {
            cron: "0 9 * * 1-5",
            timeZone: "America/Los_Angeles",
            environment: "chat",
            session: { tools: [lookupOrder] },
            webhook: "orders",
            prompt: "Triage the issues opened since the last run",
          },
        },
      },
      { baseDirectory: base },
    );
    const tool = config.schedules?.["weekday-triage"]?.session?.tools?.[0];
    expect(tool).toMatchObject({ name: "lookup_order", description: "Look up an order by id" });
    expect(tool?.parameters).toMatchObject({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
    expect(tool?.revision).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(tool).not.toHaveProperty("handler");
    expect(toolDeclaration(lookupOrder).revision).toBe(tool?.revision);
    expect(toolDeclaration({ ...lookupOrder, description: "changed" }).revision).not.toBe(tool?.revision);
  });

  it("rejects literal secret values and reports every problem at once", () => {
    let error: unknown;
    try {
      normalizeOptions(
        "copilot",
        {
          vaults: { payments: [{ env: "STRIPE_API_KEY", value: "sk_live_123" as unknown as object, hosts: ["api.stripe.com"] }] },
          environments: {
            coder: { type: "isolated", image: "./sandboxes/missing" },
            helper: { type: "promotable", promoteTo: "chat" },
            chat: { type: "shared", vaults: ["nope"] },
          },
        },
        { baseDirectory: base },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ManagedCopilotOptionsError);
    const message = (error as Error).message;
    expect(message).toContain('Invalid Managed Copilot options for "copilot"');
    expect(message).toContain("vaults.payments[0].value is a literal string");
    expect(message).not.toContain("sk_live_123");
    expect(message).toContain("environments.coder.image: no Dockerfile");
    expect(message).toContain("environments.helper.promoteTo");
    expect(message).toContain('Unknown vault "nope"');
  });
});
