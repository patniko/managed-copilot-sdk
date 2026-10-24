import { Prism, type PrismTheme } from "prism-react-renderer";

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

/** Muted palette tuned for the zinc surfaces; backgrounds come from the containers. */
export const codeTheme: PrismTheme = {
  plain: { color: "#e4e4e7", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "#71717a", fontStyle: "italic" } },
    { types: ["punctuation"], style: { color: "#a1a1aa" } },
    { types: ["namespace"], style: { opacity: 0.8 } },
    { types: ["property", "tag", "constant", "symbol", "deleted"], style: { color: "#fda4af" } },
    { types: ["boolean", "number"], style: { color: "#fcd34d" } },
    { types: ["selector", "attr-name", "char", "builtin", "inserted"], style: { color: "#86efac" } },
    { types: ["string", "template-string", "attr-value"], style: { color: "#86efac" } },
    { types: ["operator", "entity", "url"], style: { color: "#d4d4d8" } },
    { types: ["atrule", "keyword", "important"], style: { color: "#7dd3fc" } },
    { types: ["function", "method"], style: { color: "#c4b5fd" } },
    { types: ["class-name", "maybe-class-name", "known-class-name"], style: { color: "#fde68a" } },
    { types: ["regex", "variable"], style: { color: "#fdba74" } },
    { types: ["parameter"], style: { color: "#fde68a" } },
    { types: ["coord"], style: { color: "#7dd3fc" } },
    { types: ["title"], style: { color: "#fde68a", fontWeight: "bold" } },
    { types: ["bold"], style: { fontWeight: "bold" } },
    { types: ["italic"], style: { fontStyle: "italic" } },
  ],
};

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
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
};

const FENCE_ALIASES: Readonly<Record<string, string>> = {
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
};

export const PLAIN = "plain";

export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function languageForPath(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name === "dockerfile" || name.endsWith(".env") || name === ".npmrc" || name === ".gitignore") return "bash";
  return EXTENSION_LANGUAGES[fileExtension(path)] ?? PLAIN;
}

export function languageForFence(fence: string | undefined): string {
  if (!fence) return PLAIN;
  return FENCE_ALIASES[fence.toLowerCase()] ?? PLAIN;
}

export const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
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
};
