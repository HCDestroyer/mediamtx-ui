import type { ReactNode } from "react";

interface NavLinkProps {
  href: string;
  active: boolean;
  className?: string;
  children: ReactNode;
}

/** Plain anchor so navigation works with the hash router and keeps link semantics. */
export function NavLink({ href, active, className = "", children }: NavLinkProps) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${className}`}
    >
      {children}
    </a>
  );
}
