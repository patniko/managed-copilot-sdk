import { describe, expect, it } from "vitest";
import { redact } from "../src/sandboxd/exec.js";

describe("redact", () => {
  it("removes known secrets, URL userinfo, and signed-URL credentials but keeps the rest", () => {
    const text = "pip: GET https://user:pa55w0rd@feed.example/pkg?sv=2019-07-07&sig=abc%2Bdef%3D&se=2026 (X-Amz-Signature=nope) https://s3.example/o?X-Amz-Signature=deadbeef&x=1 secretvalue";
    const out = redact(text, ["secretvalue"]);
    for (const leaked of ["pa55w0rd", "abc%2Bdef%3D", "deadbeef", "secretvalue"]) expect(out).not.toContain(leaked);
    expect(out).toContain("sv=2019-07-07");
    expect(out).toContain("&se=2026");
    expect(out).toContain("&x=1");
    expect(out).toContain("https://[redacted]@feed.example/pkg");
  });
});
