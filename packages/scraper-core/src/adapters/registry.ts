import type { ScraperAdapter } from './adapter.interface.js';
// import { GreenhouseAdapter } from './greenhouse.adapter.js';
// import { LeverAdapter } from './lever.adapter.js';
import { JobsDbAdapter } from './jobsdb.adapter.js';
// import { LinkedInAdapter } from './linkedin.adapter.js';
import { GenericPlaywrightAdapter } from './generic.adapter.js';
import { CathayPacificAdapter } from './cathaypacific.adapter.js';
import { HKJCAdapter } from './hkjc.adapter.js';
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
  'corporate-careers': new CorporateCareersAdapter(),
  // ── platform adapters ──────────────────────────────────────────────────────
  // These read a site's own public JSON API instead of driving a browser. They
  // are preferred wherever one exists: exact, free, far faster, and they expose
  // fields the rendered DOM never shows — Workday's `endDate` is the real
  // application deadline, and Eightfold's `apply_redirect_url` is the ATS link
  // the apply flow will need.
  //
  // The per-tenant DOM adapters these replaced (`aia`, `manulife`, `hsbc`, `axa`)
  // are deleted rather than kept as a fallback. A Playwright fallback for a tenant
  // with a working API is not a safety net: it is a second code path nobody
  // exercises, reading the same data less accurately, that would silently take
  // over on any parse failure. The per-tenant quirks they encoded are still in
  // git history if an API ever changes shape.
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
