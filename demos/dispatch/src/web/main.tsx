import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

async function boot(): Promise<void> {
  // Fixture preview for UI work only; excluded from production builds (import.meta.env.DEV is false there).
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview")) {
    const { installPreview } = await import("./dev/preview.js");
    installPreview();
  }
  const container = document.getElementById("root");
  if (!container) throw new Error("The page is missing its #root element.");
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
