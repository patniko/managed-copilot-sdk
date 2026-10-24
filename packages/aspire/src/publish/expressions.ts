/**
 * Reference expressions for publish mode: strings that combine literals with values Aspire resolves at deploy time
 * (Bicep outputs, endpoints, parameters). They use the protocol shape the generated SDK documents for `refExpr`
 * (`{ $expr: { format, valueProviders } }`), so this package needs no import of an AppHost's generated module.
 */

export interface ReferenceExpressionLike {
  toJSON(): { $expr: { format: string; valueProviders?: unknown[] } };
  /** What the generated SDK's transport sends; it marshals the value providers (handles) itself. */
  toTransportValue(): { $expr: { format: string; valueProviders?: unknown[] } };
}

function marshal(value: unknown): unknown {
  return value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function" ? (value as { toJSON(): unknown }).toJSON() : value;
}

function escapeFormat(text: string): string {
  return text.replaceAll("{", "{{").replaceAll("}", "}}");
}

// A class, not an object literal: the transport sends plain objects member by member (functions become callbacks).
class Expression implements ReferenceExpressionLike {
  constructor(
    private readonly format: string,
    private readonly providers: readonly unknown[],
  ) {}

  toTransportValue() {
    return { $expr: { format: this.format, ...(this.providers.length > 0 ? { valueProviders: [...this.providers] } : {}) } };
  }

  toJSON() {
    return { $expr: { format: this.format, ...(this.providers.length > 0 ? { valueProviders: this.providers.map(marshal) } : {}) } };
  }
}

/** Joins literal text (strings and numbers) and deploy-time values into one expression. */
export function joinExpression(parts: readonly unknown[]): ReferenceExpressionLike {
  let format = "";
  const providers: unknown[] = [];
  for (const part of parts) {
    if (typeof part === "string" || typeof part === "number") {
      format += escapeFormat(String(part));
    } else {
      format += `{${providers.length}}`;
      providers.push(part);
    }
  }
  return new Expression(format, providers);
}

/** Tagged template: ``expr`https://${app}.${domainOutput}` ``. Literal braces are escaped. */
export function expr(strings: TemplateStringsArray, ...values: readonly unknown[]): ReferenceExpressionLike {
  const parts: unknown[] = [];
  strings.forEach((part, index) => {
    parts.push(part);
    if (index < values.length) parts.push(values[index]);
  });
  return joinExpression(parts);
}
