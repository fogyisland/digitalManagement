/* ============================================
   Utility helpers
   ============================================ */

export function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes || bytes < 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds < 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * The naive form the database hands over: `YYYY-MM-DD HH:MM:SS`.
 *
 * It is always UTC — every connection sets `time_zone = '+00:00'` — but V8
 * parses this non-ISO form as LOCAL time, which shifts every timestamp by the
 * browser's offset. The instant is recovered by reading the string as UTC.
 *
 * The server reads the same form the same way, in `lib/auth.js` — the server
 * compares a stored expiry against the clock and the interface renders a
 * stored heartbeat against the clock, so the two rules have to be one rule.
 */
const NAIVE_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/

/**
 * Read a timestamp the API hands over as an instant.
 *
 * The naive DATETIME form is read as UTC — the database writes UTC, and the
 * browser is somewhere else. Every other shape (an ISO string with a zone, a
 * `Date` object) is read the way the platform reads it.
 *
 * @param date the value to read
 * @returns the instant, or null when the value is not a timestamp
 */
export function parseTimestamp(date: string | Date | null | undefined): Date | null {
  if (!date) return null
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date
  const text = String(date)
  const naive = NAIVE_UTC.exec(text)
  if (naive) return new Date(`${naive[1]}T${naive[2]}${naive[3] || ''}Z`)
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDate(date: string | Date | null | undefined, fmt = 'YYYY-MM-DD HH:mm'): string {
  const d = parseTimestamp(date)
  if (!d) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()))
}

export function relativeTime(date: string | Date | null | undefined): string {
  const d = parseTimestamp(date)
  if (!d) return ''
  const now = Date.now()
  const diff = Math.floor((now - d.getTime()) / 1000)
  // A timestamp from the future means the two clocks disagree, not that
  // something has not happened yet — so it reads as "just now" rather than
  // as a negative number of seconds.
  if (diff < 0) return '0 秒前'
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`
  return formatDate(d, 'YYYY-MM-DD')
}

export function debounce<T extends (...args: any[]) => void>(fn: T, delay = 300): T {
  let timer: number | null = null
  return ((...args: any[]) => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), delay)
  }) as T
}
