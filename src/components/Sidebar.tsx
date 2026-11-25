import { Radio, Link2, Server, Waypoints, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { t } from "../i18n/es";
import { hrefFor, useRoute, type Route } from "../router";
import { NavLink } from "./NavLink";
import { ServerSelector } from "./ServerSelector";

export interface NavItem {
  route: Exclude<Route["name"], "channel" | "not-found">;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { route: "channels", label: t.nav.channels, icon: Radio },
  { route: "connections", label: t.nav.connections, icon: Link2 },
  { route: "services", label: t.nav.services, icon: Waypoints },
  { route: "servers", label: t.nav.servers, icon: Server },
  { route: "settings", label: t.nav.settings, icon: SlidersHorizontal },
];

/** A channel detail page keeps "Channels" highlighted. */
export function isActive(item: NavItem, route: Route): boolean {
  return route.name === item.route || (item.route === "channels" && route.name === "channel");
}

const GROUPS: Array<{ title: string; items: NavItem["route"][] }> = [
  { title: t.nav.groupOperation, items: ["channels", "services", "connections"] },
  { title: t.nav.groupManagement, items: ["servers", "settings"] },
];

/** Desktop navigation: server selector on top, then the sections. */
export function Sidebar() {
  const route = useRoute();
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-5 border-r border-[var(--border)] bg-[var(--surface)] p-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)] lg:flex">
      <div className="flex items-center gap-2 px-1 font-bold">
        <span className="grid size-6 place-items-center rounded-md bg-[var(--accent)] text-[var(--accent-foreground)]">
          <Radio size={15} aria-hidden />
        </span>
        {t.app.name}
      </div>
      <ServerSelector />
      <nav aria-label="Principal" className="flex flex-col gap-4">
        {GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              {group.title}
            </div>
            {NAV_ITEMS.filter((item) => group.items.includes(item.route)).map((item) => {
              const active = isActive(item, route);
              return (
                <NavLink
                  key={item.route}
                  href={hrefFor({ name: item.route })}
                  active={active}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-[var(--accent-soft)] text-[var(--accent-soft-foreground)]"
                      : "text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                  }`}
                >
                  <item.icon size={18} aria-hidden />
                  {item.label}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
