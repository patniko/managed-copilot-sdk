// Constants mirrored from @managed-copilot/protocol (sandbox.ts). sandboxd runs inside the sandbox image without
// workspace packages, so it imports protocol types only; test/contract.test.ts keeps these values in sync.

export const SANDBOXD_PORT = 7781;
export const SANDBOX_RELAY_PORT = 7780;
export const SANDBOX_RUNTIME_PORT = 7790;
export const SANDBOX_UID = 10001;
export const SANDBOX_GID = 10001;
export const PLATFORM_KEY_HEADER = "x-managed-copilot-platform-key";

export const ROUTES = {
  health: "/v1/health",
  start: "/v1/start",
  status: "/v1/status",
  runtime: "/v1/runtime",
  tunnel: "/v1/tunnel",
  files: "/v1/files",
  fileContent: "/v1/files/content",
  outputsManifest: "/v1/outputs/manifest",
  outputsContent: "/v1/outputs/content",
  runtimeImportContent: "/v1/runtime-import/content",
  runtimeImportCommit: "/v1/runtime-import/commit",
  runtimeImportAbort: "/v1/runtime-import/abort",
  runtimeRestart: "/v1/runtime/restart",
} as const;

export const PATHS = {
  workspace: "/workspace",
  outputs: "/workspace/outputs",
  home: "/home/agent",
  venv: "/home/agent/.venv",
  npmPrefix: "/home/agent/.npm-global",
  customizations: "/opt/managed-copilot/customizations",
  state: "/var/lib/managed-copilot",
  runtimeHome: "/var/lib/managed-copilot/runtime",
  egressCaCertificate: "/usr/local/share/ca-certificates/managed-copilot-egress.crt",
  systemCaBundle: "/etc/ssl/certs/ca-certificates.crt",
} as const;

export const LIMITS = {
  setupFiles: { count: 64, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 },
  uploadBytes: 512 * 1024 * 1024,
  artifacts: { count: 256, fileBytes: 100 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 },
  listEntries: 10_000,
  setupCommandTimeoutSeconds: 15 * 60,
} as const;

export const RESERVED_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "PWD",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "VIRTUAL_ENV",
  "NPM_CONFIG_PREFIX",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
] as const;
export const RESERVED_ENV_PREFIXES = ["COPILOT_", "MANAGED_COPILOT_", "SANDBOXD_", "GH_ENTERPRISE_", "GITHUB_COPILOT_"] as const;

export function isReservedEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return (RESERVED_ENV as readonly string[]).includes(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Sandbox IDs are `sbx_` plus 24 lowercase hex characters; their DNS alias swaps the underscore for a hyphen. */
export const SANDBOX_ID_PATTERN = /^sbx_[0-9a-f]{24}$/;

export function sandboxHostname(sandboxId: string): string {
  return sandboxId.replace("_", "-");
}
