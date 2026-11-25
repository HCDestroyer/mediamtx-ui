import { useSyncExternalStore } from "react";

/** Subscribes to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const media = matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** Same breakpoint as Tailwind's `lg`, where the sidebar replaces the bottom tabs. */
export const DESKTOP_QUERY = "(min-width: 1024px)";
