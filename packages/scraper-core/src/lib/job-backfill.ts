import type { RawJob } from '../adapters/adapter.interface.js';

/**
 * Deterministic backfill for fields adapters frequently miss.
 *
 * Why this exists: adapters differ wildly in how much metadata their listing pages
 * expose. Some (Workday-based ones) give almost nothing beyond title + URL; others
 * (Towngas, SHKP) expose deadline and department. Rather than patching twelve
 * adapters one by one, this layer runs between `adapter.scrape()` and
 * `prepareJobsForIngest()` and recovers the common gaps from the title and the
 * detail-page description text, which most adapters DO collect.
 *
 * It runs BEFORE the pipeline because the pipeline deliberately strips
 * `description` at the ingest boundary — once it is gone, the text is unrecoverable.
 *
 * Everything here is pure and deterministic: no network, no LLM. It only ever fills
 * a field that is currently empty, and never overwrites an adapter-provided value.
 */

export type BackfillField =
  | 'location'
  | 'employmentType'
  | 'experienceMin'
  | 'applicationDeadline'
  | 'department';

export interface BackfillStats {
  scanned: number;
  /** Field -> how many jobs this layer filled. */
  filled: Record<BackfillField, number>;
  /** Field -> how many jobs are STILL empty after backfill (adapter quality signal). */
  stillMissing: Record<BackfillField, number>;
  /** Up to 3 example titles per field that could not be filled, for adapter review. */
  samples: Partial<Record<BackfillField, string[]>>;
}

export interface BackfillResult {
  jobs: RawJob[];
  stats: BackfillStats;
}

const DEFAULT_LOCATION = 'Hong Kong';
const MAX_EXPERIENCE_YEARS = 60;

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isBlank(value: unknown): boolean {
  return text(value).length === 0;
}

// ─── experienceMin ────────────────────────────────────────────────────────────

/**
 * Recover a minimum-years-of-experience number.
 *
 * Order matters: an explicit "5+ years" beats a vague "Senior" title hint. We only
 * trust a bare seniority word when nothing numeric is present, and even then we map
 * it to the conservative low end of the band.
 */
export function inferExperienceMin(title: string, description?: string): number | undefined {
  const haystack = `${title}\n${description ?? ''}`;

  const numeric = [
    // "5+ years", "3 - 5 years", "at least 4 years", "minimum of 6 years"
    /(\d{1,2})\s*\+?\s*(?:-|–|to)\s*\d{1,2}\s*\+?\s*years?/i,
    /(?:at least|minimum(?:\s+of)?|min\.?|over|more than)\s*(\d{1,2})\s*\+?\s*years?/i,
    /(\d{1,2})\s*\+?\s*years?\s+(?:of\s+)?(?:relevant\s+|proven\s+|hands[- ]on\s+)?experience/i,
    // "5+ years in/with ..." and "experience of 5 years"
    /experience\s*(?:of|:)?\s*(\d{1,2})\s*\+?\s*years?/i,
    // Chinese: "5年經驗", "3 年以上經驗", "具備5年相關經驗"
    /(\d{1,2})\s*年(?:或以[上])?\s*(?:相關|工作|行業)?\s*經驗/,
  ];

  for (const pattern of numeric) {
    const match = haystack.match(pattern);
    const raw = match?.[1];
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0 || value > MAX_EXPERIENCE_YEARS) continue;
    return value;
  }

  // Fall back to seniority words, using the low end of each band.
  const t = title.toLowerCase();
  if (/\b(intern|internship|trainee|graduate)\b/.test(t)) return 0;
  if (/\b(entry[- ]level|junior)\b/.test(t)) return 0;
  if (/\b(senior|sr\.?)\b/.test(t)) return 5;
  if (/\b(lead|principal|staff)\b/.test(t)) return 6;
  if (/\b(director|head of|vp|vice president|chief)\b/.test(t)) return 8;
  return undefined;
}

// ─── applicationDeadline ──────────────────────────────────────────────────────

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

function toIso(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return undefined;
  // Guard against nonsense years in scraped marketing copy.
  const thisYear = new Date().getUTCFullYear();
  if (year < thisYear - 1 || year > thisYear + 3) return undefined;
  return date.toISOString();
}

/**
 * Recover an application deadline from free text.
 *
 * Requires an explicit deadline cue ("closing date", "apply by", "截止日期") so we do
 * not mistake a posting date or an unrelated number for a deadline.
 */
export function inferApplicationDeadline(description?: string, extraText?: string): string | undefined {
  const haystack = `${extraText ?? ''}\n${description ?? ''}`;
  if (!haystack.trim()) return undefined;

  const cue = String.raw`(?:application\s+deadline|closing\s+date|close\s+date|apply\s+(?:by|before)|applications?\s+close|deadline|截止日期|申請截止|截止申請)`;

  // "Closing date: 31 October 2026" / "Deadline 2026-10-31"
  const patterns: Array<{ re: RegExp; build: (m: RegExpMatchArray) => string | undefined }> = [
    {
      // 2026-10-31 or 2026/10/31
      re: new RegExp(`${cue}\\s*[:：]?\\s*(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})`, 'i'),
      build: (m) => toIso(Number(m[1]), Number(m[2]), Number(m[3])),
    },
    {
      // 31/10/2026 (day first — HK/UK convention)
      re: new RegExp(`${cue}\\s*[:：]?\\s*(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})`, 'i'),
      build: (m) => toIso(Number(m[3]), Number(m[2]), Number(m[1])),
    },
    {
      // 31 October 2026 / 31 Oct, 2026
      re: new RegExp(`${cue}\\s*[:：]?\\s*(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+([A-Za-z]{3,9})\\.?,?\\s*(\\d{4})`, 'i'),
      build: (m) => {
        const month = MONTHS[(m[2] ?? '').toLowerCase()];
        return month ? toIso(Number(m[3]), month, Number(m[1])) : undefined;
      },
    },
    {
      // October 31, 2026
      re: new RegExp(`${cue}\\s*[:：]?\\s*([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})`, 'i'),
      build: (m) => {
        const month = MONTHS[(m[1] ?? '').toLowerCase()];
        return month ? toIso(Number(m[3]), month, Number(m[2])) : undefined;
      },
    },
    {
      // Chinese: 2026年10月31日
      re: new RegExp(`${cue}\\s*[:：]?\\s*(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日`),
      build: (m) => toIso(Number(m[1]), Number(m[2]), Number(m[3])),
    },
  ];

  for (const { re, build } of patterns) {
    const match = haystack.match(re);
    if (!match) continue;
    const iso = build(match);
    if (iso) return iso;
  }

  return undefined;
}

// ─── department ───────────────────────────────────────────────────────────────

const DEPARTMENT_RULES: Array<{ department: string; re: RegExp }> = [
  { department: 'Engineering', re: /\b(software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|engineer|developer|devops|sre|platform|infrastructure|architect|programmer)\b/i },
  { department: 'Data & Analytics', re: /\b(data\s+(?:scientist|analyst|engineer|architect)|machine\s+learning|ml\s+engineer|analytics|business\s+intelligence|bi\s+(?:analyst|developer)|business\s+analyst)\b/i },
  { department: 'Product', re: /\b(product\s+(?:manager|owner|management|designer)|programme?\s+manager)\b/i },
  { department: 'Design', re: /\b(ux|ui|user\s+experience|graphic\s+design|visual\s+design|designer)\b/i },
  { department: 'Finance & Accounting', re: /\b(finance|financial|accounting|accountant|audit|treasury|fp&a|tax|actuar(?:y|ial))\b/i },
  { department: 'Risk & Compliance', re: /\b(risk|compliance|aml|anti[- ]money\s+laundering|kyc|internal\s+audit|governance)\b/i },
  { department: 'Legal', re: /\b(legal|counsel|lawyer|solicitor|paralegal|contracts?\s+manager)\b/i },
  { department: 'Human Resources', re: /\b(human\s+resources|hr\b|talent\s+acquisition|recruit(?:er|ment)|people\s+(?:partner|operations)|learning\s+and\s+development|c&b)\b/i },
  { department: 'Marketing & Communications', re: /\b(marketing|brand|communications?|public\s+relations|content|seo|social\s+media|growth)\b/i },
  { department: 'Sales & Business Development', re: /\b(sales|account\s+(?:executive|manager)|business\s+development|relationship\s+manager|partnerships?|broker)\b/i },
  { department: 'Customer Service', re: /\b(customer\s+(?:service|support|success|experience)|contact\s+cent(?:re|er)|call\s+cent(?:re|er)|service\s+desk|helpdesk)\b/i },
  { department: 'Operations', re: /\b(operations|operational|supply\s+chain|logistics|procurement|sourcing|warehouse|manufacturing|production|maintenance)\b/i },
  { department: 'Flight Operations', re: /\b(cabin\s+crew|flight\s+attendant|pilot|first\s+officer|captain|crew\s+scheduling|flight\s+operations|inflight)\b/i },
  { department: 'Ground & Airport Services', re: /\b(airport|ground\s+(?:handling|services|operations)|ramp|cargo\s+operations|load\s+control)\b/i },
  { department: 'Engineering & Maintenance', re: /\b(aircraft\s+maintenance|technical\s+services|line\s+maintenance|component\s+repair|engineering\s+maintenance)\b/i },
  { department: 'Property & Facilities', re: /\b(property|estate|facilit(?:y|ies)\s+management|leasing|building\s+services|surveyor)\b/i },
  { department: 'Information Technology', re: /\b(information\s+technology|it\s+(?:support|officer|specialist|manager)|network\s+engineer|system\s+administrator|cyber\s*security|infosec)\b/i },
  { department: 'Project Management', re: /\b(project\s+manager|project\s+management|pmo|construction\s+manager)\b/i },
];

export function inferDepartment(title: string, metadataDepartment?: string | null): string | undefined {
  const existing = text(metadataDepartment);
  if (existing) return existing.slice(0, 180);
  for (const { department, re } of DEPARTMENT_RULES) {
    if (re.test(title)) return department;
  }
  return undefined;
}

// ─── employmentType ───────────────────────────────────────────────────────────

/**
 * Recover an employment-type label from the posting text.
 *
 * Adapters rarely expose a structured employment type, so this reads the detail
 * description instead. Order is most-specific-first: an internship that happens to
 * mention "full time" must still come out as Internship, and a contract role that
 * says "full-time hours" must still come out as Contract.
 *
 * The returned label is a raw human label; `normalizeJobEmploymentType` in the
 * pipeline maps it onto the PERMANENT / CONTRACT / INTERNSHIP taxonomy.
 */
export function inferEmploymentTypeLabel(
  title: string,
  description?: string,
  extraText?: string,
): string | undefined {
  const haystack = `${title}\n${extraText ?? ''}\n${description ?? ''}`;
  if (!haystack.trim()) return undefined;

  if (/\b(intern|internship|trainee|placement|summer\s+analyst)\b/i.test(haystack) || /實習生?|見習/.test(haystack)) {
    return 'Internship';
  }
  if (
    /\b(fixed[\s-]?term|contract(?:or)?|temporary|temp\b|locum|secondment|maternity\s+cover)\b/i.test(haystack) ||
    /合約|短期|臨時/.test(haystack)
  ) {
    return 'Contract';
  }
  if (/\b(permanent|full[\s-]?time|regular\s+staff)\b/i.test(haystack) || /全職|長期/.test(haystack)) {
    return 'Permanent';
  }
  return undefined;
}

// ─── main entry ───────────────────────────────────────────────────────────────

function blankStats(): Record<BackfillField, number> {
  return {
    location: 0,
    employmentType: 0,
    experienceMin: 0,
    applicationDeadline: 0,
    department: 0,
  };
}

/**
 * Fill common gaps on raw adapter output. Never overwrites a value an adapter set.
 *
 * `locationFallback` should be the target's default region label (usually
 * "Hong Kong"); it is only applied when the adapter produced nothing at all.
 */
export function backfillRawJobs(
  jobs: RawJob[],
  options: { locationFallback?: string } = {},
): BackfillResult {
  const locationFallback = options.locationFallback ?? DEFAULT_LOCATION;
  const filled = blankStats();
  const stillMissing = blankStats();
  const samples: Partial<Record<BackfillField, string[]>> = {};

  const out = jobs.map((job) => {
    const next: RawJob = { ...job };
    const title = text(job.title);
    const description = text(job.description);
    const metadata = (job.topMetadata ?? {}) as Record<string, unknown>;

    // location
    if (isBlank(next.location)) {
      next.location = locationFallback;
      filled.location += 1;
    }

    // department — adapter field first, then topMetadata, then title inference
    if (isBlank(next.department)) {
      const inferred = inferDepartment(title, typeof metadata.department === 'string' ? metadata.department : null);
      if (inferred) {
        next.department = inferred;
        filled.department += 1;
      }
    }

    // experienceMin
    if (typeof next.experienceMin !== 'number') {
      const inferred = inferExperienceMin(title, description);
      if (inferred !== undefined) {
        next.experienceMin = inferred;
        filled.experienceMin += 1;
      }
    }

    // applicationDeadline
    if (isBlank(next.applicationDeadline)) {
      const inferred = inferApplicationDeadline(
        description,
        [metadata.deadline, metadata.applicationDeadline]
          .filter((value): value is string => typeof value === 'string')
          .join('\n'),
      );
      if (inferred) {
        next.applicationDeadline = inferred;
        filled.applicationDeadline += 1;
      }
    }

    // employmentType — adapters rarely expose this at all, so fall back to the
    // raw label, then to reading the detail description text.
    if (isBlank(next.employmentType)) {
      const label =
        text(next.rawEmploymentType) ||
        text(metadata.employmentType) ||
        text(metadata.contractType) ||
        inferEmploymentTypeLabel(title, description);
      if (label) {
        next.employmentType = label;
        if (isBlank(next.rawEmploymentType)) next.rawEmploymentType = label;
        filled.employmentType += 1;
      }
    }

    // Record what is still empty, with a few samples for adapter review.
    const check: Array<[BackfillField, boolean]> = [
      ['location', isBlank(next.location)],
      ['department', isBlank(next.department)],
      ['experienceMin', typeof next.experienceMin !== 'number'],
      ['applicationDeadline', isBlank(next.applicationDeadline)],
      ['employmentType', isBlank(next.employmentType)],
    ];
    for (const [field, missing] of check) {
      if (!missing) continue;
      stillMissing[field] += 1;
      const bucket = (samples[field] ??= []);
      if (bucket.length < 3 && title) bucket.push(title.slice(0, 80));
    }

    return next;
  });

  return { jobs: out, stats: { scanned: jobs.length, filled, stillMissing, samples } };
}
