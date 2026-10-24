import type { WorkOrderTemplate } from "./types.js";

export const HAPPY_PATH_TEMPLATE_ID = "csv-json-toolkit";

export const TEMPLATES: readonly WorkOrderTemplate[] = [
  {
    id: HAPPY_PATH_TEMPLATE_ID,
    title: "CSV ⇄ JSON toolkit",
    tagline: "Two command-line tools built side by side in separate sandboxes, then integrated and released.",
    estimate: "~5 min",
    tags: ["Node.js", "CLI", "2 parallel builders"],
    featured: true,
    brief: `Build \`csvjson\`, a zero-dependency Node.js 24 toolkit with two command-line tools and tests.

1. \`csv2json\` reads CSV from a file path argument or stdin and prints a JSON array of objects keyed by the header row.
   - RFC 4180 parsing: quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF or LF line endings.
   - \`--pretty\` prints with 2-space indentation. \`--delimiter <char>\` changes the separator (default ",").
   - Numbers and true/false become JSON numbers and booleans; empty fields become null. \`--no-infer\` keeps every value as a string.
2. \`json2csv\` reads a JSON array of objects from a file path argument or stdin and prints CSV.
   - The header row is the union of keys in first-seen order; missing values are empty.
   - Quote fields that contain the delimiter, quotes, or newlines, and escape quotes by doubling them.
   - \`--delimiter <char>\` changes the separator.

Both tools exit with status 1 and a one-line error on invalid input or a missing file. Use only Node built-ins and test with node:test.`,
  },
  {
    id: "csv-to-json-cli",
    title: "CSV → JSON CLI",
    tagline: "A single command-line tool with a tested parser.",
    estimate: "~4 min",
    tags: ["Node.js", "CLI"],
    brief: `Build a zero-dependency Node.js 24 CLI named \`csv2json\` that converts CSV (from a file path argument or stdin) to a JSON array of objects keyed by the header row.

- Handle quoted fields, escaped quotes, and commas or newlines inside quotes.
- \`--pretty\` prints with 2-space indentation.
- Exit with status 1 and a one-line error when the file is missing or the CSV is malformed.

Include tests with node:test for the parser and the CLI.`,
  },
  {
    id: "semver-toolkit",
    title: "Semantic version toolkit",
    tagline: "A small library and CLI: parse, compare, sort, and bump versions.",
    estimate: "~5 min",
    tags: ["Node.js", "Library", "CLI"],
    brief: `Build \`semver-lite\`, a zero-dependency Node.js 24 library and CLI for semantic versions (semver 2.0.0).

- Library: \`parse(version)\` returns { major, minor, patch, prerelease: string[], build: string[] } or throws a descriptive error; \`compare(a, b)\` returns -1, 0, or 1 following semver precedence (prerelease ordering included, build metadata ignored); \`sort(versions)\`; \`bump(version, "major" | "minor" | "patch")\`.
- CLI \`semver\`: \`semver compare 1.2.3 1.10.0\`, \`semver sort <versions...>\`, \`semver bump minor 1.2.3\`. Invalid input exits with status 1 and a one-line error.

Test the library and the CLI with node:test.`,
  },
  {
    id: "markdown-table-formatter",
    title: "Markdown table formatter",
    tagline: "Align and normalize Markdown tables from the command line.",
    estimate: "~5 min",
    tags: ["Node.js", "CLI", "Text"],
    brief: `Build \`mdtable\`, a zero-dependency Node.js 24 CLI that reads Markdown from a file path argument or stdin and prints it with every GitHub-flavored Markdown table reformatted.

- Pad cells so the pipes line up, honoring column alignment markers (\`:---\`, \`:---:\`, \`---:\`).
- Escaped pipes (\`\\|\`) inside cells stay escaped; text outside tables is unchanged byte for byte.
- \`--check\` exits with status 1 and lists the line numbers of tables that are not formatted, without printing the document.

Test the formatter and the CLI with node:test.`,
  },
];

export function findTemplate(id: string | undefined): WorkOrderTemplate | undefined {
  return id ? TEMPLATES.find((template) => template.id === id) : undefined;
}
