import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "assistant-theme";
const listeners = new Set<() => void>();

function readStored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** The choice in effect. Storage only persists it, so the UI stays right when storage is unavailable. */
let current: Theme = readStored();

export function getTheme(): Theme {
  return current;
}

/**
 * Applies a theme the way github.com does: `data-color-mode` on <html>, where "auto" follows the operating system.
 * main.tsx calls this before the first render, so a chosen theme never flashes the other one.
 */
export function applyTheme(theme: Theme = getTheme()): void {
  const root = document.documentElement;
  root.dataset.colorMode = theme === "system" ? "auto" : theme;
  root.dataset.lightTheme = "light";
  root.dataset.darkTheme = "dark";
  // The browser's toolbar color (index.html's theme-color metas) follows the chosen theme too.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-scheme]')) {
    const scheme = meta.dataset.scheme;
    meta.media = theme === "system" ? `(prefers-color-scheme: ${scheme})` : scheme === theme ? "all" : "not all";
  }
}

export function setTheme(theme: Theme): void {
  current = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private browsing: the choice lasts for this page only.
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the theme.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    current = readStored();
    applyTheme();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The person's theme choice, kept current wherever it changes (the header menu, Settings, or another tab). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "system");
}
