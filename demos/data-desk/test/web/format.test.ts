import { describe, expect, it } from "vitest";
import { firstSentence, titleFrom } from "../../src/web/lib/format.js";

describe("a title from Copilot's answer", () => {
  it("is the first sentence as plain text", () => {
    expect(firstSentence("**Downtown** made the most: $190,417. Harbor came second.")).toBe("Downtown made the most: $190,417");
    expect(firstSentence("## Summary\n\n- [Mobile](https://example.com) drops out at `shipping`.")).toBe("Summary Mobile drops out at shipping");
    expect(firstSentence("Revenue rose 3.5% in Q3")).toBe("Revenue rose 3.5% in Q3");
    expect(firstSentence("Ok")).toBeUndefined();
    expect(firstSentence(`${"word ".repeat(40)}end.`, 50)).toMatch(/^(word ){8}word…$/);
  });

  it("keeps only the first clause of a long sentence", () => {
    const answer = "Mobile shoppers with **$40–$49** carts drop out at the shipping step, where the $5.99 fee appears: only **47%** of them go on to payment.\n\n- Desktop: 80%";
    expect(titleFrom(answer)).toBe("Mobile shoppers with $40–$49 carts drop out at the shipping step");
    expect(titleFrom("Mobile carts under $50 lose shoppers at shipping.")).toBe("Mobile carts under $50 lose shoppers at shipping");
    expect(titleFrom("")).toBeUndefined();
  });
});
