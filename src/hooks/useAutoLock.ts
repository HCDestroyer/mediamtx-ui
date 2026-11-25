import { useEffect } from "react";
import { useAuth } from "../store/auth";
import { usePrefs } from "../store/prefs";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
const CHECK_EVERY_MS = 10_000;

/** Locks the panel after the configured time without interaction. */
export function useAutoLock(): void {
  const status = useAuth((s) => s.status);
  const minutes = usePrefs((s) => s.autoLockMinutes);

  useEffect(() => {
    if (status !== "unlocked" || minutes === 0) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const check = () => {
      if (Date.now() - last >= minutes * 60_000) useAuth.getState().lock();
    };
    const onVisible = () => { if (!document.hidden) check(); };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, touch, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(check, CHECK_EVERY_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, touch);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, [status, minutes]);
}
