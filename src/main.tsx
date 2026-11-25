import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setupNative } from "./core/native";
import { startThemeSync } from "./store/prefs";
import "./styles/index.css";

// Must run before anything makes a request: in the Android app all HTTP goes through the native stack.
setupNative();
startThemeSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
