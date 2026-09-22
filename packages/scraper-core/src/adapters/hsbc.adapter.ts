import type { ScraperAdapter, ScrapeContext, ScrapeResult } from './adapter.interface.js';
import { CorporateCareersAdapter } from './corporate-careers.adapter.js';

interface HSBCConfig {
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  maxJobs?: number;
  fullCrawl?: boolean;
  includeDetailPages?: boolean;
  locale?: string;
}

const DEFAULT_URL = 'https://portal.careers.hsbc.com/careers?location=Hong+Kong&hl=en';
const corporateCareers = new CorporateCareersAdapter();

export class HSBCAdapter implements ScraperAdapter {
  readonly name = 'hsbc';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as HSBCConfig) ?? {};

    return corporateCareers.scrape({
      ...ctx,
      urlTemplate: ctx.urlTemplate || DEFAULT_URL,
      entryUrls: ctx.entryUrls?.length ? ctx.entryUrls : undefined,
      config: {
        ...cfg,
        platform: 'hsbc',
        companyName: cfg.companyName ?? 'HSBC',
        companyDomain: cfg.companyDomain ?? 'hsbc.com',
      },
    });
  }
}
