import type { CSSProperties } from "react";
import { normalizeTokens, Prism, type PrismTheme, type Token } from "prism-react-renderer";

type Grammar = Parameters<typeof Prism.highlight>[1];

function register(): void {
  const languages = Prism.languages as unknown as Record<string, Grammar | undefined>;
  if (!languages.bash) {
    const bash: Grammar = {
      comment: { pattern: /(^|[^"{\\$])#.*/, lookbehind: true },
      string: [
        { pattern: /"(?:\\[\s\S]|\$\([^)]+\)|`[^`]+`|[^"\\])*"/, greedy: true },
        { pattern: /'[^']*'/, greedy: true },
      ],
      variable: /\$(?:\w+|[#?*!@$]|\{[^}]+\})/,
      function: {
        pattern:
          /(^|[\s;|&]|[<>]\()(?:npm|npx|pnpm|yarn|node|git|cd|ls|cat|echo|printf|mkdir|rm|cp|mv|grep|sed|awk|export|test|chmod|curl|tar|zip|unzip|copilot|docker)(?=$|[)\s;|&])/,
        lookbehind: true,
      },
      keyword: {
        pattern:
          /(^|[\s;|&]|[<>]\()(?:if|then|else|elif|fi|for|while|until|in|do|done|case|esac|function|return|exit|set|local|source)(?=$|[)\s;|&])/,
        lookbehind: true,
      },
      parameter: { pattern: /(^|\s)--?[\w-]+/, lookbehind: true, alias: "attr-name" },
      operator: /&&|\|\||[|&;<>]=?|=/,
      punctuation: /\$?\(\(?|\)\)?|\.\.|[{}[\];\\]/,
      number: { pattern: /(^|\s)\d+(?=$|\s)/, lookbehind: true },
    };
    languages.bash = bash;
    languages.sh = bash;
    languages.shell = bash;
  }
  if (!languages.diff) {
    languages.diff = {
      coord: [/^(?:\*{3}|-{3}|\+{3}).*$/m, /^@@.*@@.*$/m, /^\d.*$/m],
      deleted: /^[-<].*$/m,
      inserted: /^[+>].*$/m,
    };
  }
}

register();

export { Prism };

const syntax = (name: string): string => `var(--color-prettylights-syntax-${name})`;

/** GitHub's "pretty lights" syntax colors; they follow the light and dark themes. Backgrounds come from the containers. */
export const codeTheme: PrismTheme = {
  plain: { color: "var(--fgColor-default)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: syntax("comment") } },
    { types: ["punctuation"], style: { color: "var(--fgColor-default)" } },
    { types: ["keyword", "atrule", "operator"], style: { color: syntax("keyword") } },
    { types: ["string", "template-string", "char", "attr-value", "url"], style: { color: syntax("string") } },
    { types: ["regex"], style: { color: syntax("string-regexp") } },
    { types: ["number", "boolean", "constant", "symbol", "property", "parameter", "builtin"], style: { color: syntax("constant") } },
    { types: ["function", "method", "attr-name"], style: { color: syntax("entity") } },
    { types: ["class-name", "maybe-class-name", "known-class-name", "variable"], style: { color: syntax("variable") } },
    { types: ["tag", "selector"], style: { color: syntax("entity-tag") } },
    { types: ["inserted"], style: { color: syntax("markup-inserted-text") } },
    { types: ["deleted"], style: { color: syntax("markup-deleted-text") } },
    { types: ["coord"], style: { color: syntax("meta-diff-range"), fontWeight: "600" } },
    { types: ["title"], style: { color: syntax("markup-heading"), fontWeight: "600" } },
    { types: ["bold"], style: { fontWeight: "600" } },
    { types: ["italic"], style: { fontStyle: "italic" } },
  ],
};

const STYLES: ReadonlyMap<string, CSSProperties> = (() => {
  const styles = new Map<string, CSSProperties>();
  for (const entry of codeTheme.styles) {
    for (const type of entry.types) styles.set(type, { ...styles.get(type), ...(entry.style as CSSProperties) });
  }
  return styles;
})();

/** Inline style for a token's Prism types (later types win, like prism-react-renderer). */
export function tokenStyle(types: readonly string[]): CSSProperties | undefined {
  let style: CSSProperties | undefined;
  for (const type of types) {
    const entry = STYLES.get(type);
    if (entry) style = { ...style, ...entry };
  }
  return style;
}

export type { Token };

/** Splits highlighted code into lines of tokens, or undefined for plain text and unknown languages. */
export function tokenizeLines(code: string, language: string): Token[][] | undefined {
  if (language === PLAIN) return undefined;
  const grammar = (Prism.languages as unknown as Record<string, Grammar | undefined>)[language];
  if (!grammar) return undefined;
  return normalizeTokens(Prism.tokenize(code, grammar));
}

// Maps, not object literals: names come from untrusted artifacts and markdown (`__proto__`, `constructor`, ...).
const EXTENSION_LANGUAGES: ReadonlyMap<string, string> = new Map(Object.entries({
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  map: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  markdown: "markdown",
  patch: "diff",
  diff: "diff",
}));

const FENCE_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  js: "javascript",
  javascript: "javascript",
  node: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellsession: "bash",
  terminal: "bash",
  py: "python",
  python: "python",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  markup: "markup",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
}));

export const PLAIN = "plain";

export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function languageForPath(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name === "dockerfile" || name.endsWith(".env") || name === ".npmrc" || name === ".gitignore") return "bash";
  return EXTENSION_LANGUAGES.get(fileExtension(path)) ?? PLAIN;
}

export function languageForFence(fence: string | undefined): string {
  if (!fence) return PLAIN;
  return FENCE_ALIASES.get(fence.toLowerCase()) ?? PLAIN;
}

const LANGUAGE_LABELS: ReadonlyMap<string, string> = new Map(Object.entries({
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  bash: "Shell",
  python: "Python",
  yaml: "YAML",
  css: "CSS",
  markup: "HTML",
  markdown: "Markdown",
  diff: "Diff",
  plain: "Text",
}));

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS.get(language) ?? language;
}
