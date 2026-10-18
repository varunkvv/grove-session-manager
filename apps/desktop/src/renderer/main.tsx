import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ChatApp } from "./components/Chat.tsx";
import { applyAppearance } from "./state/appearance.ts";
import "./app.css";

// before the first render, so a pinned appearance never flashes the other one
applyAppearance(new URLSearchParams(location.search).get("theme"));

// one bundle, two pages: a grove chat window is `#/chat`, and never runs the main window's app
const chat = location.hash.startsWith("#/chat");

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>{chat ? <ChatApp /> : <App />}</StrictMode>,
);
