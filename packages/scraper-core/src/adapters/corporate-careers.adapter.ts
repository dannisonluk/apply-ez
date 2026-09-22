import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { RawJob } from './adapter.interface.js';
import type { ScraperAdapter, ScrapeContext, ScrapeResult } from './adapter.interface.js';
import { robotsDisallowedScrapeErrorFromUnknown, scraperUserAgent, throttledFetch } from '../lib/rate-limit.js';
import { extractDetail, extractTaleoDetail } from './corporate-careers/extract-detail.js';
import {
  extractItemsFromDom,
  extractItemsFromEmbeddedJson,
  extractItemsFromJsonLd,
  extractMtrItemsFromDom,
  extractShkpItemsFromHtml,
  extractShkpItemsFromDom,
  extractShkpItemsFromJson,
  extractTowngasItemsFromDom,
} from './corporate-careers/extract-list.js';
import { PLATFORM_SELECTORS } from './corporate-careers/selectors.js';
import type { CorporateCareersConfig, DetailResult, Platform, ScrapedListItem } from './corporate-careers/types.js';
import {
  buildPageUrl,
  descriptionFromSections,
  extractTowngasDeadline,
  inferPlatform,
  isLikelyJobItem,
  normalizeExternalId,
  normalizeItemForPlatform,
  normalizeTaleoExternalId,
  normalizeTaleoUrl,
  normalizeText,
  parseDateOrNow,
  parseOptionalDate,
} from './corporate-careers/utils.js';

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_JOBS = 250;
const SHKP_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function autoScroll(page: Page): Promise<void> {
  await page
    .evaluate(`(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = Math.max(300, Math.floor(window.innerHeight * 0.75));
        const timer = window.setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight || total > 8000) {
            window.clearInterval(timer);
            resolve();
          }
        }, 120);
      });
    })()`)
    .catch(() => {});
}

async function closeCookieBanners(page: Page): Promise<void> {
  const labels = ['Accept', 'Accept all', 'Agree', 'I agree', 'OK', 'Got it'];
  for (const label of labels) {
    const button = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 1000 }).catch(() => {});
      return;
    }
  }
}

async function waitForShkpJobs(page: Page): Promise<void> {
  await page
    .waitForSelector('#accorJobs .jobs-list a[href], .accordion-group.accordion-collapse-mobile-ctn .jobs-list a[href]', {
      timeout: 15_000,
    })
    .catch(() => {});
}

async function getShkpDiagnostics(page: Page): Promise<Record<string, unknown>> {
  // NOTE: string-form evaluate — function-form breaks under tsx/esbuild, which
  // injects a __name() helper that does not exist in the browser context.
  return page.evaluate(
    `(() => {
    const root = document.getElementById('accorJobs') || document.querySelector('.accordion-group.accordion-collapse-mobile-ctn');
    const text = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /shkp|job|vacanc|career|search|json|api/i.test(name))
      .slice(0, 20);
    return {
      url: location.href,
      title: document.title,
      hasAccorJobs: Boolean(document.getElementById('accorJobs')),
      hasAccordionClass: Boolean(document.querySelector('.accordion-group.accordion-collapse-mobile-ctn')),
      rootChildCount: root ? root.children.length : 0,
      desktopRows: root ? root.querySelectorAll('.hidden-xs.fake-table-row').length : 0,
      mobilePanels: root ? root.querySelectorAll('.panel.panel-default.visible-xs').length : 0,
      jobLinks: root ? root.querySelectorAll('.jobs-list a[href]').length : 0,
      firstLinks: Array.from(root ? root.querySelectorAll('.jobs-list a[href]') : [])
        .slice(0, 5)
        .map((link) => ({
          text: text(link.textContent),
          href: link.getAttribute('href') || '',
          title: link.getAttribute('title') || '',
        })),
      resources,
      bodyTextSample: text(document.body && document.body.textContent).slice(0, 300),
    };
  })()`,
  );
}

async function getShkpFallbackUrls(page: Page, pageUrl: string): Promise<string[]> {
  // NOTE: string-form evaluate — function-form breaks under tsx/esbuild (__name helper).
  const fromDom = await page
    .evaluate(
      `(() => {
      const root = document.getElementById('accorJobs') || document.querySelector('.accordion-group.accordion-collapse-mobile-ctn');
      return root ? (root.getAttribute('data-href') || '') : '';
    })()`,
    )
    .catch(() => '');
  const parsed = new URL(pageUrl);
  const withoutSearch = `${parsed.origin}${parsed.pathname}`;
  return Array.from(
    new Set(
      [pageUrl, fromDom, withoutSearch]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value): value is string => value.length > 0),
    ),
  );
}

function shkpRequestUserAgent(platform: Platform): string {
  return platform === 'shkp' ? SHKP_BROWSER_USER_AGENT : scraperUserAgent();
}

function buildShkpListUrl(pageUrl: string, pageIndex: number): string {
  const url = new URL(pageUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  if (!basePath.endsWith('/getList')) {
    url.pathname = `${basePath}/getList`;
  }
  url.searchParams.set('page', String(pageIndex));
  return url.toString();
}

async function fetchShkpListJson(
  context: BrowserContext,
  pageUrl: string,
  pageIndex: number,
): Promise<{ url: string; status: number; items: ScrapedListItem[]; rawCount: number; error?: string }> {
  const url = buildShkpListUrl(pageUrl, pageIndex);
  try {
    const response = await throttledFetch(url, () =>
      context.request.get(url, {
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          referer: pageUrl,
          'user-agent': SHKP_BROWSER_USER_AGENT,
          'x-requested-with': 'XMLHttpRequest',
        },
        timeout: 20_000,
      }),
    );
    const text = await response.text();
    let payload: unknown = [];
    try {
      payload = JSON.parse(text);
    } catch {
      payload = [];
    }
    const rawCount = Array.isArray(payload) ? payload.length : 0;
    return {
      url,
      status: response.status(),
      items: extractShkpItemsFromJson(payload, pageUrl),
      rawCount,
    };
  } catch (error) {
    return {
      url,
      status: 0,
      items: [],
      rawCount: 0,
      error: String(error),
    };
  }
}

async function fetchShkpHtmlFallbacks(
  context: BrowserContext,
  platform: Platform,
  page: Page,
  pageUrl: string,
): Promise<Array<{ url: string; html: string; status: number }>> {
  const urls = await getShkpFallbackUrls(page, pageUrl);
  const responses: Array<{ url: string; html: string; status: number }> = [];
  for (const url of urls) {
    try {
      const response = await context.request.get(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: pageUrl,
          'user-agent': shkpRequestUserAgent(platform),
        },
        timeout: 20_000,
      });
      const text = await response.text();
      responses.push({ url, html: text.slice(0, 2_000_000), status: response.status() });
    } catch {
      responses.push({ url, html: '', status: 0 });
    }
  }
  return responses;
}

async function fetchShkpBrowserFallbacks(
  context: BrowserContext,
  page: Page,
  pageUrl: string,
): Promise<Array<{ url: string; html: string; status: number; finalUrl: string }>> {
  const urls = await getShkpFallbackUrls(page, pageUrl);
  const responses: Array<{ url: string; html: string; status: number; finalUrl: string }> = [];
  for (const url of urls) {
    const fallbackPage = await context.newPage();
    try {
      const response = await fallbackPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await fallbackPage.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await autoScroll(fallbackPage);
      await waitForShkpJobs(fallbackPage);
      const html = await fallbackPage.content();
      responses.push({
        url,
        html: html.slice(0, 2_000_000),
        status: response?.status() ?? 0,
        finalUrl: fallbackPage.url(),
      });
    } catch {
      responses.push({ url, html: '', status: 0, finalUrl: fallbackPage.url() });
    } finally {
      await fallbackPage.close().catch(() => {});
    }
  }
  return responses;
}

function buildJob(
  item: ScrapedListItem,
  cfg: CorporateCareersConfig,
  platform: Platform,
  detail?: DetailResult,
): RawJob {
  const normalizedItem = normalizeItemForPlatform(item, platform);
  const url = detail?.url ?? (platform === 'taleo' ? normalizeTaleoUrl(normalizedItem, normalizedItem.title) : normalizedItem.url);
  const externalId =
    platform === 'taleo' ? normalizeTaleoExternalId(url, normalizedItem.title) : normalizeExternalId(url, normalizedItem.title);
  const description =
    normalizeText(detail?.description) ||
    descriptionFromSections(detail?.sectionContent, item.description) ||
    `${item.title} at ${cfg.companyName}.`;
  const metaEmploymentType =
    normalizedItem.meta && /(permanent|contract|intern|full[- ]time|part[- ]time)/i.test(normalizedItem.meta)
      ? normalizedItem.meta
      : undefined;
  const rawEmploymentType = detail?.rawEmploymentType ?? normalizedItem.rawEmploymentType ?? metaEmploymentType;
  const department = detail?.department ?? normalizedItem.department;
  const workSchedule = detail?.workSchedule ?? normalizedItem.workSchedule;
  const rawDeadline =
    platform === 'towngas'
      ? extractTowngasDeadline(detail?.applicationDeadline) ?? extractTowngasDeadline(normalizedItem.applicationDeadline) ?? detail?.applicationDeadline ?? normalizedItem.applicationDeadline
      : detail?.applicationDeadline ?? normalizedItem.applicationDeadline;
  const parsedDeadline = parseOptionalDate(rawDeadline);
  const sectionContent = detail?.sectionContent ??
    (platform === 'taleo'
      ? {
          roleIntroduction: normalizeText(normalizedItem.description) || `${normalizedItem.title} at ${cfg.companyName}.`,
        }
      : undefined);
  const topMetadata = {
    ...(detail?.topMetadata ?? {}),
    ...(department ? { department } : {}),
    ...(workSchedule ? { workSchedule } : {}),
    ...(rawDeadline ? { applicationDeadline: parsedDeadline ?? rawDeadline, deadline: parsedDeadline ?? rawDeadline } : {}),
    ...(rawEmploymentType ? { employmentType: rawEmploymentType } : {}),
  };
  return {
    externalId,
    companyName: cfg.companyName ?? 'Unknown Company',
    ...(cfg.companyDomain ? { companyDomain: cfg.companyDomain } : {}),
    locale: cfg.locale ?? 'en',
    title: normalizedItem.title,
    location: normalizeText(detail?.location ?? normalizedItem.location) || cfg.location || 'Hong Kong',
    description,
    ...(detail?.requirements ? { requirements: detail.requirements } : {}),
    url,
    applyUrl: url,
    source: 'COMPANY_WEBSITE',
    tags: ['corporate-careers', platform],
    salaryCurrency: 'HKD',
    ...(rawEmploymentType ? { rawEmploymentType } : {}),
    ...(department ? { department } : {}),
    ...(workSchedule ? { workSchedule } : {}),
    ...(parsedDeadline ? { applicationDeadline: parsedDeadline } : {}),
    ...(sectionContent ? { sectionContent } : {}),
    ...(Object.keys(topMetadata).length > 0 ? { topMetadata } : {}),
    publishedAt: parseDateOrNow(detail?.postedAt ?? item.postedAt),
  };
}

export class CorporateCareersAdapter implements ScraperAdapter {
  readonly name = 'corporate-careers';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as CorporateCareersConfig) ?? {};
    const startUrls = ctx.entryUrls?.length ? ctx.entryUrls : ctx.urlTemplate ? [ctx.urlTemplate] : [];
    const errors: ScrapeResult['errors'] = [];
    const jobs: RawJob[] = [];
    const seen = new Set<string>();

    if (startUrls.length === 0) {
      return { jobs, errors: [{ message: 'corporate-careers adapter requires urlTemplate or entryUrls' }] };
    }
    if (!cfg.companyName) {
      return { jobs, errors: [{ message: 'corporate-careers adapter requires config.companyName' }] };
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      const usesShkp = startUrls.some((startUrl) => (cfg.platform ?? inferPlatform(startUrl)) === 'shkp');
      context = await browser.newContext({
        userAgent: usesShkp ? SHKP_BROWSER_USER_AGENT : scraperUserAgent(),
        locale: cfg.locale ?? 'en-HK',
        ignoreHTTPSErrors: usesShkp,
      });

      for (const startUrl of startUrls) {
        const platform = cfg.platform ?? inferPlatform(startUrl);
        const platformSelectors = PLATFORM_SELECTORS[platform];
        const selectorConfig = {
          ...platformSelectors,
          ...(cfg.listSelector ? { listSelector: cfg.listSelector } : {}),
          ...(cfg.titleSelector ? { titleSelector: cfg.titleSelector } : {}),
          ...(cfg.urlSelector ? { urlSelector: cfg.urlSelector } : {}),
          ...(cfg.locationSelector ? { locationSelector: cfg.locationSelector } : {}),
          ...(cfg.metaSelector ? { metaSelector: cfg.metaSelector } : {}),
          ...(cfg.descriptionSelector ? { descriptionSelector: cfg.descriptionSelector } : {}),
        };

        const fullCrawl = cfg.fullCrawl === true;
        const maxPages = fullCrawl ? Number.POSITIVE_INFINITY : Math.max(1, cfg.maxPages ?? DEFAULT_MAX_PAGES);
        const maxJobs = fullCrawl ? Number.POSITIVE_INFINITY : cfg.maxJobs ?? DEFAULT_MAX_JOBS;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
          if (jobs.length >= maxJobs) break;
          const pageUrl = buildPageUrl(startUrl, platform, pageIndex);
          const page = await context.newPage();
          const shkpHtmlResponses: Array<{ url: string; html: string }> = [];
          if (platform === 'shkp') {
            page.on('response', async (response) => {
              const responseUrl = response.url();
              const contentType = response.headers()['content-type'] ?? '';
              if (!/job-vacanc|work-with-us/i.test(responseUrl) && !/html|json|javascript/i.test(contentType)) return;
              try {
                const body = await response.text();
                if (/\/job-vacancies\//i.test(body)) {
                  shkpHtmlResponses.push({ url: responseUrl, html: body.slice(0, 2_000_000) });
                }
              } catch {
                // Ignore non-text/consumed responses.
              }
            });
          }
          try {
            ctx.logger.info(`corporate-careers fetching ${pageUrl}`);

            // Career sites intermittently serve a shell page with no job list —
            // bot checks, slow client-side rendering, or a transient upstream error.
            // One reload recovers most of these. Without it a transient miss is
            // indistinguishable from "this company genuinely has no openings", which
            // is exactly how jobs silently disappear between runs.
            let items: ScrapedListItem[] = [];
            for (let attempt = 0; attempt < 2; attempt += 1) {
              if (attempt > 0) {
                ctx.logger.warn('zero candidates extracted, reloading once', { pageUrl, attempt });
                await new Promise((resolve) => setTimeout(resolve, 2_000));
              }

              await throttledFetch(pageUrl, async () => {
                await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await closeCookieBanners(page);
                await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
                await autoScroll(page);
                if (platform === 'shkp') {
                  await waitForShkpJobs(page);
                }
              });
              if (platform === 'shkp') {
                ctx.logger.info('shkp dom diagnostics before extraction', await getShkpDiagnostics(page));
              }

              const fromJsonLd = platform === 'taleo' ? [] : await extractItemsFromJsonLd(page, pageUrl);
              const fromDom =
                platform === 'taleo'
                  ? await extractMtrItemsFromDom(page, pageUrl)
                  : platform === 'towngas'
                    ? await extractTowngasItemsFromDom(page, pageUrl)
                    : platform === 'shkp'
                      ? await extractShkpItemsFromDom(page, pageUrl)
                    : await extractItemsFromDom(page, selectorConfig, pageUrl);
              const fromShkpHtml =
                platform === 'shkp' && fromDom.length === 0
                  ? shkpHtmlResponses.flatMap((response) => extractShkpItemsFromHtml(response.html, response.url || pageUrl))
                  : [];
              const shkpListJson =
                platform === 'shkp' && fromDom.length === 0 && fromShkpHtml.length === 0 && context
                  ? await fetchShkpListJson(context, pageUrl, pageIndex)
                  : undefined;
              const fromShkpListJson = shkpListJson?.items ?? [];
              const shkpDirectHtmlResponses =
                platform === 'shkp' && fromDom.length === 0 && fromShkpHtml.length === 0 && fromShkpListJson.length === 0 && context
                  ? await fetchShkpHtmlFallbacks(context, platform, page, pageUrl)
                  : [];
              const fromShkpDirectHtml =
                platform === 'shkp' && fromDom.length === 0 && fromShkpHtml.length === 0 && fromShkpListJson.length === 0
                  ? shkpDirectHtmlResponses.flatMap((response) => extractShkpItemsFromHtml(response.html, response.url || pageUrl))
                  : [];
              const shkpBrowserHtmlResponses =
                platform === 'shkp' &&
                fromDom.length === 0 &&
                fromShkpHtml.length === 0 &&
                fromShkpListJson.length === 0 &&
                fromShkpDirectHtml.length === 0 &&
                context
                  ? await fetchShkpBrowserFallbacks(context, page, pageUrl)
                  : [];
              const fromShkpBrowserHtml =
                platform === 'shkp' &&
                fromDom.length === 0 &&
                fromShkpHtml.length === 0 &&
                fromShkpListJson.length === 0 &&
                fromShkpDirectHtml.length === 0
                  ? shkpBrowserHtmlResponses.flatMap((response) => extractShkpItemsFromHtml(response.html, response.finalUrl || response.url || pageUrl))
                  : [];
              const fromEmbeddedJson = ['hsbc', 'shkp'].includes(platform) ? await extractItemsFromEmbeddedJson(page, pageUrl) : [];
              items = [...fromJsonLd, ...fromEmbeddedJson, ...fromDom, ...fromShkpHtml, ...fromShkpListJson, ...fromShkpDirectHtml, ...fromShkpBrowserHtml];

              if (platform === 'shkp') {
                ctx.logger.info('shkp extraction diagnostics', {
                  jsonLd: fromJsonLd.length,
                  embeddedJson: fromEmbeddedJson.length,
                  dom: fromDom.length,
                  htmlResponses: shkpHtmlResponses.length,
                  htmlFallback: fromShkpHtml.length,
                  listJsonResponse: shkpListJson
                    ? {
                        url: shkpListJson.url,
                        status: shkpListJson.status,
                        rawCount: shkpListJson.rawCount,
                        extracted: fromShkpListJson.length,
                        error: shkpListJson.error,
                      }
                    : null,
                  directHtmlResponses: shkpDirectHtmlResponses.map((response) => ({
                    url: response.url,
                    status: response.status,
                    length: response.html.length,
                    hasJobVacancies: /\/job-vacancies\//i.test(response.html),
                  })),
                  directHtmlFallback: fromShkpDirectHtml.length,
                  browserHtmlResponses: shkpBrowserHtmlResponses.map((response) => ({
                    url: response.url,
                    finalUrl: response.finalUrl,
                    status: response.status,
                    length: response.html.length,
                    hasJobVacancies: /\/job-vacancies\//i.test(response.html),
                  })),
                  browserHtmlFallback: fromShkpBrowserHtml.length,
                  totalCandidates: items.length,
                  samples: items.slice(0, 5).map((item) => ({
                    title: item.title,
                    url: item.url,
                    location: item.location,
                    department: item.department,
                  })),
                });
              }

              if (items.length > 0) break;
            }
            if (items.length === 0) {
              ctx.logger.warn('zero candidates after reload', { pageUrl });
              if (platform === 'shkp') {
                ctx.logger.warn('shkp zero candidates after extraction', await getShkpDiagnostics(page));
              }
            }
            ctx.logger.info(
              `corporate-careers extracted ${items.length} candidate items for ${platform}: ${items
                .slice(0, 3)
                .map((item) => `${item.title} <${item.url}>`)
                .join(' | ')}`,
            );
            let newItems = 0;

            for (const item of items) {
              if (jobs.length >= maxJobs) break;
              if (!['towngas', 'taleo'].includes(platform) && !isLikelyJobItem(item, platform, pageUrl)) continue;
              const externalId =
                platform === 'taleo'
                  ? normalizeTaleoExternalId(item.url, item.title)
                  : normalizeExternalId(item.url, item.title);
              if (seen.has(externalId)) continue;
              seen.add(externalId);
              newItems += 1;

              let detail: Awaited<ReturnType<typeof extractDetail>> | undefined;
              if (cfg.includeDetailPages && platform !== 'shkp') {
                const detailPage = await context.newPage();
                try {
                  detail = await throttledFetch(item.url, () =>
                    platform === 'taleo' ? extractTaleoDetail(detailPage, item).then((value) => value ?? {}) : extractDetail(detailPage, item.url, platform),
                  );
                } catch (detailErr) {
                  errors.push({ message: `Failed to fetch detail page: ${String(detailErr)}`, context: { url: item.url } });
                } finally {
                  await detailPage.close().catch(() => {});
                }
              }

              jobs.push(buildJob(item, cfg, platform, detail));
            }

            if (newItems === 0 || !['pageup', 'successfactors', 'eightfold', 'oracle', 'hsbc'].includes(platform)) break;
          } catch (error) {
            const robotsError = robotsDisallowedScrapeErrorFromUnknown(error, { url: pageUrl });
            errors.push(robotsError ?? { message: `Failed to fetch ${pageUrl}: ${String(error)}`, context: { url: pageUrl } });
            break;
          } finally {
            await page.close().catch(() => {});
          }
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
