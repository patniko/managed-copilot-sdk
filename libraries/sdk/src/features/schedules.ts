// Schedules that start or continue sessions (spec section 13).
import { createHash, randomUUID } from "node:crypto";
import type { Tool } from "@github/copilot-sdk";
import {
  ManagedCopilotError,
  ROUTES,
  type CreateScheduleRequest,
  type ScheduleInfo,
  type ScheduleRun,
  type ToolDeclaration,
} from "@managed-copilot/protocol";
import type { CreateScheduleOptions, ManagedContext, ManagedSchedules } from "../types.js";

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/** The stock SDK's conversion (`toJsonSchema`): zod-like schemas expose `toJSONSchema()`; plain objects are JSON schema. */
function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (schema === undefined || schema === null) return undefined;
  if (typeof schema === "object" && "toJSONSchema" in schema && typeof (schema as { toJSONSchema: unknown }).toJSONSchema === "function") {
    return (schema as { toJSONSchema(): Record<string, unknown> }).toJSONSchema();
  }
  if (typeof schema === "object" && !Array.isArray(schema)) return schema as Record<string, unknown>;
  throw new ManagedCopilotError("invalid_request", "Tool parameters must be a zod schema or a JSON schema object");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/**
 * The standard declaration of a `defineTool` tool: name, description, JSON schema, the stock flags the runtime honors
 * (`overridesBuiltInTool`, `skipPermission`), and a content revision. The handler closure is never uploaded; a
 * scheduled run's calls are answered by the schedule's webhook route.
 */
export function toToolDeclaration(tool: Tool<any>): ToolDeclaration {
  if (!tool || typeof tool.name !== "string" || !VALID_TOOL_NAME.test(tool.name)) {
    throw new ManagedCopilotError("invalid_request", `Invalid tool name ${JSON.stringify(tool?.name)}: names must match /^[a-zA-Z0-9_-]+$/`);
  }
  let parameters: Record<string, unknown> | undefined;
  try {
    parameters = toJsonSchema(tool.parameters);
  } catch (error) {
    if (error instanceof ManagedCopilotError) throw new ManagedCopilotError("invalid_request", `Tool ${tool.name}: ${error.message}`);
    throw new ManagedCopilotError("invalid_request", `Tool ${tool.name}: its parameters could not be converted to JSON schema (${(error as Error).message})`);
  }
  const declaration = {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(parameters ? { parameters } : {}),
    ...(typeof tool.overridesBuiltInTool === "boolean" ? { overridesBuiltInTool: tool.overridesBuiltInTool } : {}),
    ...(typeof tool.skipPermission === "boolean" ? { skipPermission: tool.skipPermission } : {}),
  };
  const revision = createHash("sha256").update(JSON.stringify(canonical(declaration))).digest("hex").slice(0, 16);
  return { ...declaration, revision };
}

export function createSchedulesApi(ctx: ManagedContext): ManagedSchedules {
  return {
    create: (options: CreateScheduleOptions) => {
      const { session, ...rest } = options;
      const request: CreateScheduleRequest = {
        ...rest,
        ...(session
          ? {
              session: {
                ...(session.agent !== undefined ? { agent: session.agent } : {}),
                ...(session.model !== undefined ? { model: session.model } : {}),
                ...(session.tools ? { tools: session.tools.map(toToolDeclaration) } : {}),
              },
            }
          : {}),
      };
      return ctx.http.post<ScheduleInfo>(ROUTES.schedules, request);
    },
    list: () => ctx.http.get<ScheduleInfo[]>(ROUTES.schedules),
    get: (scheduleId) => ctx.http.get<ScheduleInfo>(ROUTES.schedule(scheduleId)),
    runs: (scheduleId) => ctx.http.get<ScheduleRun[]>(ROUTES.scheduleRuns(scheduleId)),
    pause: (scheduleId) => ctx.http.post<ScheduleInfo>(ROUTES.schedulePause(scheduleId)),
    resume: (scheduleId) => ctx.http.post<ScheduleInfo>(ROUTES.scheduleResume(scheduleId)),
    delete: (scheduleId) => ctx.http.delete(ROUTES.schedule(scheduleId)),
    runNow: async (scheduleId, options) => {
      // One invocation ID per call: retrying the same request can never start a second run.
      const invocationId = options?.invocationId ?? randomUUID();
      for (let attempt = 1; ; attempt++) {
        try {
          return await ctx.http.post<ScheduleRun>(ROUTES.scheduleRunNow(scheduleId), { invocationId });
        } catch (error) {
          const transient = error instanceof ManagedCopilotError && error.code === "capability_unavailable";
          if (!transient || attempt >= 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
      }
    },
  };
}
