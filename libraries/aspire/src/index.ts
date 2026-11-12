export { addManagedCopilot, DEFAULT_GATEWAY_PORT, type ManagedCopilotResource } from "./add.js";
export { AzurePublishError, publishApp, type PublishAppOptions } from "./publish/index.js";
export {
  ManagedCopilotOptionsError,
  normalizeOptions,
  toolDeclaration,
  type AppKeyBinding,
  type AppOption,
  type OpenAIEndpointOption,
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
export type { AspireBuilder, AspireNodeAppBuilder, AspireNodeAppResource, AspireValue, EndpointOf, GatewayResourceOf, ParameterOf } from "./aspire.js";
