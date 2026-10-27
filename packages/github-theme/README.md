# @managed-copilot/github-theme

GitHub's look and feel for the Managed Copilot web apps (the assistant, software factory, and Dispatch demos, and the
operator console). It packages:

- **Primer design tokens** from [`@primer/primitives`](https://github.com/primer/primitives): the same CSS variables
  github.com uses, with GitHub's light and dark themes.
- **Mona Sans**, GitHub's typeface, bundled from `@fontsource-variable/mona-sans` (SIL Open Font License 1.1).
- **Tailwind CSS v4 theme names** for those tokens. The default Tailwind palette is removed, so only GitHub colors exist.
- **Primer component classes** with github.com's class names (`btn`, `Label`, `Counter`, `State`, `Box`,
  `UnderlineNav`, `AppHeader`, `flash`, `form-control`, `TimelineItem`, `markdown-body`, ...).

Icons come from [`@primer/octicons-react`](https://primer.style/octicons), which each app depends on directly.

## Use

```css
/* src/styles.css */
@import "tailwindcss";
@import "@managed-copilot/github-theme";
```

```html
<html lang="en" data-color-mode="auto" data-light-theme="light" data-dark-theme="dark">
  <meta name="color-scheme" content="light dark" />
```

`data-color-mode="auto"` follows the operating system, like github.com. Set it to `light` or `dark` to choose a theme;
any subtree can carry its own `data-color-mode`. The `dark:` variant matches GitHub's dark theme either way.

## Tokens

| Tailwind | Primer token | Use |
| --- | --- | --- |
| `text-fg`, `text-fg-muted`, `text-fg-accent`, `text-fg-success`, `text-fg-attention`, `text-fg-danger`, `text-fg-done`, `text-fg-on-emphasis` | `--fgColor-*` | Text and icons |
| `bg-canvas`, `bg-canvas-muted`, `bg-canvas-inset`, `bg-canvas-emphasis`, `bg-canvas-overlay` | `--bgColor-default/muted/inset/emphasis`, `--overlay-bgColor` | Page and panel surfaces |
| `bg-accent-muted`, `bg-success-emphasis`, `bg-attention-muted`, `bg-danger-emphasis`, `bg-done-muted`, `bg-neutral-muted`, ... | `--bgColor-<role>-muted/-emphasis` | Status fills |
| `bg-control`, `bg-control-transparent-hover`, `bg-control-transparent-selected` | `--control-*` | Interactive surfaces |
| `border-line`, `border-line-muted`, `border-line-accent`, `border-line-danger-muted`, ... | `--borderColor-*` | Borders and dividers (plain `border` already uses `border-line`) |
| `text-display-blue`, `bg-display-green-muted`, ... | `--display-<color>-*` | Charts and identity colors |
| `shadow-xs/sm/md` (resting), `shadow-lg/xl/2xl` (floating) | `--shadow-resting-*`, `--shadow-floating-*` | Elevation |
| `rounded-sm` 3px, `rounded-md` 6px, `rounded-lg` 12px | `--borderRadius-*` | Controls and boxes use 6px; overlays and dialogs 12px |
| `text-xs` 12, `text-sm` 14, `text-base` 16, `text-lg` 20, `text-xl` 24, `text-2xl` 32 | Primer type scale | Body text is 14px with a 1.5 line height |

## Test

```powershell
pnpm --filter @managed-copilot/github-theme test
```
