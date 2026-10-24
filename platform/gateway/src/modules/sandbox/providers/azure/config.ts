// Configuration for the Azure Container Apps Sandboxes backend, from the gateway's environment (set by `aspire deploy`).
// Problems are collected rather than thrown, so a gateway without isolated environments still starts and `ready()`
// reports exactly what is missing.
import { SANDBOX_SIZES, type SandboxSize } from "@managed-copilot/protocol";

export interface DiskSizes {
  readonly workspace: string;
  readonly home: string;
  readonly state: string;
}

export interface AzureSandboxConfig {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  /** The `Microsoft.App/sandboxGroups` resource sandboxes are created in. */
  readonly sandboxGroup: string;
  readonly region: string;
  /** Data-plane base URL (default `https://management.<region>.azuredevcompute.io`). */
  readonly endpoint: string;
  readonly apiVersion: string;
  /** `managed-identity` in Container Apps; `cli` uses `az account get-access-token` (local qualification only). */
  readonly credential: "managed-identity" | "cli";
  /** Client ID of the user-assigned managed identity the gateway authenticates as. */
  readonly clientId?: string;
  /** Environment name → registry image built by `aspire deploy` (`*` covers environments without their own image). */
  readonly images: Readonly<Record<string, string>>;
  /** Resource ID of the managed identity the sandbox group uses to pull those images. */
  readonly registryIdentity?: string;
  /** VNet connection of the sandbox group, through which sandboxes reach the egress proxy. */
  readonly vnetConnection?: string;
  /** Where sandboxes reach the egress proxy (a private address in the VNet). */
  readonly egressProxy?: { readonly host: string; readonly port: number };
  /** Source ranges allowed to reach each sandbox's sandboxd port (the gateway's outbound addresses). */
  readonly ingressCidrs: readonly string[];
  /** Data disk sizes per sandbox size. */
  readonly disks: Readonly<Record<SandboxSize, DiskSizes>>;
  /** Optional platform egress policy template (JSON); `{{proxyHost}}` and `{{proxyPort}}` are substituted. */
  readonly egressPolicyTemplate?: string;
}

export interface LoadedConfig {
  readonly config?: AzureSandboxConfig;
  readonly problems: readonly string[];
}

const DEFAULT_DISKS: Record<SandboxSize, DiskSizes> = {
  small: { workspace: "16Gi", home: "8Gi", state: "4Gi" },
  medium: { workspace: "32Gi", home: "16Gi", state: "4Gi" },
  large: { workspace: "64Gi", home: "32Gi", state: "8Gi" },
};

export const DEFAULT_API_VERSION = "2026-02-01-preview";

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const QUANTITY = /^\d+(Mi|Gi|Ti)$/;

function parseJson<T>(raw: string | undefined, name: string, problems: string[]): T | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    problems.push(`${name} must be JSON.`);
    return undefined;
  }
}

/** Parses `host:port`. */
function parseHostPort(raw: string | undefined, name: string, problems: string[]): { host: string; port: number } | undefined {
  if (!raw?.trim()) return undefined;
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw.trim());
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`${name} must be host:port (got "${raw}").`);
    return undefined;
  }
  return { host: match[1]!, port };
}

function isCidr(value: string): boolean {
  const [address, bits] = value.split("/");
  if (!address || bits === undefined || !/^\d{1,3}$/.test(bits)) return false;
  const parts = address.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) && Number(bits) <= 32;
}

export function loadAzureConfig(env: Readonly<Record<string, string | undefined>>): LoadedConfig {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set.`);
    return value ?? "";
  };
  const subscriptionId = required("MANAGED_COPILOT_AZURE_SUBSCRIPTION_ID");
  const resourceGroup = required("MANAGED_COPILOT_AZURE_RESOURCE_GROUP");
  const sandboxGroup = required("MANAGED_COPILOT_AZURE_SANDBOX_GROUP");
  const region = required("MANAGED_COPILOT_AZURE_REGION").toLowerCase().replace(/\s+/g, "");
  if (sandboxGroup && !NAME.test(sandboxGroup)) problems.push(`MANAGED_COPILOT_AZURE_SANDBOX_GROUP "${sandboxGroup}" is not a valid sandbox group name.`);
  if (region && !/^[a-z0-9]+$/.test(region)) problems.push(`MANAGED_COPILOT_AZURE_REGION "${region}" is not an Azure region name (for example westus2).`);

  const credential = (env.MANAGED_COPILOT_AZURE_CREDENTIAL ?? "managed-identity").trim();
  if (credential !== "managed-identity" && credential !== "cli") problems.push(`MANAGED_COPILOT_AZURE_CREDENTIAL must be managed-identity or cli (got "${credential}").`);
  if (credential === "managed-identity" && !(env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER)) {
    problems.push("No managed identity is available to the gateway (IDENTITY_ENDPOINT/IDENTITY_HEADER are not set); assign one to the gateway's container app.");
  }

  const images = parseJson<Record<string, unknown>>(env.MANAGED_COPILOT_AZURE_SANDBOX_IMAGES, "MANAGED_COPILOT_AZURE_SANDBOX_IMAGES", problems) ?? {};
  const imageMap: Record<string, string> = {};
  for (const [name, value] of Object.entries(images)) {
    if (typeof value === "string" && value.trim()) imageMap[name] = value.trim();
    else problems.push(`MANAGED_COPILOT_AZURE_SANDBOX_IMAGES["${name}"] must be an image reference.`);
  }
  if (Object.keys(imageMap).length === 0 && !problems.some((problem) => problem.startsWith("MANAGED_COPILOT_AZURE_SANDBOX_IMAGES"))) {
    problems.push("MANAGED_COPILOT_AZURE_SANDBOX_IMAGES is not set: no sandbox images were built for this deployment. Redeploy with `aspire deploy`.");
  }

  const ingressCidrs = (env.MANAGED_COPILOT_AZURE_INGRESS_CIDRS ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const cidr of ingressCidrs) if (!isCidr(cidr)) problems.push(`MANAGED_COPILOT_AZURE_INGRESS_CIDRS has an invalid IPv4 CIDR "${cidr}".`);
  if (ingressCidrs.length > 10) problems.push("MANAGED_COPILOT_AZURE_INGRESS_CIDRS allows at most 10 ranges.");

  const disks = { ...DEFAULT_DISKS };
  const diskOverrides = parseJson<Partial<Record<string, Partial<DiskSizes>>>>(env.MANAGED_COPILOT_AZURE_SANDBOX_DISKS, "MANAGED_COPILOT_AZURE_SANDBOX_DISKS", problems);
  for (const [size, value] of Object.entries(diskOverrides ?? {})) {
    if (!(size in SANDBOX_SIZES)) {
      problems.push(`MANAGED_COPILOT_AZURE_SANDBOX_DISKS has an unknown size "${size}".`);
      continue;
    }
    const merged = { ...disks[size as SandboxSize], ...value };
    for (const [disk, quantity] of Object.entries(merged)) {
      if (typeof quantity !== "string" || !QUANTITY.test(quantity)) problems.push(`MANAGED_COPILOT_AZURE_SANDBOX_DISKS.${size}.${disk} must be a size such as "16Gi".`);
    }
    disks[size as SandboxSize] = merged;
  }

  const egressProxy = parseHostPort(env.MANAGED_COPILOT_AZURE_EGRESS_PROXY, "MANAGED_COPILOT_AZURE_EGRESS_PROXY", problems);
  if (problems.length > 0) return { problems };
  return {
    problems,
    config: {
      subscriptionId,
      resourceGroup,
      sandboxGroup,
      region,
      endpoint: (env.MANAGED_COPILOT_AZURE_SANDBOX_ENDPOINT?.trim() || `https://management.${region}.azuredevcompute.io`).replace(/\/+$/, ""),
      apiVersion: env.MANAGED_COPILOT_AZURE_SANDBOX_API_VERSION?.trim() || DEFAULT_API_VERSION,
      credential: credential as AzureSandboxConfig["credential"],
      ...(env.MANAGED_COPILOT_AZURE_CLIENT_ID?.trim() ? { clientId: env.MANAGED_COPILOT_AZURE_CLIENT_ID.trim() } : {}),
      images: imageMap,
      ...(env.MANAGED_COPILOT_AZURE_REGISTRY_IDENTITY?.trim() ? { registryIdentity: env.MANAGED_COPILOT_AZURE_REGISTRY_IDENTITY.trim() } : {}),
      ...(env.MANAGED_COPILOT_AZURE_VNET_CONNECTION?.trim() ? { vnetConnection: env.MANAGED_COPILOT_AZURE_VNET_CONNECTION.trim() } : {}),
      ...(egressProxy ? { egressProxy } : {}),
      ingressCidrs,
      disks,
      ...(env.MANAGED_COPILOT_AZURE_SANDBOX_EGRESS_POLICY?.trim() ? { egressPolicyTemplate: env.MANAGED_COPILOT_AZURE_SANDBOX_EGRESS_POLICY } : {}),
    },
  };
}
