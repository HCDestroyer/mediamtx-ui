import { useSyncExternalStore } from "react";

export type Route =
  | { name: "channels" }
  | { name: "channel"; channel: string }
  | { name: "connections" }
  | { name: "services" }
  | { name: "servers" }
  | { name: "settings" }
  | { name: "not-found" };

/** Parses a hash such as `#/channels/canal63`. Minimal on purpose. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second] = parts;
  if (parts.length === 0) return { name: "channels" };
  if (first === "channels" && second && parts.length === 2) return { name: "channel", channel: second };
  if (parts.length === 1 && first === "channels") return { name: "channels" };
  if (parts.length === 1 && first === "connections") return { name: "connections" };
  if (parts.length === 1 && first === "services") return { name: "services" };
  if (parts.length === 1 && first === "servers") return { name: "servers" };
  if (parts.length === 1 && first === "settings") return { name: "settings" };
  return { name: "not-found" };
}

export function hrefFor(route: Exclude<Route, { name: "not-found" }>): string {
  switch (route.name) {
    case "channels":
      return "#/";
    case "channel":
      return `#/channels/${encodeURIComponent(route.channel)}`;
    case "connections":
      return "#/connections";
    case "services":
      return "#/services";
    case "servers":
      return "#/servers";
    case "settings":
      return "#/settings";
  }
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}
