import type { ReactNode } from "react";
import { BottomTabs } from "./BottomTabs";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { UnsavedBanner } from "./UnsavedBanner";

/** Responsive frame: sidebar on desktop, bottom tabs on mobile. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-[var(--background)]">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 pb-28 lg:px-6 lg:pb-10">
          <UnsavedBanner />
          {children}
        </main>
      </div>
      <BottomTabs />
    </div>
  );
}
