/**
 * Deadline parsing, anchored to Hong Kong time.
 *
 * The bug this fixes: `new Date(text)` interprets a zone-less datetime string in
 * the **runtime's** local timezone. The scraper runs on a UTC GitHub Actions
 * runner during CI and on a UTC+8 laptop during development, so the same posting
 * produced two different instants eight hours apart — enough to move a deadline
 * onto the wrong calendar day in the app.
 *
 * Every target is a Hong Kong employer, and Hong Kong has been UTC+8 with no
 * daylight saving since 1979. That makes the offset a constant, so this needs no
 * `Intl` timezone arithmetic — just an explicit UTC construction and a shift.
 */

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** `Z`, `+08:00`, `+0800`, `GMT`, `UTC` — an explicit zone means we must not assume. */
const HAS_EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i;

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour?: number | undefined;
  minute?: number | undefined;
  second?: number | undefined;
}

function extractTime(text: string): Pick<DateParts, 'hour' | 'minute' | 'second'> {
  // AM/PM is tried FIRST and deliberately. Running the 24-hour pattern first made
  // "6:30 pm" match as 06:30 and silently discard the "pm", turning an evening
  // deadline into a morning one.
  const twelve = /(?<!\d)(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)(?![a-z])/i.exec(text);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] ? Number(twelve[2]) : 0;
    const isPm = twelve[3]?.toLowerCase() === 'pm';
    // An out-of-range hour here means it was really a 24-hour time (e.g. "18:30pm"),
    // so fall through rather than returning a wrong value.
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      if (hour === 12) hour = isPm ? 12 : 0;
      else if (isPm) hour += 12;
      return { hour, minute, second: 0 };
    }
  }

  const twentyFour = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    const second = twentyFour[3] ? Number(twentyFour[3]) : 0;
    if (hour <= 23 && minute <= 59 && second <= 59) {
      return { hour, minute, second };
    }
  }

  return {};
}

function extractDate(text: string): { year: number; month: number; day: number } | null {
  // 2026-10-31 / 2026/10/31
  const iso = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(text);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  // 31/10/2026 — Hong Kong writes day-first. Only fall back to month-first when
  // the second number cannot be a month but the first can (e.g. 10/31/2026).
  const numeric = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/.exec(text);
  if (numeric) {
    let first = Number(numeric[1]);
    let second = Number(numeric[2]);
    if (second > 12 && first <= 12) {
      const swap = first;
      first = second;
      second = swap;
    }
    return { year: Number(numeric[3]), month: second, day: first };
  }

  // 31 Oct 2026 / 31 October 2026
  const dayMonthName = /(?<!\d)(\d{1,2})\s*[- ]?\s*([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})(?!\d)/.exec(text);
  if (dayMonthName) {
    const month = MONTHS[dayMonthName[2]?.toLowerCase() ?? ''];
    if (month) {
      return { year: Number(dayMonthName[3]), month, day: Number(dayMonthName[1]) };
    }
  }

  // Oct 31, 2026 / October 31 2026
  const monthNameDay = /([A-Za-z]{3,9})\.?\s*(\d{1,2})\s*,?\s*(\d{4})(?!\d)/.exec(text);
  if (monthNameDay) {
    const month = MONTHS[monthNameDay[1]?.toLowerCase() ?? ''];
    if (month) {
      return { year: Number(monthNameDay[3]), month, day: Number(monthNameDay[2]) };
    }
  }

  return null;
}

function isPlausible(parts: DateParts, now: Date): boolean {
  if (parts.month < 1 || parts.month > 12) return false;
  if (parts.day < 1 || parts.day > 31) return false;
  if (parts.year < 2000 || parts.year > now.getUTCFullYear() + 6) return false;

  // Reject rollovers: 2026-02-31 silently becomes 2026-03-03 otherwise, which
  // would show a deadline in a month the posting never mentioned.
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return probe.getUTCMonth() === parts.month - 1 && probe.getUTCDate() === parts.day;
}

/**
 * Parse a deadline into an ISO instant.
 *
 * - Explicit zone in the text (`Z`, `+08:00`, `GMT`) → respected as-is.
 * - Date and time, no zone → that wall-clock time in Hong Kong.
 * - Date only, no time → 23:59:59 on that day in Hong Kong, so a deadline covers
 *   the whole of its final day rather than expiring at midnight *before* it.
 */
export function parseHongKongDateTime(input: unknown, now: Date = new Date()): string | undefined {
  if (typeof input !== 'string') return undefined;
  const text = input.trim();
  if (!text) return undefined;

  if (HAS_EXPLICIT_ZONE.test(text)) {
    const explicit = new Date(text);
    return Number.isNaN(explicit.getTime()) ? undefined : explicit.toISOString();
  }

  const date = extractDate(text);
  if (!date) return undefined;

  const time = extractTime(text);
  const parts: DateParts = { ...date, ...time };
  if (!isPlausible(parts, now)) return undefined;

  const hasTime = time.hour !== undefined;
  const hour = hasTime ? (time.hour ?? 0) : 23;
  const minute = hasTime ? (time.minute ?? 0) : 59;
  const second = hasTime ? (time.second ?? 0) : 59;

  // Build as if UTC, then shift by the Hong Kong offset to get the real instant.
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second);
  return new Date(asUtc - HK_OFFSET_MS).toISOString();
}

/**
 * The Hong Kong calendar date (`YYYY-MM-DD`) an instant falls on.
 *
 * Needed because a deadline is stored as the *end* of its day in Hong Kong, which
 * is 15:59:59Z — rendering that instant in UTC would show the correct date, but
 * rendering it with `toISOString()` after any other conversion would not.
 */
export function hongKongDateOf(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms + HK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days from `now` until the Hong Kong calendar day of `iso`. Negative once passed. */
export function daysUntilInHongKong(iso: string, now: Date = new Date()): number | null {
  const target = hongKongDateOf(iso);
  if (!target) return null;
  const today = new Date(now.getTime() + HK_OFFSET_MS).toISOString().slice(0, 10);
  const diff = Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(diff / 86_400_000);
}
