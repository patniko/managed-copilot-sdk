import { isReservedEnv, PATHS } from "../shared/constants.js";

export interface EnvironmentInput {
  /** Proxy settings and vault placeholders from the egress service. */
  readonly platformEnv: Readonly<Record<string, string>>;
  /** Customer variables; reserved names are dropped (the gateway already rejects them). */
  readonly workloadEnv: Readonly<Record<string, string>>;
  /** True when the egress CA is installed into the system trust store. */
  readonly caInstalled: boolean;
}

const BASE_PATH = [
  `${PATHS.venv}/bin`,
  `${PATHS.npmPrefix}/bin`,
  `${PATHS.home}/.local/bin`,
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

function withLoopback(value: string | undefined): string {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const host of LOOPBACK) if (!entries.includes(host)) entries.push(host);
  return entries.join(",");
}

/** Environment for setup commands and everything the agent runs (inherited from the runtime). */
export function workloadEnvironment(input: EnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.workloadEnv)) {
    if (!isReservedEnv(name)) env[name] = value;
  }
  Object.assign(env, {
    HOME: PATHS.home,
    USER: "agent",
    LOGNAME: "agent",
    SHELL: "/bin/bash",
    PATH: BASE_PATH,
    LANG: env.LANG ?? "C.UTF-8",
    TERM: env.TERM ?? "xterm-256color",
    VIRTUAL_ENV: PATHS.venv,
    NPM_CONFIG_PREFIX: PATHS.npmPrefix,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
  });
  if (input.caInstalled) {
    Object.assign(env, {
      NODE_EXTRA_CA_CERTS: PATHS.egressCaCertificate,
      SSL_CERT_FILE: PATHS.systemCaBundle,
      REQUESTS_CA_BUNDLE: PATHS.systemCaBundle,
      PIP_CERT: PATHS.systemCaBundle,
      CURL_CA_BUNDLE: PATHS.systemCaBundle,
      GIT_SSL_CAINFO: PATHS.systemCaBundle,
    });
  }
  Object.assign(env, input.platformEnv);
  env.NO_PROXY = withLoopback(env.NO_PROXY ?? env.no_proxy);
  if (env.no_proxy !== undefined || env.http_proxy !== undefined || env.https_proxy !== undefined) env.no_proxy = env.NO_PROXY;
  return env;
}

/** Environment for the stock runtime: the workload environment plus the runtime's own settings. */
export function runtimeEnvironment(input: EnvironmentInput, connectionToken: string): Record<string, string> {
  return {
    ...workloadEnvironment(input),
    COPILOT_HOME: PATHS.runtimeHome,
    COPILOT_CONNECTION_TOKEN: connectionToken,
    COPILOT_DISABLE_KEYTAR: "1",
    COPILOT_AUTO_UPDATE: "false",
  };
}

/** Values that must never appear in diagnostics (proxy credentials, vault placeholders, the connection token). */
export function secretValues(input: EnvironmentInput, extra: readonly string[] = []): string[] {
  return [...Object.values(input.platformEnv), ...extra].filter((value) => value.length >= 6);
}
