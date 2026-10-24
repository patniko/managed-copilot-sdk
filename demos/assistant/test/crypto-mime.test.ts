import { describe, expect, it } from "vitest";
import { Sealer } from "../src/server/seal.js";
import { addressOf, buildMime, encodeWord, htmlToText, normalizeAddress } from "../src/server/tools/google/mime.js";
import { extractBody } from "../src/server/tools/google/workspace.js";
import { ToolError } from "../src/server/tools/types.js";

describe("Sealer", () => {
  const sealer = Sealer.fromSecret("a-long-enough-test-secret-value");

  it("round-trips and binds values to their purpose", () => {
    const sealed = sealer.seal("refresh-token-123", "google:1:refresh");
    expect(sealed).not.toContain("refresh-token-123");
    expect(sealer.open(sealed, "google:1:refresh")).toBe("refresh-token-123");
    expect(() => sealer.open(sealed, "google:2:refresh")).toThrow();
  });

  it("detects tampering and wrong keys", () => {
    const sealed = sealer.seal("secret", "p");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[2]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    expect(() => sealer.open(`${parts[0]}.${parts[1]}.${body.toString("base64url")}`, "p")).toThrow();
    expect(() => Sealer.fromSecret("another-long-enough-secret").open(sealed, "p")).toThrow();
  });

  it("requires a reasonably long secret", () => {
    expect(() => Sealer.fromSecret("short")).toThrow(/16 characters/);
  });
});

describe("MIME", () => {
  it("builds a plain-text message with encoded headers", () => {
    const mime = buildMime({ to: ["Sam Rivera <sam@contoso.example>"], cc: ["priya@contoso.example"], subject: "Q3 plan — résumé", body: "Hi Sam,\nSee you Tuesday." });
    expect(mime).toContain("To: Sam Rivera <sam@contoso.example>\r\n");
    expect(mime).toContain("Cc: priya@contoso.example\r\n");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Q3 plan — résumé").toString("base64")}?=`);
    const body = mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Hi Sam,\r\nSee you Tuesday.");
  });

  it("rejects header injection and invalid addresses", () => {
    expect(() => buildMime({ to: ["sam@contoso.example"], subject: "hi\r\nBcc: evil@x.example", body: "x" })).toThrow(ToolError);
    expect(() => normalizeAddress("sam@contoso.example\r\nBcc: evil@x.example")).toThrow(ToolError);
    expect(() => normalizeAddress("not-an-email")).toThrow(/valid email/);
    expect(() => buildMime({ to: [], subject: "x", body: "x" })).toThrow(/recipient/);
  });

  it("quotes display names with special characters and extracts addresses", () => {
    expect(encodeWord("Rivera, Sam")).toBe('"Rivera, Sam"');
    expect(normalizeAddress('"Rivera, Sam" <sam@contoso.example>')).toBe('"Rivera, Sam" <sam@contoso.example>');
    expect(addressOf("Sam <SAM@Contoso.example>")).toBe("sam@contoso.example");
  });

  it("turns HTML mail into readable text", () => {
    expect(htmlToText("<style>p{}</style><p>Hello&nbsp;<b>Sam</b></p><ul><li>One</li><li>Two &amp; three</li></ul>")).toBe("Hello Sam\n- One\n- Two & three");
  });

  it("prefers the text/plain part of a multipart message", () => {
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: encode("<p>HTML</p>") } },
        { mimeType: "text/plain", body: { data: encode("Plain text") } },
      ],
    };
    expect(extractBody(payload)).toBe("Plain text");
    expect(extractBody({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: encode("<p>Only <i>HTML</i></p>") } }] })).toBe("Only HTML");
  });
});
