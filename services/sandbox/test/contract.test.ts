import { describe, expect, it } from "vitest";
import {
  PLATFORM_KEY_HEADER as PROTOCOL_KEY_HEADER,
  RESERVED_SANDBOX_ENV,
  RESERVED_SANDBOX_ENV_PREFIXES,
  SANDBOX_LIMITS,
  SANDBOX_PATHS,
  SANDBOX_RELAY_PORT as PROTOCOL_RELAY_PORT,
  SANDBOX_RUNTIME_PORT as PROTOCOL_RUNTIME_PORT,
  SANDBOX_UID as PROTOCOL_UID,
  SANDBOXD_PORT as PROTOCOL_SANDBOXD_PORT,
  SANDBOXD_ROUTES,
} from "@managed-copilot/protocol";
import {
  LIMITS,
  PATHS,
  PLATFORM_KEY_HEADER,
  RESERVED_ENV,
  RESERVED_ENV_PREFIXES,
  ROUTES,
  SANDBOX_ID_PATTERN,
  SANDBOX_RELAY_PORT,
  SANDBOX_RUNTIME_PORT,
  SANDBOX_UID,
  SANDBOXD_PORT,
  isReservedEnv,
  sandboxHostname,
} from "../src/shared/constants.js";

describe("sandboxd constants mirror the protocol contract", () => {
  it("uses the same ports, routes, paths, and identity", () => {
    expect(SANDBOXD_PORT).toBe(PROTOCOL_SANDBOXD_PORT);
    expect(SANDBOX_RELAY_PORT).toBe(PROTOCOL_RELAY_PORT);
    expect(SANDBOX_RUNTIME_PORT).toBe(PROTOCOL_RUNTIME_PORT);
    expect(SANDBOX_UID).toBe(PROTOCOL_UID);
    expect(PLATFORM_KEY_HEADER).toBe(PROTOCOL_KEY_HEADER);
    expect(ROUTES).toEqual(SANDBOXD_ROUTES);
    expect(PATHS).toEqual(SANDBOX_PATHS);
    expect(LIMITS).toEqual(SANDBOX_LIMITS);
    expect(RESERVED_ENV).toEqual(RESERVED_SANDBOX_ENV);
    expect(RESERVED_ENV_PREFIXES).toEqual(RESERVED_SANDBOX_ENV_PREFIXES);
  });

  it("reserves identity, proxy, trust, and platform variables", () => {
    for (const name of ["HOME", "path", "HTTPS_PROXY", "https_proxy", "NODE_EXTRA_CA_CERTS", "COPILOT_HOME", "GITHUB_TOKEN", "SANDBOXD_KEY", "MANAGED_COPILOT_X"]) {
      expect(isReservedEnv(name), name).toBe(true);
    }
    for (const name of ["TZ", "REPORT_TITLE", "LANG", "PYTHONPATH"]) expect(isReservedEnv(name), name).toBe(false);
  });

  it("derives DNS-safe sandbox hostnames", () => {
    const id = "sbx_0123456789abcdef01234567";
    expect(SANDBOX_ID_PATTERN.test(id)).toBe(true);
    expect(sandboxHostname(id)).toBe("sbx-0123456789abcdef01234567");
    for (const bad of ["sbx_ABC", "sbx_123", "../sbx_0123456789abcdef01234567", "sbx-0123456789abcdef01234567"]) expect(SANDBOX_ID_PATTERN.test(bad)).toBe(false);
  });
});
