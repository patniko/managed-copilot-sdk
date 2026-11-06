import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("The page is missing its #root element.");
let page: ReactNode = <App />;
// Sample states for UI work only (`pnpm dev`, then open /?preview). Production builds drop this branch and the samples
// with it, because import.meta.env.DEV is false there.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview")) {
  const { Preview } = await import("./dev/preview.js");
  page = <Preview />;
}
createRoot(container).render(<StrictMode>{page}</StrictMode>);
