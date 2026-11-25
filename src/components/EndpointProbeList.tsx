import { Chip } from "@heroui/react";
import { t } from "../i18n/es";
import type { Endpoint } from "../core/types";
import type { ProbeResult } from "../core/resolver";

interface EndpointProbeListProps {
  endpoints: Endpoint[];
  /** Last probe results; endpoints without one show as not tested. */
  results?: ProbeResult[];
  /** Type of the endpoint currently in use. */
  activeType?: Endpoint["type"];
}

/** One row per endpoint with the result of the last probe. */
export function EndpointProbeList({ endpoints, results, activeType }: EndpointProbeListProps) {
  const shown = endpoints.filter((e) => e.apiUrl.trim() !== "");
  if (shown.length === 0) {
    return <p className="text-sm text-[var(--muted)]">{t.servers.notSet}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {shown.map((endpoint) => {
        const result = results?.find((r) => r.endpoint.type === endpoint.type);
        const isActive = activeType === endpoint.type;
        return (
          <li
            key={endpoint.type}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
              isActive
                ? "bg-[var(--success-soft)] outline outline-1 outline-[var(--success)]"
                : "bg-[var(--surface-secondary)]"
            }`}
          >
            <span className="w-14 shrink-0 font-semibold">{t.network[endpoint.type]}</span>
            <code className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">{endpoint.apiUrl}</code>
            {result ? (
              result.ok ? (
                <Chip size="sm" color="success" variant="soft">
                  <span className="tabular">{result.latencyMs} ms</span>
                </Chip>
              ) : (
                <Chip size="sm" color={result.failure === "auth" ? "warning" : "danger"} variant="soft">
                  {t.probeFailureShort[result.failure ?? "network"]}
                </Chip>
              )
            ) : (
              <span className="text-xs text-[var(--muted)]">{t.servers.notTested}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
