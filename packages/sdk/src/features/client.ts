// Owner: core workstream. Builds a stock CopilotClient whose transport is the stdio-to-WSS bridge.
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { notImplemented } from "../connection.js";
import type { EnvironmentSelector, ManagedClientOptions, ManagedContext, ManagedResumeConfig, ManagedSessionConfig } from "../types.js";

export async function createClient(_ctx: ManagedContext, _environment: EnvironmentSelector, _options?: ManagedClientOptions): Promise<CopilotClient> {
  return notImplemented("managed.client()");
}

export async function createManagedSession(_ctx: ManagedContext, _config: ManagedSessionConfig): Promise<CopilotSession> {
  return notImplemented("managed.createSession()");
}

export async function resumeManagedSession(_ctx: ManagedContext, _sessionId: string, _config?: ManagedResumeConfig): Promise<CopilotSession> {
  return notImplemented("managed.resumeSession()");
}
