/**
 * Hong Kong scope.
 *
 * Every target in `targets.ts` is already HK-scoped at the source — Workday's
 * `locationCountry`, Phenom's `location=Hong Kong`, Eightfold's
 * `filter_country=Hong Kong`, PageUp's `location=Hong Kong SAR`. The source
 * filters still leak, and the leak is not something a target-level tweak can fix,
 * because it comes from the listing API's own filtering: a live crawl of 746
 * postings contained 6 that were not in Hong Kong — two "Singapore", one
 * "Manulife Tower, Manulife (Singapore) Pte Ltd", and three "华东" from SHKP's
 * Shanghai roles.
 *
 * The rule is deliberately a DENYLIST rather than an allowlist:
 *
 *     out of scope  ==  names somewhere outside Hong Kong
 *                       AND does not name Hong Kong
 *
 * An allowlist ("must mention Hong Kong") is the obvious implementation and the
 * wrong one: it drops legitimate postings whose location is an office name with
 * no city in it. "Manulife Tower" is a Kwun Tong address and would be lost.
 *
 * A denylist errs the other way. An unrecognised overseas location still leaks —
 * which is visible, countable, and cheap to fix by adding a pattern — instead of
 * silently deleting a job the user wanted, which is neither.
 */

/** Any of these means the posting is in Hong Kong, whatever else the string says. */
const HONG_KONG =
  /hong\s*kong|hongkong|\bhk\b|kowloon|new territories|香港|九龍|九龙|新界|港島|港岛/i;

/**
 * Places these twelve employers also hire in.
 *
 * Matched case-insensitively, and only consulted when `HONG_KONG` did not match.
 * "Hong Kong, HK-AIA Hong Kong & Macau" contains "Macau" and is kept, because it
 * names Hong Kong; "Manulife Tower, Manulife (Singapore) Pte Ltd" does not, and is
 * dropped.
 */
const ELSEWHERE: readonly RegExp[] = [
  /\bsingapore\b/i,
  /\bmalaysia\b|\bkuala lumpur\b|\bpenang\b/i,
  /\bshanghai\b|上海|华东|華東|华东地区/i,
  /\bshenzhen\b|深圳/i,
  /\bguangzhou\b|广州|廣州/i,
  /\bbeijing\b|北京/i,
  /\btaipei\b|台北|台灣|台湾/i,
  /\bmacau\b|\bmacao\b|澳門|澳门/i,
  /\bmanila\b|\bphilippines\b|\bcebu\b/i,
  /\bbangkok\b|\bthailand\b/i,
  /\bjakarta\b|\bindonesia\b/i,
  /\bho chi minh\b|\bhanoi\b|\bvietnam\b/i,
  /\bmumbai\b|\bbangalore\b|\bbengaluru\b|\bdelhi\b|\bgurgaon\b|\bindia\b/i,
  /\btokyo\b|\bosaka\b|\bjapan\b/i,
  /\bseoul\b|\bbusan\b|\bkorea\b/i,
  /\bsydney\b|\bmelbourne\b|\baustralia\b/i,
  /\blondon\b|\bedinburgh\b|\bunited kingdom\b|\bengland\b/i,
  /\bnew york\b|\bchicago\b|\bunited states\b|\busa\b/i,
  /\btoronto\b|\bvancouver\b|\bcanada\b/i,
  /\bdubai\b|\buae\b|\babu dhabi\b/i,
  /\bzurich\b|\bgeneva\b|\bswitzerland\b/i,
  /\bfrankfurt\b|\bmunich\b|\bgermany\b/i,
  /\bparis\b|\bfrance\b/i,
  /\bsri lanka\b|\bcolombo\b/i,
];

/**
 * True when a location string places the posting outside Hong Kong.
 *
 * A blank location is **in** scope: nothing contradicts Hong Kong, and
 * `backfillRawJobs` fills blanks with "Hong Kong" before this runs.
 */
export function isOutOfScopeLocation(location: string | null | undefined): boolean {
  const value = (location ?? '').trim();
  if (!value) return false;
  if (HONG_KONG.test(value)) return false;
  return ELSEWHERE.some((pattern) => pattern.test(value));
}

/** The inverse, for readability at call sites that ask the positive question. */
export function isHongKongLocation(location: string | null | undefined): boolean {
  return !isOutOfScopeLocation(location);
}

/**
 * Split jobs into the ones to keep and the ones to report as out of scope.
 *
 * Generic over anything with a `location`, so it works on both `RawJob` and
 * `JobIngest` without the caller having to map first.
 */
export function partitionByLocationScope<T extends { location?: string | undefined }>(
  jobs: readonly T[],
): { kept: T[]; outOfScope: Array<{ job: T; location: string }> } {
  const kept: T[] = [];
  const outOfScope: Array<{ job: T; location: string }> = [];

  for (const job of jobs) {
    if (isOutOfScopeLocation(job.location)) {
      outOfScope.push({ job, location: job.location ?? '' });
    } else {
      kept.push(job);
    }
  }

  return { kept, outOfScope };
}
