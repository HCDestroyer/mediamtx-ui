import { hrefFor, useRoute } from "../router";
import { NavLink } from "./NavLink";
import { isActive, NAV_ITEMS } from "./Sidebar";

/** Mobile navigation: four tabs fixed to the bottom edge. */
export function BottomTabs() {
  const route = useRoute();
  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-[var(--border)] bg-[var(--surface)] px-1 pt-2 pb-safe lg:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(item, route);
        return (
          <NavLink
            key={item.route}
            href={hrefFor({ name: item.route })}
            active={active}
            className={`flex flex-col items-center gap-0.5 pb-2 text-[11px] font-medium ${
              active ? "text-[var(--accent)]" : "text-[var(--muted)]"
            }`}
          >
            <item.icon size={22} aria-hidden />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
