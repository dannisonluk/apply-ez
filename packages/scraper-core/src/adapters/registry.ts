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
import { EightfoldAdapter } from './eightfold.adapter.js';
import { PhenomAdapter } from './phenom.adapter.js';

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
  // ── platform adapters ──────────────────────────────────────────────────────
  // These read a site's own public JSON API instead of driving a browser. They
  // are preferred wherever one exists: exact, free, far faster, and they expose
  // fields the rendered DOM never shows — Workday's `endDate` is the real
  // application deadline, and Eightfold's `apply_redirect_url` is the ATS link
  // the apply flow will need.
  //
  // The per-tenant DOM adapters above (`aia`, `manulife`, `hsbc`, `axa`) are
  // superseded by these and are no longer referenced by any target. They are left
  // registered for now rather than deleted; see the README for the audit.
  workday: new WorkdayAdapter(),
  eightfold: new EightfoldAdapter(),
  phenom: new PhenomAdapter(),
};

export function getAdapter(name: string): ScraperAdapter | undefined {
  return adapters[name];
}

export function listAdapters(): string[] {
  return Object.keys(adapters);
}
