const nf1 = new Intl.NumberFormat("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Mbps with one decimal, or an em dash while the rate is still unknown. */
export function formatMbps(value: number | null | undefined): string {
  return value == null ? "—" : nf1.format(value);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : nf1.format(value)} ${UNITS[unit]}`;
}

/** "2 h 14 min", "5 min", "40 s". Returns an em dash for missing or future dates. */
export function formatSince(iso: string | null, now: number): string {
  const started = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(started) || started > now) return "—";
  const seconds = Math.floor((now - started) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/** "hace 3 s" style label for the "last updated" line. */
export function formatAgo(at: number | null, now: number): string {
  if (at == null) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 60 ? `hace ${seconds} s` : `hace ${Math.round(seconds / 60)} min`;
}
