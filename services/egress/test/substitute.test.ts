import { normalizeNetwork, type EgressRegistration } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { applySubstitution, mentionsPlaceholder, planSubstitution, redactText } from "../src/substitute.js";

const placeholder = (seed: string) => `mcv_placeholder_${seed.repeat(40).slice(0, 40)}`;
const bearer = (token: string) => ["Bearer", token].join(" ");
const stripe = placeholder("a1");
const jira = placeholder("b2");
const foreign = placeholder("c3");

const registration: EgressRegistration = {
  sandboxId: "sbx_1",
  sessionId: "ses_1",
  credentialHash: "0".repeat(64),
  policy: normalizeNetwork(["api.stripe.com", "contoso.atlassian.net"]),
  revision: 1,
  credentials: [
    { id: "cred_stripe", placeholder: stripe, destinations: [{ host: "api.stripe.com", port: 443 }], headers: ["authorization"] },
    { id: "cred_jira", placeholder: jira, destinations: [{ host: "contoso.atlassian.net", port: 443 }], headers: ["authorization", "x-api-key"] },
  ],
};

describe("substitution planning", () => {
  it("allows literal placeholders in named headers for exact destinations", () => {
    const plan = planSubstitution(registration, "api.stripe.com", 443, "/v1/balance", ["Authorization", bearer(stripe), "Accept", "*/*"]);
    expect(plan).toMatchObject({ ok: true, uses: [{ header: "authorization", placeholder: stripe }] });
    const jiraPlan = planSubstitution(registration, "contoso.atlassian.net", 443, "/rest", ["X-Api-Key", jira]);
    expect(jiraPlan).toMatchObject({ ok: true, uses: [{ header: "x-api-key" }] });
  });

  it("passes requests without placeholders through", () => {
    expect(planSubstitution(registration, "api.stripe.com", 443, "/", ["Accept", "*/*"])).toEqual({ ok: true, uses: [] });
  });

  it("rejects every unsupported use", () => {
    const cases: [string, number, string, string[], RegExp][] = [
      ["api.stripe.com", 443, `/v1/balance?key=${stripe}`, [], /not in URLs/],
      ["api.stripe.com", 443, `/v1/${encodeURIComponent(stripe)}`, [], /not in URLs/],
      ["api.stripe.com", 443, "/", ["Authorization", `Basic ${Buffer.from(`${stripe}:`).toString("base64")}`], /Basic authentication/],
      ["api.stripe.com", 443, "/", ["X-Api-Key", stripe], /only be sent in the authorization header/],
      ["api.stripe.com", 443, "/", ["Cookie", `k=${stripe}`], /only be sent in the authorization header/],
      ["contoso.atlassian.net", 443, "/", ["Authorization", bearer(stripe)], /only valid for api\.stripe\.com/],
      ["api.stripe.com", 443, "/", ["Authorization", bearer(foreign)], /does not belong to this session/],
    ];
    for (const [host, port, path, headers, message] of cases) {
      const plan = planSubstitution(registration, host, port, path, headers);
      expect(plan.ok, `${host}${path} ${headers.join(":")}`).toBe(false);
      if (!plan.ok) expect(plan.message).toMatch(message);
    }
  });

  it("substitutes every occurrence and nothing else", () => {
    const headers = applySubstitution(["Authorization", bearer(stripe), "X-Trace", "abc"], new Map([[stripe, "sk_test_123"]]));
    expect(headers).toEqual(["Authorization", bearer("sk_test_123"), "X-Trace", "abc"]);
  });

  it("detects placeholders in plain HTTP requests", () => {
    expect(mentionsPlaceholder(`http://x.test/?t=${stripe}`, [])).toBe(true);
    expect(mentionsPlaceholder("http://x.test/", ["Authorization", bearer(stripe)])).toBe(true);
    expect(mentionsPlaceholder("http://x.test/", ["Authorization", `Basic ${Buffer.from(`u:${stripe}`).toString("base64")}`])).toBe(true);
    expect(mentionsPlaceholder("http://x.test/", ["Accept", "*/*"])).toBe(false);
  });

  it("redacts secret values from text", () => {
    expect(redactText("token=sk_test_123; again sk_test_123", ["sk_test_123"])).toBe("token=[redacted]; again [redacted]");
    expect(redactText("short abc", ["abc"])).toBe("short abc");
  });
});
