import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { captureSignInTicket, startAuth } from "./lib/auth.js";
import "./styles.css";

// First thing: a sign-in ticket in the URL fragment leaves the address bar before anything else runs.
captureSignInTicket();

async function boot(): Promise<void> {
  // Sample data for UI work only: `vite dev` with `?fixtures`. `import.meta.env.DEV` is false in production builds, so
  // this branch and the fixture modules are compiled out of the console the gateway serves.
  if (import.meta.env.DEV) {
    const { fixturesRequested } = await import("./dev/flag.js");
    const variant = fixturesRequested();
    if (variant) {
      const { installFixtures } = await import("./dev/server.js");
      installFixtures(variant);
    }
  }
  startAuth();
  const container = document.getElementById("root");
  if (!container) throw new Error("The console page is missing its #root element.");
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
