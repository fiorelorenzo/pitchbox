/** Formats a date as a human-readable relative time string, e.g. "5 min ago" */
export function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/** Formats a duration in ms as a human-readable string, e.g. "1m 14s" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

/** Formats a relative offset in ms from run start, e.g. "+2s", "+1m 14s" */
export function formatOffset(ms: number): string {
  if (ms < 1000) return 'just now';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `+${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `+${min}m ${sec}s` : `+${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `+${hr}h ${remMin}m`;
}
