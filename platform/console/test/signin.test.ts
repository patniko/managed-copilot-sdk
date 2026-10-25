import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/lib/backoff.js";
import { consoleCommand, hasTicket, isLoopbackHost, readTicket } from "../src/lib/signin.js";

describe("readTicket", () => {
  it("reads the ticket from the fragment", () => {
    expect(readTicket("#ticket=abc123")).toBe("abc123");
    expect(readTicket("ticket=abc123")).toBe("abc123");
    expect(readTicket("#from=cli&ticket=t%2Bx")).toBe("t+x");
    expect(readTicket("#ticket=a+b")).toBe("a+b");
    expect(readTicket("#ticket=%E0%A4%A")).toBeUndefined();
    expect(readTicket("#ticket=")).toBeUndefined();
    expect(readTicket("#other=1")).toBeUndefined();
    expect(readTicket("")).toBeUndefined();
    expect(hasTicket("#ticket=")).toBe(true);
    expect(hasTicket("#x")).toBe(false);
  });
});

describe("consoleCommand", () => {
  it("omits --url for the default local gateway, which tools discover", () => {
    expect(consoleCommand("http://localhost:7400")).toBe("npx managed-copilot console");
    expect(consoleCommand("http://127.0.0.1:7400")).toBe("npx managed-copilot console");
    expect(consoleCommand("http://[::1]:7400")).toBe("npx managed-copilot console");
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("passes other origins with --url", () => {
    expect(consoleCommand("http://localhost:7700")).toBe("npx managed-copilot console --url http://localhost:7700");
    expect(consoleCommand("https://copilot.contoso.com")).toBe("npx managed-copilot console --url https://copilot.contoso.com");
    expect(consoleCommand("https://gw.example.azurecontainerapps.io:8443")).toBe(
      "npx managed-copilot console --url https://gw.example.azurecontainerapps.io:8443",
    );
  });
});

describe("backoffDelay", () => {
  const steady = { random: () => 0.5 };

  it("doubles from 1 s and caps at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((attempt) => backoffDelay(attempt, steady))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("jitters within bounds", () => {
    for (const random of [0, 0.25, 0.75, 0.999]) {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const delay = backoffDelay(attempt, { random: () => random });
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(30_000);
      }
    }
    expect(backoffDelay(3, { random: () => 0 })).toBe(3600);
  });
});
