/**
 * First-party plumbing for the `managed-copilot` CLI and the demos in this repository. Not a stable public API:
 * applications should use `ManagedCopilot` from `@managed-copilot/sdk`.
 */
export { HttpClient, type RequestOptions } from "./http.js";
export { readDiscovery, resolveToken, resolveUrl, validateDeploymentUrl } from "./connection.js";
export { findCopilot, launchAttachedCli, type AttachedCliResult, type AttachOutcome } from "./features/cli.js";
