import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePref = "system" | "light" | "dark";

export const POLL_INTERVALS_MS = [1000, 2000, 5000, 10000] as const;
export type PollIntervalMs = (typeof POLL_INTERVALS_MS)[number];

interface PrefsState {
  theme: ThemePref;
  /** Dashboard refresh interval (used from phase 2). */
  pollIntervalMs: PollIntervalMs;
  setTheme: (theme: ThemePref) => void;
  setPollIntervalMs: (value: PollIntervalMs) => void;
}

// The storage key is also read by the inline script in index.html.
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: "system",
      pollIntervalMs: 2000,
      setTheme: (theme) => set({ theme }),
      setPollIntervalMs: (pollIntervalMs) => set({ pollIntervalMs }),
    }),
    { name: "mediamtx-panel:prefs", version: 1 },
  ),
);

export function resolveTheme(theme: ThemePref): "light" | "dark" {
  if (theme !== "system") return theme;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: ThemePref): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.setAttribute("data-theme", resolved);
}

/** Keeps the document theme in sync with the preference and the OS setting. */
export function startThemeSync(): () => void {
  applyTheme(usePrefs.getState().theme);
  const unsubscribe = usePrefs.subscribe((state, previous) => {
    if (state.theme !== previous.theme) applyTheme(state.theme);
  });
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (usePrefs.getState().theme === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => {
    unsubscribe();
    media.removeEventListener("change", onChange);
  };
}
