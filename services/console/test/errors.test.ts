import { describe, expect, it } from "vitest";
import { ApiError, apiErrorFromResponse, errorMessage, isAbortError, networkError, parseRetryAfter, toApiError } from "../src/lib/errors.js";

const NOW = Date.parse("2026-10-25T21:00:00.000Z");

describe("parseRetryAfter", () => {
  it("reads delays and HTTP dates", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter(" 5 ", NOW)).toBe(5);
    expect(parseRetryAfter("Sun, 25 Oct 2026 21:00:30 GMT", NOW)).toBe(30);
    expect(parseRetryAfter("Sun, 25 Oct 2026 20:00:00 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });
});

describe("apiErrorFromResponse", () => {
  it("keeps the gateway's code, message, and details", () => {
    const error = apiErrorFromResponse(403, JSON.stringify({ error: { code: "forbidden", message: "Only @octocat may operate this deployment.", details: { login: "mona" } } }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("forbidden");
    expect(error.status).toBe(403);
    expect(error.message).toBe("Only @octocat may operate this deployment.");
    expect(error.details).toEqual({ login: "mona" });
  });

  it("takes Retry-After from the header first, then from details", () => {
    const body = JSON.stringify({ error: { code: "upstream_unavailable", message: "GitHub is unreachable.", details: { retryAfterSeconds: 9 } } });
    expect(apiErrorFromResponse(503, body, "30", NOW).retryAfterSeconds).toBe(30);
    expect(apiErrorFromResponse(503, body, null, NOW).retryAfterSeconds).toBe(9);
  });

  it("maps non-JSON bodies to readable messages, never raw HTML", () => {
    const proxy = apiErrorFromResponse(502, "<html><body>Bad gateway</body></html>");
    expect(proxy.code).toBe("http_error");
    expect(proxy.message).not.toContain("<");
    const unknown = apiErrorFromResponse(418, "teapot");
    expect(unknown.message).toBe("The gateway returned an unexpected response (HTTP 418).");
  });

  it("keeps the 401 meaning without a JSON body", () => {
    const error = apiErrorFromResponse(401, "");
    expect(error.code).toBe("authentication_required");
    expect(error.status).toBe(401);
  });

  it("ignores malformed error bodies", () => {
    expect(apiErrorFromResponse(500, JSON.stringify({ error: { code: 5, message: "x" } })).code).toBe("http_error");
    expect(apiErrorFromResponse(500, JSON.stringify({ error: { code: "internal", message: "   " } })).code).toBe("http_error");
  });
});

describe("error helpers", () => {
  it("recognizes aborts and wraps unknown failures", () => {
    expect(isAbortError(new DOMException("stop", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
    expect(toApiError(networkError()).code).toBe("network_error");
    expect(toApiError(new TypeError("Failed to fetch")).code).toBe("internal");
    expect(toApiError(new DOMException("slow", "TimeoutError")).code).toBe("timeout");
    expect(errorMessage(new Error("stack trace here"))).not.toContain("stack");
  });
});
