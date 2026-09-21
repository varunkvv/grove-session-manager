const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "5m ago", "2h ago", "2d ago", "3w ago" - never a timestamp */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 14 * DAY) return `${Math.floor(d / DAY)}d ago`;
  if (d < 9 * 7 * DAY) return `${Math.floor(d / (7 * DAY))}w ago`;
  if (d < 365 * DAY) return `${Math.floor(d / (30 * DAY))}mo ago`;
  return `${Math.floor(d / (365 * DAY))}y ago`;
}

export type DayBucket = "Today" | "Yesterday" | "This week" | "Last week" | "Older";

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayBucket(ms: number, now: number = Date.now()): DayBucket {
  const today = startOfDay(now);
  if (ms >= today) return "Today";
  if (ms >= today - DAY) return "Yesterday";
  // weeks start on monday
  const dow = (new Date(today).getDay() + 6) % 7;
  const weekStart = today - dow * DAY;
  if (ms >= weekStart) return "This week";
  if (ms >= weekStart - 7 * DAY) return "Last week";
  return "Older";
}

/** 45_000 -> "45s", 720_000 -> "12m", 5_400_000 -> "1h 30m" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}
