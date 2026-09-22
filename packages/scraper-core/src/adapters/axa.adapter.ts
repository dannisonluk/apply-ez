import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { robotsDisallowedScrapeErrorFromUnknown, scraperUserAgent, throttledFetch } from '../lib/rate-limit.js';
import type { ScraperAdapter, ScrapeContext, ScrapeResult, RawJob } from './adapter.interface.js';

interface AXAConfig {
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  maxJobs?: number;
  fullCrawl?: boolean;
  locale?: string;
}

interface ExtractedCareerItem {
  title: string;
  url: string;
  location?: string;
  description?: string;
  postedAt?: string;
  department?: string;
  rawEmploymentType?: string;
  workSchedule?: string;
  externalId?: string;
}

const DEFAULT_URL =
  'https://careers.axa.com/careers-home/jobs?woe=7&lat=22.28552&lng=114.15769&location=Hong%20Kong,%20Central%20and%20Western%20District,%20Hong%20Kong&commuteUnit=DRIVING&commute=60&roadTraffic=BUSY_HOUR&searchType=commute&page=1&limit=100';
const DEFAULT_COMPANY_NAME = 'AXA';
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_MAX_JOBS = 100;

// Navigation / marketing / language-switcher labels that must never be treated as jobs.
// Language switcher entries (English, Italiano, Español, Türkçe…) are matched case-insensitively
// by name; short all-caps job abbreviations like "HR" stay valid. Footer legal links too.
const NAV_JUNK_TITLE_RE =
  /^(all\s+jobs?|your\s+career|our\s+culture|meet\s+our\s+people|life\s+at|working\s+here|why\s+axa|home|contact(\s+us)?|faqs?|about(\s+us)?|locations?|students?|experienced\s+hires?|events?|english|nederlands|fran[cç]ais|deutsch|italian[oa]?|espa[nñ]ol|t[uü]rk[cç]e|portugu[eê]s|polski|中文|繁體中文|简体中文|日本語|한국어|(privacy|cookie|legal|terms|accessibility)(\s+(policy|notice|information|statement))?|sitemap|help|(web\s+site?)?\s*accessibility.*|.*\s+(policy|statement)$)$/i;

function normalizeText(value: string | undefined | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function parseDateOrNow(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function slugSegment(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function buildPageUrl(rawUrl: string, pageIndex: number): string {
  const url = new URL(rawUrl);
  url.searchParams.set('page', String(pageIndex + 1));
  if (!url.searchParams.has('limit')) url.searchParams.set('limit', '100');
  return url.toString();
}

function normalizeExternalId(item: ExtractedCareerItem): string {
  if (item.externalId) return item.externalId;
  try {
    const url = new URL(item.url);
    const id =
      url.searchParams.get('jobId') ?? url.searchParams.get('id') ?? url.pathname.match(/\/jobs?\/([^/?#]+)/i)?.[1];
    if (id) return `${url.hostname}:${id}`;
    url.search = '';
    url.hash = '';
    return `${url.toString().replace(/\/+$/, '')}:${slugSegment(item.title)}`;
  } catch {
    return `${item.url}:${slugSegment(item.title)}`;
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page
    .evaluate(`(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
        const timer = window.setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight || total > 10000) {
            window.clearInterval(timer);
            resolve();
          }
        }, 120);
      });
    })()`)
    .catch(() => {});
}

async function extractItems(page: Page, baseUrl: string): Promise<ExtractedCareerItem[]> {
  const items = await page.evaluate<ExtractedCareerItem[]>(
    `((baseUrl) => {
      function text(node) {
        return (node && node.textContent ? node.textContent : '').replace(/\\s+/g, ' ').trim();
      }
      function abs(raw) {
        try {
          return raw ? new URL(raw, baseUrl).toString() : '';
        } catch {
          return '';
        }
      }
      function pick(obj, keys) {
        for (const key of keys) {
          const value = obj && obj[key];
          if (typeof value === 'string' && value.trim()) return value.trim();
          if (typeof value === 'number') return String(value);
        }
        return '';
      }
      function looksLikeTitle(value) {
        const title = String(value || '').replace(/\s+/g, ' ').trim();
        if (title.length < 3 || title.length > 180) return false;
        if (/^(search|apply|apply now|read more|view|more|privacy|terms|next|previous|my applications|my profile)$/i.test(title)) return false;
        // Navigation / marketing labels are not jobs (AXA careers nav: ALL JOBS, YOUR CAREER, OUR CULTURE…)
        if (/^(all\s+jobs?|your\s+career|our\s+culture|meet\s+our\s+people|life\s+at|working\s+here|why\s+axa|home|contact(\s+us)?|faqs?|about(\s+us)?|locations?|students?|experienced\s+hires?|events?|(privacy|cookie|legal|terms|accessibility)(\s+(policy|notice|information|statement))?|sitemap|help|(web\s+site?)?\s*accessibility.*|.*\s+(policy|statement)|english|nederlands|fran[cç]ais|deutsch|italian[oa]?|espa[nñ]ol|t[uü]rk[cç]e|portugu[eê]s|polski)$/i.test(title)) return false;
        // Language switcher entries are never job titles
        if (/^(中文|繁體中文|简体中文|日本語|한국어)$/i.test(title)) return false;
        return /[a-z]/i.test(title);
      }
      function closestJobCard(node) {
        let current = node;
        for (let depth = 0; current && depth < 8; depth += 1) {
          const value = text(current);
          if (/Req\\s+ID:/i.test(value) && /Job\\s+Family/i.test(value)) return current;
          current = current.parentElement;
        }
        return node.closest('.job-result, .job-results-card, .job-results-card-container, .job-card, li, article, div');
      }

      const found = [];
      const seen = new Set();
      function add(item) {
        if (!item || !looksLikeTitle(item.title) || !item.url) return;
        const key = item.title + '|' + item.url;
        if (seen.has(key)) return;
        seen.add(key);
        found.push(item);
      }

      function visit(value, depth) {
        if (!value || depth > 8) return;
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, depth + 1));
          return;
        }
        if (typeof value !== 'object') return;
        const title = pick(value, ['title', 'jobTitle', 'job_title', 'name', 'positionTitle', 'requisitionTitle']);
        const rawUrl = pick(value, ['url', 'jobUrl', 'job_url', 'applyUrl', 'applyURL', 'externalPath', 'canonicalUrl', 'link']);
        const id = pick(value, ['id', 'jobId', 'jobID', 'reqId', 'requisitionId', 'referenceNumber']);
        const location = pick(value, ['location', 'jobLocation', 'locationsText', 'city', 'country']);
        const description = pick(value, ['description', 'summary', 'jobDescription', 'shortDescription']);
        if (title && (rawUrl || id)) {
          add({
            title,
            url: abs(rawUrl) || (id ? abs('#' + encodeURIComponent(String(id))) : ''),
            location,
            description,
            department: pick(value, ['department', 'category', 'function', 'jobFunction']),
            rawEmploymentType: pick(value, ['employmentType', 'jobType', 'timeType']),
            workSchedule: pick(value, ['workSchedule', 'workType']),
            postedAt: pick(value, ['postedDate', 'datePosted', 'createdDate', 'updatedAt']),
            externalId: id || undefined,
          });
        }
        Object.values(value).forEach((item) => visit(item, depth + 1));
      }

      Array.from(document.querySelectorAll('script'))
        .map((node) => node.textContent || '')
        .filter((value) => value.trim().startsWith('{') || value.trim().startsWith('['))
        .forEach((raw) => {
          try {
            visit(JSON.parse(raw), 0);
          } catch {}
        });

      for (const link of Array.from(document.querySelectorAll('a.job-title-link[href]'))) {
        const title = text(link);
        const url = abs(link.getAttribute('href') || '');
        const card = closestJobCard(link);
        const rowText = text(card || link);
        const reqId = rowText.match(/Req\\s+ID:\\s*([0-9A-Za-z-]+)/i)?.[1] || '';
        const locationMatch = rowText.match(/Location\\s+([A-Z ,]+HK)/i)?.[1] || '';
        const familyMatch = rowText.match(/Job\\s+Family\\s+([^\\n]+?)(?:\\s+Apply Now|\\s+Read More|$)/i)?.[1] || '';
        add({
          title,
          url,
          location: locationMatch ? locationMatch.replace(/\\s+/g, ' ').trim() : 'Hong Kong',
          description: rowText.slice(0, 1200),
          department: familyMatch ? familyMatch.replace(/\\s+/g, ' ').trim() : undefined,
          externalId: reqId || undefined,
        });
      }

      const selectors = [
        '[data-testid*="job"]',
        '[class*="job-card"]',
        '[class*="jobCard"]',
        '[class*="jobs-list"] li',
        '[class*="search-result"]',
        'article',
        'li',
        'a[href*="/job"]',
        'a[href*="jobs"]',
      ].join(',');
      const titleSelectors = 'h1,h2,h3,[class*="title"],[data-testid*="title"],a';
      const locationSelectors = '[class*="location"],[data-testid*="location"]';
      for (const node of Array.from(document.querySelectorAll(selectors)).slice(0, 250)) {
        const titleNode = node.matches(titleSelectors) ? node : node.querySelector(titleSelectors);
        const link = node.matches('a[href]') ? node : node.querySelector('a[href]');
        const title = text(titleNode);
        const url = abs((link && link.getAttribute('href')) || node.getAttribute('href') || node.getAttribute('data-url') || '');
        if (/login|candidate-portal/i.test(url)) continue;
        if (!url || !/jobs?|career/i.test(url)) continue;
        if (!looksLikeTitle(title)) continue; // nav junk guard — same rules as the add() path
        add({
          title,
          url,
          location: text(node.querySelector(locationSelectors)) || 'Hong Kong',
          description: text(node).slice(0, 1200),
        });
      }
      return found;
    })(${JSON.stringify(baseUrl)})`,
  );
  return Array.isArray(items) ? items : [];
}

export class AXAAdapter implements ScraperAdapter {
  readonly name = 'axa';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as AXAConfig) ?? {};
    const startUrl = ctx.urlTemplate || DEFAULT_URL;
    const companyName = cfg.companyName ?? DEFAULT_COMPANY_NAME;
    const companyDomain = cfg.companyDomain ?? 'axa.com';
    const fullCrawl = cfg.fullCrawl === true;
    const maxPages = fullCrawl ? Number.POSITIVE_INFINITY : cfg.maxPages ?? DEFAULT_MAX_PAGES;
    const maxJobs = fullCrawl ? Number.POSITIVE_INFINITY : cfg.maxJobs ?? DEFAULT_MAX_JOBS;
    const jobs: RawJob[] = [];
    const errors: ScrapeResult['errors'] = [];
    const seen = new Set<string>();

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ userAgent: scraperUserAgent(), locale: cfg.locale ?? 'en-HK' });

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        if (jobs.length >= maxJobs) break;
        const pageUrl = buildPageUrl(startUrl, pageIndex);
        const page = await context.newPage();
        try {
          ctx.logger.info('AXA fetching careers page', { page: pageIndex + 1, url: pageUrl });
          const items = await throttledFetch(pageUrl, async () => {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
            await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
            await page.waitForSelector('a.job-title-link', { timeout: 15_000 }).catch(() => {});
            await autoScroll(page);
            return extractItems(page, pageUrl);
          });

          let newItems = 0;
          for (const item of items) {
            if (jobs.length >= maxJobs) break;
            const title = normalizeText(item.title);
            const url = item.url;
            if (!title || !url) continue;
            // Final safety net: drop navigation/marketing labels that slipped through
            // the in-page extraction (e.g. AXA header links to /jobs, /your-career).
            if (NAV_JUNK_TITLE_RE.test(title)) continue;
            const externalId = normalizeExternalId({ ...item, title, url });
            if (seen.has(externalId)) continue;
            seen.add(externalId);
            newItems += 1;
            jobs.push({
              externalId,
              companyName,
              companyDomain,
              title,
              location: normalizeText(item.location) || 'Hong Kong',
              description: normalizeText(item.description) || `${title} at ${companyName}.`,
              url,
              applyUrl: url,
              source: 'COMPANY_WEBSITE',
              tags: ['axa'],
              salaryCurrency: 'HKD',
              ...(item.department ? { department: normalizeText(item.department) } : {}),
              ...(item.rawEmploymentType ? { rawEmploymentType: normalizeText(item.rawEmploymentType) } : {}),
              ...(item.workSchedule ? { workSchedule: normalizeText(item.workSchedule) } : {}),
              publishedAt: parseDateOrNow(item.postedAt),
            });
          }
          if (newItems === 0) break;
        } catch (error) {
          const robotsError = robotsDisallowedScrapeErrorFromUnknown(error, { url: pageUrl });
          errors.push(robotsError ?? { message: `Failed to fetch AXA page: ${String(error)}`, context: { url: pageUrl } });
          break;
        } finally {
          await page.close().catch(() => {});
        }
      }
    } catch (error) {
      errors.push({ message: String(error) });
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }

    return { jobs, errors };
  }
}
