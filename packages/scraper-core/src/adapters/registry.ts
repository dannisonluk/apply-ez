import type { ScraperAdapter } from './adapter.interface.js';
// import { GreenhouseAdapter } from './greenhouse.adapter.js';
// import { LeverAdapter } from './lever.adapter.js';
import { JobsDbAdapter } from './jobsdb.adapter.js';
// import { LinkedInAdapter } from './linkedin.adapter.js';
import { GenericPlaywrightAdapter } from './generic.adapter.js';
import { CathayPacificAdapter } from './cathaypacific.adapter.js';
import { HKJCAdapter } from './hkjc.adapter.js';
import { AIAAdapter } from './aia.adapter.js';
import { AXAAdapter } from './axa.adapter.js';
import { ManulifeAdapter } from './manulife.adapter.js';
import { HSBCAdapter } from './hsbc.adapter.js';
import { CorporateCareersAdapter } from './corporate-careers.adapter.js';
import { WorkdayAdapter } from './workday.adapter.js';

const adapters: Record<string, ScraperAdapter> = {
  cathaypacific: new CathayPacificAdapter(),
  // greenhouse: new GreenhouseAdapter(),
  // lever: new LeverAdapter(),
  jobsdb: new JobsDbAdapter(),
  // linkedin: new LinkedInAdapter(),
  generic: new GenericPlaywrightAdapter(),
  hkjc: new HKJCAdapter(),
  aia: new AIAAdapter(),
  axa: new AXAAdapter(),
  manulife: new ManulifeAdapter(),
  hsbc: new HSBCAdapter(),
  'corporate-careers': new CorporateCareersAdapter(),
  // Reads Workday's public CXS JSON API — no browser. Prefer this over the
  // per-tenant Playwright adapters above for any `*.myworkdayjobs.com` site.
  workday: new WorkdayAdapter(),
};

export function getAdapter(name: string): ScraperAdapter | undefined {
  return adapters[name];
}

export function listAdapters(): string[] {
  return Object.keys(adapters);
}
