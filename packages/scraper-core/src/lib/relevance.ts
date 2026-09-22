/**
 * Deterministic job-relevance ("契合度") scoring.
 *
 * The problem this solves: a company careers site does not only list jobs you could
 * do. Cathay Pacific's board carries cabin crew, lounge ambassadors and cargo
 * supervisors alongside its IT roles; a bank carries branch tellers alongside its
 * analysts. Without a filter the app's new-job list is mostly noise.
 *
 * ## The profile this measures against
 *
 * Three role targets, at 2-3 years of experience:
 *
 *   - Data Analyst          -> `DATA`
 *   - Business Analyst      -> `BUSINESS_ANALYST`
 *   - Software Engineering  -> `TECH`
 *
 * Those three families sit at the top of `FAMILY_WEIGHT` and are the only ones
 * `TARGET_FAMILIES` names. Everything else is graded relative to them: adjacent
 * work (product, finance, risk) stays visible but ranks lower, and families that
 * are almost never a fit (service, aviation ops) fall below the display threshold.
 * `TARGET_YOE_MIN` / `TARGET_YOE_MAX` are what the years-of-experience adjustment
 * is measured against, so "requires 8+ years" is penalised and "requires 2-3" is
 * rewarded.
 *
 * Two design decisions worth stating up front:
 *
 * 1. **This produces a 0-100 score, not a boolean.** The display threshold lives in
 *    the app so it can be tuned per user without re-scraping the whole backlog. The
 *    scraper's only job is to measure.
 *
 * 2. **Nothing is ever dropped.** A job that scores 0 is still written to the
 *    database with the reason attached. Silently discarding rows is how you lose
 *    the one posting you would actually have wanted, and it makes the rules
 *    impossible to debug after the fact.
 *
 * Matching runs against the TITLE (and department) only — never the description.
 * That is deliberate: adapter descriptions are frequently polluted with
 * page-level text (see the Cathay DOM fallback), so a description match would
 * score every job on the page identically.
 *
 * **No resume and no personal profile is ever involved.** The score is a pure
 * function of the posting's title, department, seniority and stated minimum years
 * of experience. That keeps it reproducible, free, and debuggable — and keeps the
 * user's CV out of any third-party model.
 */

export type RoleFamily =
  | 'BUSINESS_ANALYST'
  | 'DATA'
  | 'TECH'
  | 'IT_INFRA'
  | 'PRODUCT'
  | 'DESIGN'
  | 'FINANCE'
  | 'RISK_COMPLIANCE'
  | 'LEGAL'
  | 'HR'
  | 'MARKETING'
  | 'SALES'
  | 'CUSTOMER_SERVICE'
  | 'OPERATIONS'
  | 'AVIATION_OPS'
  | 'SERVICE'
  | 'OTHER';

/** The three role targets the score is optimised for. */
export const TARGET_FAMILIES: readonly RoleFamily[] = ['BUSINESS_ANALYST', 'DATA', 'TECH'];

/** The experience band the years-of-experience adjustment is measured against. */
export const TARGET_YOE_MIN = 2;
export const TARGET_YOE_MAX = 3;

/**
 * How much each family moves the score away from the neutral 50.
 *
 * Positive: families that match a data-analyst / business-analyst / software-
 * engineering profile. Negative: families that are almost never a fit, without
 * being an outright blocklist hit — a "Cargo Operations Manager" is a real
 * white-collar job, it just is not the job being looked for.
 */
const FAMILY_WEIGHT: Record<RoleFamily, number> = {
  BUSINESS_ANALYST: 38,
  DATA: 38,
  TECH: 35,
  PRODUCT: 20,
  FINANCE: 12,
  RISK_COMPLIANCE: 12,
  IT_INFRA: 5,
  DESIGN: 8,
  LEGAL: 0,
  HR: 0,
  MARKETING: 0,
  SALES: 0,
  OTHER: 0,
  OPERATIONS: -10,
  CUSTOMER_SERVICE: -25,
  AVIATION_OPS: -35,
  SERVICE: -45,
};

/**
 * Ordered most-specific-first. First match wins.
 *
 * Three ordering constraints are load-bearing:
 *   - `AVIATION_OPS` must precede `TECH`, or "Licensed Aircraft Engineer" reads as
 *     a software role because of the word "engineer".
 *   - `BUSINESS_ANALYST` and `DATA` must precede `AVIATION_OPS`, or a "Cargo Data
 *     Analyst" is written off as a cargo job. The two rules are narrow enough that
 *     this is safe: neither matches "Cargo Supervisor" or "Lounge Ambassador".
 *   - `TECH` must precede `IT_INFRA`, so "Security Assurance" lands on the
 *     engineering side while a bare "IT Support Officer" does not.
 */
const FAMILY_RULES: Array<{ family: RoleFamily; re: RegExp }> = [
  {
    family: 'BUSINESS_ANALYST',
    re: /\b(business\s+analyst|business\s+analysis|systems?\s+analyst|functional\s+analyst|process\s+analyst|requirements\s+analyst|business\s+(?:systems|process)\s+(?:analyst|specialist|manager|lead))\b/i,
  },
  {
    family: 'DATA',
    re: /\b(data\s+(?:scientist|science|analyst|analytics|engineer|engineering|architect|governance|quality|management|pipeline|warehouse|lake|integration)|machine\s+learning|ml\s+(?:engineer|ops)|artificial\s+intelligence|generative\s+ai|gen\s?ai|\bai\b|analytics|business\s+intelligence|bi\s+(?:analyst|developer|specialist)|statistic(?:s|ian)|quantitative|actuar(?:y|ial)|econometric|insight\s+analyst|reporting\s+analyst)\b/i,
  },
  {
    family: 'AVIATION_OPS',
    // `cargo` deliberately requires an operational context. Bare `cargo` also
    // appears in insurance and trade-finance product names — AXA publishes
    // "Underwriter, Marine Cargo", which is a finance role, not an airport one.
    re: /\b(cabin\s+crew|flight\s+attendant|steward(?:ess)?|purser|pilot|first\s+officer|second\s+officer|flight\s+operations|inflight|in-flight|crew\s+(?:scheduling|control|roster)|airport|ground\s+(?:handling|services|operations|staff)|ramp\b|baggage|load\s+control|cargo\s+(?:operations?|operational|supervisor|handler|agent|distribution|terminal|services?|scheduling|control|loading|warehouse|import|export)|air\s+cargo|aircraft\s+(?:maintenance|engineer|technician)|line\s+maintenance|avionics|dispatch(?:er)?|aog\b|hangar|lounge\b|duty\s+free|catering\s+operations|dining\s+transformation)/i,
  },
  {
    family: 'TECH',
    re: /\b(software|backend|back-end|frontend|front-end|full[- ]?stack|web\s+develop|application\s+develop|mobile\s+develop|devops|dev\s?ops|sre\b|site\s+reliability|platform\s+(?:engineer|architect|lead|owner|manager)|cloud\s+(?:engineer|architect|platform)|solution\s+lead|(?:solution|system|enterprise|functional|technical|application|integration|platform|cloud|security|data)\s+architect|data\s+engineer|database\s+administrator|dba\b|cyber\s*security|infosec|information\s+security|security\s+(?:assurance|engineer|architect)|penetration\s+test|ethical\s+hack|agile\s+(?:coach|transformation|lead)|scrum\s+master|technical\s+(?:lead|programme|manager|architect|analyst)|software\s+engineer|qa\s+(?:engineer|analyst|lead)|test\s+(?:engineer|automation)|programmer|developer|engineering\s+manager|digital\s+(?:transformation|product|platform|innovation|lead))\b/i,
  },
  {
    family: 'PRODUCT',
    re: /\b(product\s+(?:manager|owner|management|lead|specialist|designer|officer|executive|analyst)|programme?\s+manager|program\s+manager|pmo\b|project\s+(?:manager|management|lead|executive|officer|coordinator)|portfolio\s+manager|delivery\s+(?:manager|lead))\b/i,
  },
  {
    family: 'DESIGN',
    re: /\b(ux\b|ui\b|user\s+experience|user\s+interface|interaction\s+design|graphic\s+design|visual\s+design|product\s+design|service\s+design|design\s+(?:lead|manager|specialist|system)|creative\s+(?:director|designer))\b/i,
  },
  {
    family: 'RISK_COMPLIANCE',
    re: /\b(risk|compliance|aml\b|anti[- ]money\s+laundering|kyc\b|sanctions|internal\s+(?:audit|control)|governance|regulatory|assurance\s+(?:manager|lead|specialist)|fraud\s+(?:analyst|prevention|investigator)|business\s+continuity)\b/i,
  },
  {
    family: 'FINANCE',
    re: /\b(finance|financial|accounting|accountant|audit(?:or|ing)?|treasury|fp&a|tax\b|taxation|credit\s+(?:analyst|control|risk)|investment|fund\s+(?:manager|accountant)|portfolio\s+(?:analyst|manager)|equity\s+research|pricing\s+(?:analyst|manager|strategy)|revenue\s+(?:management|analyst|accounting)|cost\s+(?:controller|analyst)|budget|commercial\s+finance|financial\s+(?:planning|analysis|controller))\b/i,
  },
  {
    family: 'LEGAL',
    re: /\b(legal|counsel|lawyer|solicitor|barrister|paralegal|litigation|contracts?\s+(?:manager|specialist|administrator)|intellectual\s+property|company\s+secretary)\b/i,
  },
  {
    family: 'HR',
    re: /\b(human\s+resources|\bhr\b|talent\s+(?:acquisition|management|development)|recruit(?:er|ment|ing)|people\s+(?:partner|operations|analytics|team)|learning\s+and\s+development|l&d\b|compensation\s+and\s+benefits|c&b\b|payroll|hris|employee\s+(?:relations|engagement|experience)|organisational\s+development|organizational\s+development)\b/i,
  },
  {
    family: 'MARKETING',
    re: /\b(marketing|brand\b|branding|communications?|public\s+relations|\bpr\b|content\s+(?:manager|strategist|specialist|marketer)|seo\b|sem\b|social\s+media|growth\s+(?:manager|hacker|marketer)|copywriter|digital\s+marketing|campaign\s+manager|crm\s+(?:manager|specialist|analyst))\b/i,
  },
  {
    family: 'SALES',
    re: /\b(sales|account\s+(?:executive|manager|director|specialist)|business\s+development|biz\s?dev|relationship\s+(?:manager|director)|partnerships?|broker(?:age)?|commercial\s+(?:manager|director|executive)|distribution\s+(?:manager|lead)|channel\s+(?:manager|partner)|key\s+account|territory\s+manager|revenue\s+(?:manager|director)|tender\s+(?:manager|specialist))\b/i,
  },
  {
    family: 'CUSTOMER_SERVICE',
    re: /\b(customer\s+(?:service|support|success|experience|care|relations)|contact\s+cent(?:re|er)|call\s+cent(?:re|er)|service\s+desk|help\s?desk|guest\s+(?:services|relations|experience)|front\s+(?:desk|office)|receptionist|client\s+services?)\b/i,
  },
  {
    family: 'IT_INFRA',
    re: /\b(information\s+technology|\bit\s+(?:security|audit|support|officer|specialist|manager|engineer|architect|analyst)|network\s+(?:engineer|architect|specialist)|system\s+administrator|sysadmin|infrastructure|technical\s+support|desktop\s+support|end\s+user\s+computing)\b/i,
  },
  {
    family: 'OPERATIONS',
    re: /\b(operations?|operational|supply\s+chain|logistics|procurement|sourcing|purchasing|warehouse|inventory|manufacturing|production|maintenance|planning|scheduling|quality\s+(?:assurance|control|manager)|health\s+and\s+safety|\behs\b|facilit(?:y|ies)\s+management|administration|administrative|back\s+office|shared\s+services|process\s+(?:improvement|excellence)|lean\b|six\s+sigma)\b/i,
  },
];

/**
 * Hard blocklist: roles that are not a fit at any seniority, so they score 0.
 *
 * Every pattern is anchored on the TITLE. Two traps this avoids:
 *   - `\bserver\b` would kill "Server Engineer" and `\bhost\b` would kill "Hosting",
 *     so neither bare word appears here.
 *   - `\bofficer\b` alone would kill "Compliance Officer", so it only appears as
 *     part of "security officer".
 */
const BLOCKLIST: Array<{ label: string; re: RegExp }> = [
  { label: 'cabin-crew', re: /\b(cabin\s+crew|flight\s+attendant|steward|stewardess|purser)\b/i },
  { label: 'bar', re: /\b(bartender|bar\s+tender|barista|mixologist|bar\s+supervisor)\b/i },
  { label: 'restaurant-service', re: /\b(waiter|waitress|waitstaff|food\s+runner|commis|sous\s+chef|pastry\s+chef|chef|cook|kitchen\s+(?:helper|porter|assistant)|dishwasher|butcher|baker)\b/i },
  { label: 'cleaning', re: /\b(cleaner|cleaning|housekeep(?:ing|er)|room\s+attendant|laundry|janitor|sanitation|waste\s+collector|dish\s+collector)\b/i },
  { label: 'driving', re: /\b(driver|chauffeur|delivery\s+(?:rider|courier|driver)|courier|motorcycle\s+delivery|van\s+driver|truck\s+driver|forklift)\b/i },
  { label: 'security-guard', re: /\b(security\s+(?:guard|officer|supervisor|attendant)|night\s+guard|doorman|door\s+attendant|concierge|bell\s?(?:boy|attendant|hop)|valet|porter)\b/i },
  { label: 'warehouse-manual', re: /\b(packer|packing|stockroom|stock\s+(?:keeper|taker)|material\s+handler|loader|unloader|warehouse\s+(?:assistant|attendant|worker)|picker)\b/i },
  { label: 'retail', re: /\b(cashier|retail\s+(?:assistant|associate|sales|staff)|sales\s+(?:assistant|associate|advisor)|shop\s+assistant|store\s+(?:assistant|keeper|attendant)|promoter|brand\s+ambassador)\b/i },
  { label: 'beauty-wellness', re: /\b(beauty\s+(?:advisor|consultant|therapist)|beautician|masseur|masseuse|massage\s+therapist|hairdresser|hairstylist|barber|nail\s+technician|fitness\s+instructor|personal\s+trainer|lifeguard|spa\s+(?:attendant|therapist))\b/i },
  { label: 'telemarketing', re: /\b(telemarketer|telesales|cold\s+caller|call\s+centre\s+agent|call\s+center\s+agent)\b/i },
  { label: 'ground-crew', re: /\b(baggage\s+handler|ramp\s+agent|ground\s+crew|aircraft\s+cleaner|catering\s+attendant|line\s+service\s+technician)\b/i },
  // Chinese-language titles, which are common on HK boards.
  { label: 'service-zh', re: /(空姐|空少|機艙服務員|侍應|服務員|調酒師|廚師|清潔|洗碗|保安|司機|收銀|派遞|美容師|按摩師|理髮)/ },
];

export interface RelevanceInput {
  title: string;
  department?: string | null | undefined;
  /** Job-level code from the LLM layer or the standardizer, when known. */
  seniority?: string | null | undefined;
  /** Minimum years of experience, when known. */
  yoeMin?: number | null | undefined;
}

export interface RelevanceResult {
  /** 0-100. Higher is a better fit for the target profile above. */
  score: number;
  family: RoleFamily;
  /** Why the score is what it is. `null` when nothing moved the score. */
  reason: string | null;
}

/** Neutral starting point before family, seniority and YOE adjustments. */
const BASE_SCORE = 50;

/** Below this, the app hides a job unless the user asks to see filtered results. */
export const DEFAULT_MIN_RELEVANCE = 35;

/**
 * Seniority adjustment, tuned for someone with 2-3 years of experience.
 *
 * The positive entries are not a typo: a `MID` posting is a better target than an
 * unlabelled one, and a `JUNIOR` one is still in range. The negatives are what
 * matter — a `LEAD` or `MANAGER` posting is a stretch, and `INTERN` is the wrong
 * stage of career entirely, which is why it is penalised rather than rewarded.
 */
const SENIORITY_DELTA: Record<string, number> = {
  INTERN: -15,
  ENTRY: -6,
  JUNIOR: 4,
  MID: 8,
  SENIOR: -10,
  LEAD: -18,
  MANAGER: -12,
  DIRECTOR: -28,
  EXECUTIVE: -35,
};

/**
 * Years-of-experience adjustment around the 2-3 year target band.
 *
 * A posting asking for less than you have is not a problem (you clear the bar), so
 * `<2` is mildly positive rather than negative. Everything above the band is
 * penalised by distance, and 13+ is severe enough to push even a perfect family
 * match below the display threshold.
 */
function yoeAdjustment(yoeMin: number): { delta: number; label: string } {
  if (yoeMin < TARGET_YOE_MIN) return { delta: 5, label: 'yoe<2' };
  if (yoeMin <= TARGET_YOE_MAX) return { delta: 8, label: 'yoe-in-band' };
  if (yoeMin <= 5) return { delta: -8, label: 'yoe-4-5' };
  if (yoeMin <= 8) return { delta: -20, label: 'yoe-6-8' };
  if (yoeMin <= 12) return { delta: -38, label: 'yoe-9-12' };
  return { delta: -60, label: 'yoe-13plus' };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Strip parenthetical qualifiers from a title.
 *
 * Careers sites put the employer, the location or the contract length in brackets
 * after the actual role: "Senior Solution Lead – Subsidiaries (Cathay Cargo
 * Terminal)", "Assistant Manager, Innovation (HK & GBA)", "… (36-month Contract)".
 * Matching on the raw title lets that qualifier hijack the classification — the
 * Solution Lead above reads as a cargo job because of "(Cathay Cargo Terminal)".
 */
function stripQualifiers(title: string): string {
  return title.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/** First matching family wins; `OTHER` when nothing matches. */
export function roleFamilyOf(title: string, department?: string | null | undefined): RoleFamily {
  const haystack = `${text(title)}\n${text(department)}`;
  if (!haystack.trim()) return 'OTHER';

  const titleOnly = text(title);
  const core = stripQualifiers(titleOnly) || titleOnly;

  // Three passes, most trustworthy first. The title outranks the department,
  // because a job's own title describes the job while a department name often
  // describes the org chart it sits in — "Cargo Supervisor" inside "Digital &
  // Information Technology" is still a cargo role.
  for (const { family, re } of FAMILY_RULES) {
    if (re.test(core)) return family;
  }
  for (const { family, re } of FAMILY_RULES) {
    if (re.test(titleOnly)) return family;
  }
  for (const { family, re } of FAMILY_RULES) {
    if (re.test(haystack)) return family;
  }
  return 'OTHER';
}

/** The first blocklist label the title matches, or `null`. */
export function blocklistHit(title: string): string | null {
  const t = text(title);
  if (!t) return null;
  for (const { label, re } of BLOCKLIST) {
    if (re.test(t)) return label;
  }
  return null;
}

/**
 * Score a job's relevance.
 *
 * The score is a sum of independent adjustments from a neutral base, then clamped.
 * A blocklist hit short-circuits to 0 — it is a categorical "not this kind of job",
 * not a matter of degree.
 */
export function scoreRelevance(input: RelevanceInput): RelevanceResult {
  const title = text(input.title);
  if (!title) return { score: 0, family: 'OTHER', reason: 'empty-title' };

  const hit = blocklistHit(title);
  if (hit) {
    return { score: 0, family: 'SERVICE', reason: `blocklist:${hit}` };
  }

  const family = roleFamilyOf(title, input.department);
  let score = BASE_SCORE + FAMILY_WEIGHT[family];
  const reasons: string[] = [`family:${family}`];

  const seniority = text(input.seniority).toUpperCase();
  const seniorityDelta = SENIORITY_DELTA[seniority];
  if (seniorityDelta !== undefined) {
    score += seniorityDelta;
    reasons.push(`seniority:${seniority}`);
  }

  const yoe = input.yoeMin;
  if (typeof yoe === 'number' && Number.isFinite(yoe)) {
    const adjustment = yoeAdjustment(yoe);
    score += adjustment.delta;
    reasons.push(adjustment.label);
  }

  const clamped = Math.max(0, Math.min(100, score));
  // Only report a reason when something actually moved the score off neutral.
  const reason = reasons.length === 1 && family === 'OTHER' ? null : reasons.join(',');
  return { score: clamped, family, reason };
}

/** Human-readable band, for the app badge. */
export function relevanceBand(score: number): 'high' | 'medium' | 'low' | 'filtered' {
  if (score >= 70) return 'high';
  if (score >= DEFAULT_MIN_RELEVANCE) return 'medium';
  if (score > 0) return 'low';
  return 'filtered';
}
