/** RFC 5322 message building for Gmail drafts and sends, with header-injection protection. */
import { ToolError } from "../types.js";

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const NAMED_ADDRESS = /^\s*"?([^"<>]*?)"?\s*<([^<>]+)>\s*$/;

function assertSingleLine(value: string, field: string): void {
  if (/[\r\n\0]/.test(value)) throw new ToolError(`The ${field} must be a single line.`);
}

/** Validates `a@b.example` or `Name <a@b.example>` and returns a header-safe form. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  assertSingleLine(value, "address");
  const named = NAMED_ADDRESS.exec(value);
  const email = (named ? named[2]! : value).trim();
  if (!ADDRESS.test(email)) throw new ToolError(`"${input}" is not a valid email address.`);
  const name = named?.[1]?.trim();
  return name ? `${encodeWord(name)} <${email}>` : email;
}

/** The bare address from `Name <a@b>` or `a@b`. */
export function addressOf(input: string): string {
  const named = NAMED_ADDRESS.exec(input);
  return (named ? named[2]! : input).trim().toLowerCase();
}

/** RFC 2047 encoded-word for non-ASCII header text; plain ASCII passes through. */
export function encodeWord(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return /[",;<>@()]/.test(text) ? `"${text.replace(/["\\]/g, "\\$&")}"` : text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/**
 * Unstructured header text such as Subject: printable ASCII is sent as is (commas and parentheses need no quoting
 * there), anything else as RFC 2047 encoded-words of whole characters, each short enough for one header line.
 */
export function encodeHeaderText(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk && Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

export interface MimeMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}

function wrap(base64: string): string {
  return base64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export function buildMime(message: MimeMessage): string {
  if (message.to.length === 0) throw new ToolError("At least one recipient is required.");
  assertSingleLine(message.subject, "subject");
  const headers = [
    `To: ${message.to.map(normalizeAddress).join(", ")}`,
    ...(message.cc && message.cc.length ? [`Cc: ${message.cc.map(normalizeAddress).join(", ")}`] : []),
    `Subject: ${encodeHeaderText(message.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (message.inReplyTo) {
    assertSingleLine(message.inReplyTo, "In-Reply-To header");
    headers.push(`In-Reply-To: ${message.inReplyTo}`);
  }
  if (message.references) {
    assertSingleLine(message.references, "References header");
    headers.push(`References: ${message.references}`);
  }
  const body = message.body.replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${wrap(Buffer.from(body, "utf8").toString("base64"))}\r\n`;
}

export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Readable text from an HTML email body (for the model, not for rendering). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return ENTITIES[lower] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
