import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function build(candidates: string[]): Promise<string> {
  const compiler = await compile('@import "tailwindcss";\n@import "./theme.css";\n', {
    base: root,
    onDependency: () => {},
  });
  return compiler.build(candidates);
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  return css.slice(start, css.indexOf("}", start) + 1);
}

describe("github theme", () => {
  let css: string;

  beforeAll(async () => {
    css = await build([
      "text-fg",
      "text-fg-muted",
      "bg-canvas-muted",
      "border-line",
      "border-line-accent",
      "bg-success-emphasis",
      "text-display-blue",
      "shadow-lg",
      "rounded-md",
      "rounded-lg",
      "text-sm",
      "font-sans",
      "dark:bg-canvas-inset",
      "bg-zinc-900",
      "text-sky-300",
    ]);
  });

  it("maps Tailwind names onto Primer's functional tokens", () => {
    expect(rule(css, ".text-fg")).toContain("var(--fgColor-default)");
    expect(rule(css, ".text-fg-muted")).toContain("var(--fgColor-muted)");
    expect(rule(css, ".bg-canvas-muted")).toContain("var(--bgColor-muted)");
    expect(rule(css, ".border-line")).toContain("var(--borderColor-default)");
    expect(rule(css, ".border-line-accent")).toContain("var(--borderColor-accent-emphasis)");
    expect(rule(css, ".bg-success-emphasis")).toContain("var(--bgColor-success-emphasis)");
    expect(rule(css, ".text-display-blue")).toContain("var(--display-blue-fgColor)");
    expect(rule(css, ".shadow-lg")).toContain("var(--shadow-floating-small)");
  });

  it("uses Primer's type and radius scale", () => {
    expect(css).toMatch(/--text-sm: 0\.875rem;/);
    expect(css).toMatch(/--text-sm--line-height: 1\.5;/);
    expect(css).toMatch(/--radius-md: 0\.375rem;/);
    expect(css).toMatch(/--radius-lg: 0\.75rem;/);
    expect(css).toContain("--fontStack-sansSerif");
  });

  it("removes Tailwind's default palette so only GitHub colors exist", () => {
    expect(css).not.toContain(".bg-zinc-900");
    expect(css).not.toContain(".text-sky-300");
  });

  it("ships GitHub's light and dark themes behind data-color-mode", () => {
    expect(css).toContain('[data-color-mode="light"][data-light-theme="light"]');
    expect(css).toContain('[data-color-mode="dark"][data-dark-theme="dark"]');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toMatch(/\.dark\\:bg-canvas-inset/);
  });

  it("includes Primer component classes and Markdown styles", () => {
    for (const selector of [
      ".btn-primary",
      ".Label--success",
      ".Counter",
      ".State--merged",
      ".Box-row",
      ".UnderlineNav-item",
      ".AppHeader",
      ".flash-warn",
      ".form-control",
      ".TimelineItem-badge",
      ".markdown-body",
      ".Toast-icon",
      ".blob-code-addition",
    ]) {
      expect(css, selector).toContain(selector);
    }
  });

  it("bundles Mona Sans", async () => {
    expect(css).toContain("Mona Sans Variable");
    const base = await readFile(join(root, "src", "base.css"), "utf8");
    expect(base).toContain("@fontsource-variable/mona-sans");
  });
});
