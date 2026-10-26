import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./theme";
import "./styles.css";

// Before the first render, so a chosen light or dark theme never flashes the other one.
applyTheme();

async function boot(): Promise<void> {
  let preview: ReactNode;
  // Fixture preview for UI work only (`vite`, then open `/?preview`). Production builds drop this branch and the
  // fixtures with it, because import.meta.env.DEV is false there.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview")) {
    const { installPreview } = await import("./dev/preview");
    preview = installPreview();
  }
  const container = document.getElementById("root");
  if (!container) throw new Error("The page is missing its #root element.");
  createRoot(container).render(
    <StrictMode>
      <App preview={preview} />
    </StrictMode>,
  );
}

void boot();
