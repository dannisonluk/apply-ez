import type { JobSectionContent } from '../../types/index.js';
import { normalizeSectionText } from '../../types/index.js';
import type { DetailResult, Platform, ScrapedListItem } from './types.js';

export function normalizeText(value: string | undefined | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

export function cleanDetailText(value: string | undefined): string | undefined {
  const cleaned = normalizeText(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z])([/:])([A-Z])/g, '$1 $2 $3')
    .replace(/\b(Proven)(track)\b/gi, '$1 $2')
    .replace(/\b(Board)(or)\b/g, '$1 $2')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([/:])(?=\S)/g, '$1 ');
  return cleaned || undefined;
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function parseSourceDate(raw: string | undefined): string | undefined {
  const text = normalizeText(raw);
  if (!text) return undefined;

  const monthNames: Record<string, string> = {
    jan: '01',
    january: '01',
    feb: '02',
    february: '02',
    mar: '03',
    march: '03',
    apr: '04',
    april: '04',
    may: '05',
    jun: '06',
    june: '06',
    jul: '07',
    july: '07',
    aug: '08',
    august: '08',
    sep: '09',
    sept: '09',
    september: '09',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12',
  };

  const dayMonthYear = text.match(/^(\d{1,2})\/([A-Za-z]{3,9})\/(\d{2,4})$/);
  if (dayMonthYear) {
    const day = dayMonthYear[1]?.padStart(2, '0');
    const month = monthNames[(dayMonthYear[2] ?? '').toLowerCase()];
    const rawYear = dayMonthYear[3] ?? '';
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    if (day && month && year) return new Date(`${year}-${month}-${day}T00:00:00.000Z`).toISOString();
  }

  const slashDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,\s*(.+))?$/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const month = String(first > 12 ? second : first).padStart(2, '0');
    const day = String(first > 12 ? first : second).padStart(2, '0');
    const year = slashDate[3];
    const time = slashDate[4] ? ` ${slashDate[4]}` : '';
    const parsed = new Date(`${year}-${month}-${day}${time}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function parseDateOrNow(raw: string | undefined): string {
  return parseSourceDate(raw) ?? new Date().toISOString();
}

export function parseOptionalDate(raw: string | undefined): string | undefined {
  return parseSourceDate(raw);
}

export function extractTowngasDeadline(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = normalizeText(raw);
  const match =
    normalized.match(/Deadline for application:\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i) ||
    normalized.match(/Deadline for application:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i) ||
    normalized.match(/Deadline for application:\s*([0-9]{1,2}-[0-9]{1,2}-[0-9]{4})/i);
  return match?.[1]?.trim() || undefined;
}

export function descriptionFromSections(sectionContent: JobSectionContent | undefined, fallback?: string): string {
  const parts = [
    normalizeSectionText(sectionContent?.roleIntroduction),
    normalizeSectionText(sectionContent?.keyResponsibilities),
    normalizeSectionText(sectionContent?.requirements),
  ].filter((value): value is string => Boolean(value && value.trim()));
  return parts.length > 0 ? parts.join('\n\n') : normalizeText(fallback);
}

export function hasStructuredDetail(detail: DetailResult | undefined): boolean {
  return Boolean(
    detail?.sectionContent?.roleIntroduction ||
      detail?.sectionContent?.keyResponsibilities ||
      detail?.sectionContent?.requirements ||
      detail?.requirements ||
      detail?.department ||
      detail?.workSchedule ||
      detail?.applicationDeadline,
  );
}

function slugSegment(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function normalizeExternalId(absoluteUrl: string, title?: string): string {
  try {
    const u = new URL(absoluteUrl);
    const pid = u.searchParams.get('pid');
    if (pid) return `${u.hostname}:${pid}`;
    const jobId = u.searchParams.get('jobID');
    if (jobId) return `${u.hostname}:${jobId}`;
    const oracleJobId = u.pathname.match(/\/job\/(\d+)\/?$/i)?.[1];
    if (oracleJobId) return `${u.hostname}:${oracleJobId}`;
    if (u.hash && u.hash !== '#') {
      const hash = u.hash.slice(1).trim();
      u.hash = '';
      return `${u.toString().replace(/\/+$/, '')}#${hash}`;
    }
    if (u.hash === '#' && title) {
      u.hash = '';
      return `${u.toString().replace(/\/+$/, '')}:${slugSegment(title)}`;
    }
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return absoluteUrl;
  }
}

export function toAbsoluteUrl(rawUrl: string, baseUrl: string): string {
  try {
    if (rawUrl.startsWith('//')) return new URL(`https:${rawUrl}`).toString();
    const url = rawUrl.startsWith('http') ? new URL(rawUrl) : new URL(rawUrl, baseUrl);
    if (url.protocol === 'http:' && new URL(baseUrl).protocol === 'https:') {
      url.protocol = 'https:';
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function compactTitle(value: string): string {
  return normalizeText(value).replace(/([a-z)])([A-Z])/g, '$1 $2');
}

function stripLeadingLabel(value: string, label: string): string {
  return value.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '').trim();
}

function normalizeTowngasTitle(item: ScrapedListItem): string {
  const merged = compactTitle(item.title);
  const match = merged.match(/^(.+?)\1\b/i);
  const deduped = match?.[1] ? match[1] : merged;
  return deduped
    .replace(/\bThe HK and China Gas Co(?:mpany)? Ltd.*$/i, '')
    .replace(/\bPosted on:.*$/i, '')
    .trim();
}

export function normalizeTowngasUrl(rawUrl: string, baseUrl: string): string {
  const jobId = rawUrl.match(/[?&]jobID=([^&]+)/i)?.[1];
  if (jobId) {
    return new URL(`/en/Careers/Job-Opportunities/Job-List/Job-Details?jobID=${encodeURIComponent(jobId)}`, baseUrl).toString();
  }
  return toAbsoluteUrl(rawUrl, baseUrl);
}

function normalizeOracleTitle(item: ScrapedListItem): string {
  return compactTitle(item.title)
    .replace(/\bLocations?\b.*$/i, '')
    .replace(/\bPosting Date\b.*$/i, '')
    .trim();
}

function normalizeOracleLocation(item: ScrapedListItem): string {
  const inline = compactTitle(item.title).match(/\bLocations?\s+([A-Za-z][A-Za-z\s-]+)/i)?.[1];
  const cleanedInline = inline?.replace(/\bPosting Date.*$/i, '').trim();
  if (cleanedInline) return cleanedInline;
  const cleanedLocation = compactTitle(item.location ?? '').replace(/\bPosting Date.*$/i, '').trim();
  if (cleanedLocation && !/^locations?$/i.test(cleanedLocation)) return stripLeadingLabel(cleanedLocation, 'Locations');
  return 'Hong Kong';
}

export function normalizeTaleoUrl(item: ScrapedListItem, title: string): string {
  if (item.url) return item.url;
  if (item.listUrl) return new URL('jobdetail.ftl', item.listUrl).toString();
  return 'https://careers.mtr.com.hk/careersection/mtr_external/jobdetail.ftl';
}

export function normalizeTaleoExternalId(url: string, title: string): string {
  const ref = title.match(/\(Ref:\s*([A-Za-z0-9]+)\)/i)?.[1];
  if (!ref) return normalizeExternalId(url, title);
  const parsed = new URL(url);
  return `${parsed.hostname}:${ref.toLowerCase()}`;
}

export function normalizeItemForPlatform(item: ScrapedListItem, platform: Platform): ScrapedListItem {
  if (platform === 'towngas') {
    return {
      ...item,
      title: normalizeTowngasTitle(item),
    };
  }

  if (platform === 'oracle') {
    return {
      ...item,
      title: normalizeOracleTitle(item),
      location: normalizeOracleLocation(item),
    };
  }

  return item;
}

export function inferPlatform(url: string): Platform {
  const hostAndPath = url.toLowerCase();
  if (hostAndPath.includes('pageuppeople') || hostAndPath.includes('hkexpress')) return 'pageup';
  if (hostAndPath.includes('successfactors') || hostAndPath.includes('swire.com/go/')) return 'successfactors';
  if (hostAndPath.includes('towngas.com')) return 'towngas';
  if (hostAndPath.includes('careersection') || hostAndPath.includes('joblist.ftl')) return 'taleo';
  if (hostAndPath.includes('oraclecloud.com') || hostAndPath.includes('candidateexperience')) return 'oracle';
  if (hostAndPath.includes('eightfold.ai')) return 'eightfold';
  if (hostAndPath.includes('portal.careers.hsbc.com')) return 'hsbc';
  if (hostAndPath.includes('shkp.com')) return 'shkp';
  return 'towngas';
}

export function buildPageUrl(url: string, platform: Platform, pageIndex: number): string {
  if (pageIndex === 0) return url;
  const pageNumber = pageIndex + 1;
  const offset = pageIndex * 25;
  const u = new URL(url);

  if (url.includes('{page}')) return url.replace('{page}', String(pageNumber));
  if (url.includes('{offset}')) return url.replace('{offset}', String(offset));

  switch (platform) {
    case 'pageup':
      u.searchParams.set('page', String(pageNumber));
      if (!u.searchParams.has('page-items')) u.searchParams.set('page-items', '10');
      return u.toString();
    case 'successfactors':
      u.searchParams.set('startrow', String(offset));
      return u.toString();
    case 'eightfold':
      u.searchParams.set('start', String(offset));
      return u.toString();
    case 'oracle':
      u.searchParams.set('page', String(pageNumber));
      return u.toString();
    case 'hsbc':
      u.searchParams.set('page', String(pageNumber));
      return u.toString();
    default:
      return url;
  }
}

export function looksLikeJobTitle(value: string): boolean {
  const text = normalizeText(value);
  if (text.length < 3 || text.length > 180) return false;
  if (/^(search|apply|view|more|login|register|privacy|terms|next|previous|facebook|instagram|linkedin|youtube|talent community|job opportunities)$/i.test(text)) return false;
  // Navigation / marketing labels and language-switcher entries are never jobs
  if (/^(all\s+jobs?|your\s+career|our\s+culture|meet\s+our\s+people|life\s+at|working\s+here|home|contact(\s+us)?|faqs?|about(\s+us)?|locations?|events?|english|nederlands|fran[cç]ais|deutsch|中文|繁體中文|简体中文)$/i.test(text)) return false;
  return /[a-z\u3400-\u9fff]/i.test(text);
}

function hasJobTitleSignals(value: string): boolean {
  return /\b(accountant|administrator|administration|analyst|architect|assistant|associate|clerk|consultant|controller|developer|director|engineer|executive|finance|graduate|intern|legal|manager|marketing|mechanic|officer|operator|planner|receptionist|representative|secretary|specialist|superintendent|supervisor|technician|trainee|vice president)\b/i.test(value);
}

function sameHost(url: string, pageUrl: string): boolean {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

export function isLikelyJobItem(item: ScrapedListItem, platform: Platform, pageUrl: string): boolean {
  if (!looksLikeJobTitle(item.title)) return false;
  const url = item.url.toLowerCase();
  const text = `${item.title} ${item.meta ?? ''} ${item.description ?? ''}`;
  const onSameHost = sameHost(item.url, pageUrl);
  const hasTitleSignal = hasJobTitleSignals(item.title);

  if (/facebook|instagram|linkedin\.com|youtube|twitter|x\.com/.test(url)) return false;
  if (/talent community|job alert|privacy|terms|cookie|contact us|about us/i.test(text)) return false;

  switch (platform) {
    case 'pageup':
      return /\/jobs\/|\/job\/|\/listing\/\d+|\/listing\/[a-z0-9-]+/i.test(url) || (onSameHost && hasTitleSignal);
    case 'successfactors':
      return /\/job\/.+\/\d+\/?$/i.test(url) || /job[_-]?id|req/i.test(text);
    case 'towngas':
      return /job-detail|jobdetail|jobid|vacanc/i.test(url) || /\b(ref|reference|job)\s*[:#]?\s*[a-z0-9-]+/i.test(text) || (onSameHost && hasTitleSignal);
    case 'taleo':
      return /jobdetail|joblist\.ftl(?:#.*)?$/i.test(url) && (/\(ref:\s*[a-z0-9]+\)/i.test(item.title) || hasTitleSignal);
    case 'oracle':
      return (/\/jobs?\/[^/?#]+/i.test(url) || (onSameHost && hasTitleSignal)) && !/join-talent-community/i.test(url);
    case 'eightfold':
      return /pid=\d+|\/careers\/job/i.test(url);
    case 'hsbc':
      return /\/careers\/job|\/job\/|jobid|requisition|req/i.test(url) || (onSameHost && hasTitleSignal);
    case 'shkp':
      return (
        /job-vacanc|job-vacancy|vacancy|career|position/i.test(url) ||
        /\b(ref|reference|job)\s*[:#]?\s*[a-z0-9-]+/i.test(text) ||
        /[\u3400-\u9fff]/.test(item.title)
      );
    default:
      return true;
  }
}
