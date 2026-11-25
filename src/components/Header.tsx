import { ConnectionChip } from "./ConnectionChip";
import { ServerSelector } from "./ServerSelector";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Top bar. On mobile it carries the server selector (the sidebar is hidden);
 * on desktop the right side holds the network chip and quick actions.
 * Search (⌘K) and notifications arrive with the channel list in phase 2.
 */
export function Header() {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] lg:px-6">
      <div className="w-44 min-w-0 lg:hidden">
        <ServerSelector />
      </div>
      <div className="flex-1" />
      <ConnectionChip />
      <ThemeToggle />
    </header>
  );
}
