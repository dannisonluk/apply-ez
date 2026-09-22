import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ScraperAdapter, ScrapeContext, ScrapeResult, RawJob } from './adapter.interface.js';
import {
  isAllowedByRobots,
  robotsDisallowedScrapeError,
  robotsDisallowedScrapeErrorFromUnknown,
  scraperUserAgent,
  throttledFetch,
} from '../lib/rate-limit.js';

interface GenericSelectorConfig {
  listSelector: string;
  titleSelector: string;
  urlSelector?: string;
  locationSelector?: string;
  descriptionSelector?: string;
  companyName: string;
  paginationParam?: string;
  maxPages?: number;
}

// Strip query/hash so the same posting served with different tracking params still
// upserts onto one Job row via the (source, externalId) unique index.
function normalizeExternalId(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return absoluteUrl;
  }
}

// Generic adapter — uses DB-configured CSS selectors so an admin can add new sites
// without writing code. For simple static pages. Dynamic heavy sites → build a dedicated adapter.
export class GenericPlaywrightAdapter implements ScraperAdapter {
  readonly name = 'generic';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const selectorConfig = ctx.config as unknown as Partial<GenericSelectorConfig>;
    if (!ctx.urlTemplate) {
      return {
        jobs: [],
        errors: [{ message: 'Generic adapter requires target.urlTemplate' }],
      };
    }
    if (!selectorConfig.listSelector || !selectorConfig.titleSelector || !selectorConfig.companyName) {
      return {
        jobs: [],
        errors: [{ message: 'Generic adapter requires config.listSelector, config.titleSelector, config.companyName' }],
      };
    }

    const maxPages = selectorConfig.maxPages ?? 1;
    const jobs: RawJob[] = [];
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ userAgent: scraperUserAgent() });

      for (let i = 1; i <= maxPages; i += 1) {
        const url = ctx.urlTemplate.replace('{page}', String(i));
        ctx.logger.info(`Generic adapter fetching ${url}`);

        if (!(await isAllowedByRobots(url))) {
          errors.push(robotsDisallowedScrapeError(url, { page: i }));
          continue;
        }

        const page = await context.newPage();
        try {
          await throttledFetch(url, async () => {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.waitForSelector(selectorConfig.listSelector as string, { timeout: 15_000 }).catch(() => {});
          });

          const items = await page.$$eval(
            selectorConfig.listSelector,
            (nodes, cfg: GenericSelectorConfig) =>
              nodes.map((n) => ({
                title: n.querySelector(cfg.titleSelector)?.textContent?.trim() ?? '',
                url: cfg.urlSelector ? n.querySelector(cfg.urlSelector)?.getAttribute('href') ?? '' : '',
                location: cfg.locationSelector ? n.querySelector(cfg.locationSelector)?.textContent?.trim() ?? '' : '',
                description: cfg.descriptionSelector ? n.querySelector(cfg.descriptionSelector)?.textContent?.trim() ?? '' : '',
              })),
            selectorConfig as GenericSelectorConfig,
          );

          for (const it of items) {
            if (!it.title || !it.url) continue;
            const absoluteUrl = it.url.startsWith('http') ? it.url : new URL(it.url, url).toString();
            jobs.push({
              externalId: normalizeExternalId(absoluteUrl),
              companyName: selectorConfig.companyName,
              title: it.title,
              location: it.location || 'Hong Kong',
              description: it.description,
              url: absoluteUrl,
              source: 'COMPANY_WEBSITE',
              salaryCurrency: 'HKD',
              publishedAt: new Date().toISOString(),
            });
          }
        } catch (pageErr) {
          const robotsError = robotsDisallowedScrapeErrorFromUnknown(pageErr, { page: i });
          errors.push(robotsError ?? { message: `page ${i}: ${String(pageErr)}`, context: { page: i } });
        } finally {
          await page.close().catch(() => {});
        }
      }
    } catch (err) {
      errors.push({ message: String(err) });
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }

    return { jobs, errors };
  }
}
