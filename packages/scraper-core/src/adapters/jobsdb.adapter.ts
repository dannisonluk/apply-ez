import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ScraperAdapter, ScrapeContext, ScrapeResult, RawJob } from './adapter.interface.js';
import {
  isAllowedByRobots,
  robotsDisallowedScrapeError,
  robotsDisallowedScrapeErrorFromUnknown,
  scraperUserAgent,
  throttledFetch,
} from '../lib/rate-limit.js';

// JobsDB HK — requires browser (heavily JS-rendered).
// This is a skeleton. Real selectors must be tuned against current JobsDB DOM.
export class JobsDbAdapter implements ScraperAdapter {
  readonly name = 'jobsdb';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const { urlTemplate, config, logger } = ctx;
    if (!urlTemplate) {
      return { jobs: [], errors: [{ message: 'JobsDB adapter requires target.urlTemplate' }] };
    }
    const query = typeof config.query === 'string' ? config.query : 'software';
    const maxPages = typeof config.pages === 'number' ? config.pages : 3;

    const jobs: RawJob[] = [];
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        userAgent: scraperUserAgent(),
        viewport: { width: 1280, height: 800 },
      });

      for (let page = 1; page <= maxPages; page += 1) {
        const url = urlTemplate.replace('{query}', encodeURIComponent(query)).replace('{page}', String(page));
        logger.info(`JobsDB page ${page}: ${url}`);

        if (!(await isAllowedByRobots(url))) {
          errors.push(robotsDisallowedScrapeError(url, { page }));
          continue;
        }

        const p = await context.newPage();
        try {
          await throttledFetch(url, async () => {
            await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await p.waitForSelector('[data-testid="job-card"]', { timeout: 15_000 }).catch(() => {});
          });

          const cards = await p.$$eval('[data-testid="job-card"]', (nodes) =>
            nodes.map((node) => {
              const get = (sel: string): string => node.querySelector(sel)?.textContent?.trim() ?? '';
              const link = node.querySelector('a')?.getAttribute('href') ?? '';
              return {
                title: get('[data-testid="job-title"]'),
                company: get('[data-testid="company-name"]'),
                location: get('[data-testid="job-location"]'),
                description: get('[data-testid="job-description"]'),
                url: link,
              };
            }),
          );

          for (const c of cards) {
            if (!c.url || !c.title) continue;
            const externalId = c.url.split('/').pop()?.split('?')[0] ?? c.url;
            jobs.push({
              externalId,
              companyName: c.company || 'Unknown',
              title: c.title,
              location: c.location || 'Hong Kong',
              description: c.description || '',
              url: c.url.startsWith('http') ? c.url : `https://hk.jobsdb.com${c.url}`,
              source: 'JOBSDB',
              salaryCurrency: 'HKD',
              publishedAt: new Date().toISOString(), // JobsDB doesn't always expose publishedAt in card
            });
          }
        } catch (pageErr) {
          const robotsError = robotsDisallowedScrapeErrorFromUnknown(pageErr, { page });
          errors.push(robotsError ?? { message: `page ${page}: ${String(pageErr)}`, context: { page } });
        } finally {
          await p.close().catch(() => {});
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
