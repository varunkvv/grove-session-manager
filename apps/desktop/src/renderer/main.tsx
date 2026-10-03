import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyAppearance } from "./state/appearance.ts";
import "./app.css";

// before the first render, so a pinned appearance never flashes the other one
applyAppearance(new URLSearchParams(location.search).get("theme"));

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
