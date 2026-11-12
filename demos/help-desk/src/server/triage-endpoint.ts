// Help Desk's OpenAI-compatible endpoint for the decision model, so a stock Copilot session can use it: the AppHost
// declares it as an `openai` inference endpoint and routes the triage environment to it. The runtime sends a chat
// completion with structured output (`responseSchema` becomes `response_format`); this turns it into one decision API
// call:
// - the system message (the session's, in replace mode) is JSON: each question's instructions and criteria;
// - the schema's properties are the questions: a string enum is a `choice` among its values, a boolean a `noul`;
// - the last user message is the `state`. Earlier messages are ignored: each classification stands alone.
// Anything else (streaming, no schema, other property types) is refused with 400.
import { timingSafeEqual } from "node:crypto";
import { DecisionError, type Decider, type DecisionQuestion } from "./decision.js";

/** The instructions the system message carries for each question. */
export interface QuestionSpec {
  readonly instructions: string;
  /** For a choice, a description of each value; for a noul, of `true` and `false`. */
  readonly criteria?: Readonly<Record<string, string>>;
}

export type QuestionSpecs = Readonly<Record<string, QuestionSpec>>;

/** An HTTP error in OpenAI's error shape. */
export class EndpointError extends Error {
  override readonly name = "EndpointError";
  constructor(
    readonly status: number,
    message: string,
    readonly type = status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : "api_error",
  ) {
    super(message);
  }

  body(): { error: { message: string; type: string } } {
    return { error: { message: this.message, type: this.type } };
  }
}

const invalid = (message: string) => new EndpointError(400, message);

interface Property {
  readonly kind: "choice" | "noul";
  readonly values?: readonly string[];
}

/** The questions a request asks, and the state it asks them about. */
export interface ParsedRequest {
  readonly model: string;
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly properties: Readonly<Record<string, Property>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string").map((part) => (part as { text: string }).text);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

/** The runtime puts the date before each user message; the decision model only needs the customer's words. */
export function stripContext(text: string): string {
  return text.replace(/^\s*<current_datetime>[^<]*<\/current_datetime>\s*/, "").trim();
}

function parseSpecs(system: string | undefined): QuestionSpecs {
  if (system === undefined) throw invalid("Send the questions as a JSON system message.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(system);
  } catch {
    throw invalid("The system message must be JSON: each question's instructions and criteria.");
  }
  if (!isRecord(parsed)) throw invalid("The system message must be a JSON object of questions.");
  const specs: Record<string, QuestionSpec> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value["instructions"] !== "string" || !value["instructions"].trim()) throw invalid(`The system message's "${name}" question has no instructions.`);
    const criteria = value["criteria"];
    if (criteria !== undefined && (!isRecord(criteria) || Object.values(criteria).some((entry) => typeof entry !== "string"))) {
      throw invalid(`The system message's "${name}" criteria must map each value to a description.`);
    }
    specs[name] = { instructions: value["instructions"], ...(criteria ? { criteria: criteria as Record<string, string> } : {}) };
  }
  return specs;
}

/** Validates a chat completion request and turns it into decision questions. */
export function parseRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) throw invalid("The request body must be a JSON object.");
  if (body["stream"] === true) throw invalid("Streaming isn't supported: this endpoint returns one complete answer.");
  const model = body["model"];
  if (typeof model !== "string" || !model) throw invalid("Name the model.");
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length === 0) throw invalid("Send messages.");
  const format = body["response_format"];
  const schema = isRecord(format) && format["type"] === "json_schema" && isRecord(format["json_schema"]) ? format["json_schema"]["schema"] : undefined;
  if (!isRecord(schema) || schema["type"] !== "object" || !isRecord(schema["properties"])) {
    throw invalid("Ask for structured output: a response_format of type json_schema whose schema is an object.");
  }
  const system = messages.find((message) => isRecord(message) && (message["role"] === "system" || message["role"] === "developer"));
  const specs = parseSpecs(isRecord(system) ? textOf(system["content"]) : undefined);
  const lastUser = [...messages].reverse().find((message) => isRecord(message) && message["role"] === "user");
  const state = isRecord(lastUser) ? stripContext(textOf(lastUser["content"]) ?? "") : "";
  if (!state) throw invalid("Send a user message to classify.");

  const questions: Record<string, DecisionQuestion> = {};
  const properties: Record<string, Property> = {};
  for (const [name, property] of Object.entries(schema["properties"])) {
    const spec = specs[name];
    if (!spec) throw invalid(`The system message has no question for "${name}".`);
    if (!isRecord(property)) throw invalid(`The schema's "${name}" property must be an object.`);
    if (property["type"] === "string" && Array.isArray(property["enum"]) && property["enum"].length >= 2 && property["enum"].every((value) => typeof value === "string")) {
      const values = property["enum"] as string[];
      questions[name] = { type: "choice", instructions: spec.instructions, criteria: Object.fromEntries(values.map((value) => [value, spec.criteria?.[value] ?? value])) };
      properties[name] = { kind: "choice", values };
    } else if (property["type"] === "boolean") {
      const criteria = spec.criteria?.["true"] && spec.criteria["false"] ? { true: spec.criteria["true"], false: spec.criteria["false"] } : undefined;
      questions[name] = { type: "noul", instructions: spec.instructions, ...(criteria ? { criteria } : {}) };
      properties[name] = { kind: "noul" };
    } else {
      throw invalid(`The schema's "${name}" property must be a string enum (a choice) or a boolean.`);
    }
  }
  if (Object.keys(questions).length === 0) throw invalid("The schema has no properties to decide.");
  return { model, state, questions, properties };
}

/** The decision model's answers as the schema's values. */
export function readAnswers(answers: Readonly<Record<string, unknown>>, properties: ParsedRequest["properties"]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const [name, property] of Object.entries(properties)) {
    const answer = answers[name];
    if (!isRecord(answer)) throw new DecisionError(`The decision API didn't answer "${name}".`, 502);
    if (property.kind === "choice") {
      const choice = answer["choice"];
      if (typeof choice !== "string" || !property.values!.includes(choice)) throw new DecisionError(`The decision API chose an unknown value for "${name}".`, 502);
      result[name] = choice;
    } else {
      const probability = answer["noul"];
      if (typeof probability !== "number" || !Number.isFinite(probability)) throw new DecisionError(`The decision API returned no probability for "${name}".`, 502);
      result[name] = probability >= 0.5;
    }
  }
  return result;
}

/** Whether `header` carries `key` as a bearer token. */
export function authorized(header: string | undefined, key: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Answers one chat completion request with the decision model. */
export async function complete(body: unknown, decider: Decider, now: () => Date = () => new Date()): Promise<Record<string, unknown>> {
  const request = parseRequest(body);
  let response;
  try {
    response = await decider.decide({ state: request.state, questions: request.questions });
  } catch (error) {
    if (error instanceof DecisionError) throw new EndpointError(error.status, error.message);
    throw error;
  }
  let content: string;
  try {
    content = JSON.stringify(readAnswers(response.answers, request.properties));
  } catch (error) {
    if (error instanceof DecisionError) throw new EndpointError(error.status, error.message);
    throw error;
  }
  const input = response.usage?.input_tokens ?? 0;
  const output = response.usage?.output_tokens ?? 0;
  return {
    id: `chatcmpl-${now().getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    object: "chat.completion",
    created: Math.floor(now().getTime() / 1000),
    model: request.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}
