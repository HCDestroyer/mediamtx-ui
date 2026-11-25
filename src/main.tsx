import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startThemeSync } from "./store/prefs";
import "./styles/index.css";

startThemeSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
