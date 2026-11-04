export interface FrontmatterEntry {
  readonly key: string;
  readonly value: string;
}

export interface ParsedDocument {
  /** Top-level keys of a leading `---` YAML block, in order (values as written, quotes removed from scalars). */
  readonly frontmatter: readonly FrontmatterEntry[];
  /** The document without its frontmatter block. */
  readonly body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Splits a customization file (`*.agent.md`, `SKILL.md`, instructions) into its YAML frontmatter and markdown body.
 * Only a display aid: nested values (lists, maps, block scalars) are kept as their source text under the top-level key.
 * Without a complete leading block (or when the content was truncated inside it) the whole text is the body.
 */
export function parseFrontmatter(content: string): ParsedDocument {
  const text = content.startsWith("\ufeff") ? content.slice(1) : content;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[0]?.trim() !== "---") return { frontmatter: [], body: content };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === "---" || line === "...") {
      end = index;
      break;
    }
  }
  if (end === -1) return { frontmatter: [], body: content };
  const entries: { key: string; value: string }[] = [];
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(.*)$/.exec(line);
    if (match && !/^\s/.test(line)) {
      entries.push({ key: match[1] ?? "", value: unquote(match[2] ?? "") });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last) last.value = last.value ? `${last.value}\n${line.trimEnd()}` : line.trim();
  }
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  return { frontmatter: entries, body };
}

/** Markdown files the viewer renders (everything else is shown as source). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
