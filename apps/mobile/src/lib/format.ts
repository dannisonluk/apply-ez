/**
 * Display formatting.
 *
 * Deadlines are anchored to Hong Kong time because that is what the scraper
 * stores (see `packages/scraper-core/src/lib/hk-time.ts`). The device may be in
 * any timezone, so a deadline must be rendered by shifting to UTC+8 rather than
 * by using the device's local getters — otherwise a user travelling overseas
 * would see deadline dates move.
 */

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
const MS_PER_DAY = 86_400_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` for the Hong Kong calendar day an instant falls on. */
export function hongKongDateOf(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + HK_OFFSET_MS).toISOString().slice(0, 10);
}

function todayInHongKong(now: Date): string {
  return new Date(now.getTime() + HK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days from today until the Hong Kong day of `iso`. Negative once passed. */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  const target = hongKongDateOf(iso);
  if (!target) return null;
  const today = todayInHongKong(now);
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = hongKongDateOf(iso);
  if (!date) return null;
  const [year, month, day] = date.split('-');
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName || !day || !year) return null;
  return `${Number(day)} ${monthName} ${year}`;
}

export type DeadlineTone = 'passed' | 'urgent' | 'soon' | 'open' | 'unknown';

export interface DeadlineInfo {
  /** Formatted Hong Kong date, e.g. "31 Oct 2026". */
  date: string | null;
  days: number | null;
  tone: DeadlineTone;
  /** Short human label, e.g. "Closes in 3 days". */
  label: string;
}

export function deadlineInfo(iso: string | null, now: Date = new Date()): DeadlineInfo {
  if (!iso) return { date: null, days: null, tone: 'unknown', label: '' };

  const date = formatDate(iso);
  const days = daysUntil(iso, now);
  if (days === null) return { date, days: null, tone: 'unknown', label: '' };

  if (days < 0) {
    return { date, days, tone: 'passed', label: days === -1 ? 'Closed yesterday' : `Closed ${-days} days ago` };
  }
  if (days === 0) return { date, days, tone: 'urgent', label: 'Closes today' };
  if (days === 1) return { date, days, tone: 'urgent', label: 'Closes tomorrow' };
  if (days <= 3) return { date, days, tone: 'urgent', label: `Closes in ${days} days` };
  if (days <= 10) return { date, days, tone: 'soon', label: `Closes in ${days} days` };
  return { date, days, tone: 'open', label: `Closes in ${days} days` };
}

/** Compact "time since" for the new-job list. */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';

  const seconds = Math.round((now.getTime() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * Years of experience.
 *
 * Prefers the LLM's range when present, falls back to the deterministic
 * `experience_min`, and returns null rather than inventing "0-1 years" when
 * nothing is known.
 */
export function formatYoe(
  yoeMin: number | null,
  yoeMax: number | null,
  experienceMin: number | null,
): string | null {
  if (yoeMin !== null && yoeMax !== null) {
    return yoeMin === yoeMax ? `${yoeMin} yrs` : `${yoeMin}-${yoeMax} yrs`;
  }
  if (yoeMin !== null) return `${yoeMin}+ yrs`;
  if (experienceMin !== null) return `${experienceMin}+ yrs`;
  return null;
}

export function formatSalary(
  salary: { min: number | null; max: number | null; currency: string } | null,
): string | null {
  if (!salary) return null;
  const { min, max, currency } = salary;
  const fmt = (value: number) =>
    value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  if (min !== null && max !== null) {
    return min === max ? `${currency} ${fmt(min)}` : `${currency} ${fmt(min)}-${fmt(max)}`;
  }
  if (min !== null) return `${currency} ${fmt(min)}+`;
  if (max !== null) return `up to ${currency} ${fmt(max)}`;
  return null;
}

const EMPLOYMENT_LABELS: Record<string, string> = {
  PERMANENT: 'Permanent',
  CONTRACT: 'Contract',
  INTERNSHIP: 'Internship',
};

export function formatEmploymentType(value: string | null): string | null {
  if (!value) return null;
  return EMPLOYMENT_LABELS[value.toUpperCase()] ?? value;
}

const ARRANGEMENT_LABELS: Record<string, string> = {
  ONSITE: 'On-site',
  HYBRID: 'Hybrid',
  REMOTE: 'Remote',
  UNKNOWN: 'Not stated',
};

export function formatWorkArrangement(value: string | null): string | null {
  if (!value) return null;
  return ARRANGEMENT_LABELS[value.toUpperCase()] ?? value;
}

const SENIORITY_LABELS: Record<string, string> = {
  INTERN: 'Intern',
  ENTRY: 'Entry level',
  JUNIOR: 'Junior',
  MID: 'Mid level',
  SENIOR: 'Senior',
  LEAD: 'Lead',
  MANAGER: 'Manager',
  DIRECTOR: 'Director',
  EXECUTIVE: 'Executive',
};

export function formatSeniority(value: string | null): string | null {
  if (!value) return null;
  return SENIORITY_LABELS[value.toUpperCase()] ?? value;
}

/** "Assistant Marketing Manager / Senior Marketing Officer" -> "Assistant Marketing Manager" */
export function shortTitle(title: string, max = 64): string {
  const primary = title.split(/\s*[/|]\s*/)[0]?.trim() ?? title;
  return primary.length <= max ? primary : `${primary.slice(0, max - 1)}…`;
}
