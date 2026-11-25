import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import { Sparkline } from "./Sparkline";

interface KpiCardProps {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  /** Small line under the value. */
  hint?: string;
  trend?: readonly number[];
  trendColor?: string;
}

export function KpiCard({ icon, label, value, unit, hint, trend, trendColor }: KpiCardProps) {
  return (
    <Card>
      <Card.Content className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-sm text-[var(--muted)]">
          {icon}
          {label}
        </div>
        <div className="tabular text-2xl font-bold tracking-tight lg:text-3xl">
          {value}
          {unit ? <span className="ml-1 text-sm font-medium text-[var(--muted)]">{unit}</span> : null}
        </div>
        {hint ? <div className="text-xs text-[var(--muted)]">{hint}</div> : null}
        {trend ? <Sparkline values={trend} color={trendColor} className="mt-1 h-8 w-full" /> : null}
      </Card.Content>
    </Card>
  );
}
