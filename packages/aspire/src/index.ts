export { addManagedCopilot, DEFAULT_GATEWAY_PORT, type ManagedCopilotResource } from "./add.js";
export {
  ManagedCopilotOptionsError,
  normalizeOptions,
  toolDeclaration,
  type AspireSecret,
  type ManagedCopilotOptions,
  type McpCredentialOption,
  type NormalizedOptions,
  type SandboxCredentialOption,
  type ScheduleOption,
  type SecretBinding,
  type ToolOption,
  type VaultCredentialOption,
  type WebhookOption,
} from "./options.js";
export type { AspireBuilder, AspireNodeAppBuilder, AspireNodeAppResource, AspireValue, EndpointOf, GatewayResourceOf } from "./aspire.js";
