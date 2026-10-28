// Registries other modules extend: gateway-executed platform tools and platform-owned runtime requests.
import { ManagedCopilotError, type EnvironmentType, type Placement } from "@managed-copilot/protocol";
import type {
  PlatformToolCallContext,
  PlatformToolInput,
  PlatformToolRegistry,
  PlatformToolResult,
  RegisteredPlatformTool,
  RuntimeRequestHandler,
  RuntimeRequestRegistry,
  UpstreamInfo,
} from "./contracts.js";

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Converts any handler return value into the SDK tool result shape the runtime accepts. */
export function toToolResult(value: unknown): PlatformToolResult {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    typeof (value as { textResultForLlm?: unknown }).textResultForLlm === "string" &&
    ["success", "failure", "rejected", "denied"].includes((value as { resultType?: string }).resultType ?? "")
  ) {
    return value as PlatformToolResult;
  }
  return JSON.stringify(value);
}

export class PlatformTools implements PlatformToolRegistry {
  readonly #tools = new Map<string, RegisteredPlatformTool>();

  register(definition: PlatformToolInput): () => void {
    if (!TOOL_NAME.test(definition.name)) throw new Error(`Invalid platform tool name "${definition.name}"`);
    if (this.#tools.has(definition.name)) throw new Error(`Platform tool "${definition.name}" is already registered`);
    if (definition.recover && definition.replay !== "never") throw new Error(`Platform tool "${definition.name}" has a recover hook, which only applies with replay: "never"`);
    const handler = definition.handler;
    const recover = definition.recover;
    const tool: RegisteredPlatformTool = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters ?? { type: "object", properties: {} },
      skipPermission: definition.skipPermission ?? true,
      ...(definition.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
      ...(definition.appliesTo ? { appliesTo: definition.appliesTo } : {}),
      ...(definition.replay ? { replay: definition.replay } : {}),
      ...(recover ? { recover: async (args: unknown, context: PlatformToolCallContext) => toToolResult(await recover(args, context)) } : {}),
      enabledFor: definition.enabledFor ?? (() => true),
      handler: async (args: unknown, context: PlatformToolCallContext) => toToolResult(await handler(args, context)),
    };
    this.#tools.set(tool.name, tool);
    return () => {
      if (this.#tools.get(tool.name) === tool) this.#tools.delete(tool.name);
    };
  }

  get(name: string): RegisteredPlatformTool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  forSession(context: { environment: string; type: EnvironmentType; placement: Placement }): readonly RegisteredPlatformTool[] {
    return [...this.#tools.values()].filter((tool) => tool.enabledFor(context.environment) && (tool.appliesTo ? tool.appliesTo(context) : true));
  }
}

interface Registration {
  readonly handler: RuntimeRequestHandler;
  readonly upstream: "shared" | "sandbox" | "*";
}

export class RuntimeRequests implements RuntimeRequestRegistry {
  readonly #handlers = new Map<string, Registration[]>();

  register(method: string, handler: RuntimeRequestHandler, options: { upstream?: "shared" | "sandbox" | "*" } = {}): () => void {
    const registration: Registration = { handler, upstream: options.upstream ?? "*" };
    const list = this.#handlers.get(method) ?? [];
    if (list.some((existing) => existing.upstream === registration.upstream)) {
      throw new ManagedCopilotError("conflict", `A ${registration.upstream} handler for runtime request ${method} is already registered`);
    }
    list.push(registration);
    this.#handlers.set(method, list);
    return () => {
      const current = this.#handlers.get(method);
      if (current) this.#handlers.set(method, current.filter((entry) => entry !== registration));
    };
  }

  resolve(method: string, upstream: UpstreamInfo): RuntimeRequestHandler | undefined {
    const candidates = [method, `${method.split(".")[0]}.*`];
    for (const key of candidates) {
      const list = this.#handlers.get(key);
      if (!list) continue;
      const exact = list.find((entry) => entry.upstream === upstream.kind);
      if (exact) return exact.handler;
      const any = list.find((entry) => entry.upstream === "*");
      if (any) return any.handler;
    }
    return undefined;
  }
}
