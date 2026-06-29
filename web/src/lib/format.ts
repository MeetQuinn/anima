// Shared formatting helpers used across multiple views.

import { format, formatDistance, isToday, isYesterday } from 'date-fns';

// ---- bytes ----------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- tokens ---------------------------------------------------------------

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// ---- date / time ----------------------------------------------------------

/** "14:32" — local 24-hour clock. */
export function clockHM(iso: string): string {
  return format(new Date(iso), 'HH:mm');
}

/** "2024-01-15" — local date key for day-boundary grouping. */
export function dateKey(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd');
}

/**
 * "Tuesday, January 15, 2024 at 14:32" — full local date + time, for the
 * hover tooltip on a message timestamp (the timeline only shows HH:mm inline).
 */
export function dateTimeFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return format(d, "EEEE, MMMM d, yyyy 'at' HH:mm");
}

/** "Today" / "Yesterday" / "Tuesday, January 15" */
export function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEEE, MMMM d');
}

/**
 * "14:32" for today, "tomorrow 14:32" for tomorrow,
 * "Jan 15 14:32" for other dates.
 */
export function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = format(d, 'HH:mm');
  if (isToday(d)) return hm;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hm}`;
  return `${format(d, 'MMM d')} ${hm}`;
}

/** "3m" / "2h 15m" / "1d 4h" — compact duration since a given ISO timestamp. */
export function formatUptime(fromIso: string, now: Date): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/** "3 minutes ago" / "about 2 hours ago" — sentence-style relative time. */
export function formatRelative(fromIso: string, now: Date): string {
  const d = new Date(fromIso);
  if (!Number.isFinite(d.getTime()) || d > now) return '—';
  return formatDistance(d, now, { addSuffix: true });
}

/** "Jan 15, 14:32" — compact local timestamp. */
export function shortIso(iso?: string): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

/** "3 min ago" / "in 2 hr" / "Jan 15" — compact relative time (past or future). */
export function formatRelativeShort(iso: string | undefined, now: Date): string {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  const diffMs = target - now.getTime();
  const absMin = Math.abs(diffMs) / 60000;
  const future = diffMs >= 0;
  if (absMin < 1) return future ? 'soon' : 'just now';
  if (absMin < 60) {
    const m = Math.round(absMin);
    return future ? `in ${m} min` : `${m} min ago`;
  }
  const absHr = absMin / 60;
  if (absHr < 24) {
    const h = Math.round(absHr);
    return future ? `in ${h} hr` : `${h} hr ago`;
  }
  const absDay = absHr / 24;
  const d = Math.round(absDay);
  if (d < 14) return future ? `in ${d} d` : `${d} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
