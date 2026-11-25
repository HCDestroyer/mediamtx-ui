import { EmptyState } from "@heroui/react";
import { Link2 } from "lucide-react";
import { t } from "../i18n/es";

export default function ConnectionsPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.connections.title}</h1>
      <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
        <Link2 size={32} aria-hidden className="text-[var(--muted)]" />
        <p className="font-semibold">{t.connections.comingTitle}</p>
        <p className="max-w-sm text-sm text-[var(--muted)]">{t.connections.comingBody}</p>
      </EmptyState>
    </div>
  );
}
