/**
 * Probe robots.txt compliance for every enabled target.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/probe-robots.ts
 *
 * This exists because of a near-miss. The platform adapters originally called
 * bare `fetch`, so they never consulted robots.txt at all. Routing them through
 * `throttledFetch` made them subject to it — and a target whose API path happens
 * to be disallowed would then return zero jobs with no obvious cause. Checking
 * that up front is cheaper than discovering it from an empty run at 04:00.
 *
 * It also reports any declared `crawl-delay`, since that now raises the per-host
 * pacing above the configured floor.
 *
 * Exits non-zero if any URL is disallowed, so it can gate a deploy.
 */
import { enabledTargets, type ScrapeTarget } from '../src/targets.js';
import { parseWorkdayUrl } from '../src/adapters/workday.adapter.js';
import { parseEightfoldUrl } from '../src/adapters/eightfold.adapter.js';
import { parsePhenomUrl } from '../src/adapters/phenom.adapter.js';
import { robotsPolicyFor } from '../src/lib/rate-limit.js';

interface ProbeUrl {
  label: string;
  url: string;
}

/**
 * Reconstruct the URLs each adapter will actually fetch.
 *
 * Detail-stage URLs are synthesised, because the real ones are only discoverable
 * by crawling first. That is sound for this purpose: robots.txt rules match on
 * path prefixes, so a placeholder path segment exercises exactly the same rules
 * as a real one.
 */
function probeUrls(target: ScrapeTarget): ProbeUrl[] {
  const entry = target.entryUrls[0] ?? '';
  switch (target.adapter) {
    case 'workday': {
      const endpoint = parseWorkdayUrl(entry);
      if (!endpoint) return [{ label: 'entry (unparsed)', url: entry }];
      return [
        { label: 'listing POST', url: `${endpoint.cxs}/jobs` },
        { label: 'detail GET', url: `${endpoint.cxs}/job/EXAMPLE/JR-00000` },
      ];
    }
    case 'eightfold': {
      const domain = typeof target.config.companyDomain === 'string' ? target.config.companyDomain : undefined;
      const endpoint = parseEightfoldUrl(entry, domain);
      if (!endpoint) return [{ label: 'entry (unparsed)', url: entry }];
      const listing = new URLSearchParams({ domain: endpoint.domain, hl: endpoint.hl });
      if (endpoint.location) listing.set('location', endpoint.location);
      const detail = new URLSearchParams({ domain: endpoint.domain, hl: endpoint.hl });
      return [
        { label: 'listing GET', url: `${endpoint.apiBase}?${listing.toString()}` },
        { label: 'detail GET', url: `${endpoint.apiBase}/12345?${detail.toString()}` },
      ];
    }
    case 'phenom': {
      const endpoint = parsePhenomUrl(entry);
      if (!endpoint) return [{ label: 'entry (unparsed)', url: entry }];
      const location = typeof target.config.location === 'string' ? target.config.location : endpoint.location;
      const params = new URLSearchParams({ page: '1', limit: '25', internal: 'false' });
      if (location) params.set('location', location);
      return [{ label: 'listing GET', url: `${endpoint.origin}/api/jobs?${params.toString()}` }];
    }
    default:
      return target.entryUrls.map((url, index) => ({ label: `entry ${index + 1}`, url }));
  }
}

async function main(): Promise<void> {
  const targets = enabledTargets();
  console.log(`robots.txt probe — ${targets.length} enabled targets\n`);

  let disallowed = 0;
  let slowed = 0;

  for (const target of targets) {
    console.log(`${target.id}  [${target.adapter}]`);
    for (const probe of probeUrls(target)) {
      const policy = await robotsPolicyFor(probe.url);
      if (!policy.allowed) disallowed += 1;
      if (policy.crawlDelayMs !== undefined) slowed += 1;

      const verdict = policy.allowed ? 'allow' : 'DISALLOW';
      const delay = policy.crawlDelayMs === undefined ? '—' : `${policy.crawlDelayMs}ms`;
      const note = policy.available ? '' : '   (robots.txt unavailable — fail-open)';
      console.log(`   ${verdict.padEnd(9)} crawl-delay=${delay.padEnd(7)} ${probe.label}${note}`);
      console.log(`   ${' '.repeat(9)} ${probe.url}`);
    }
    console.log();
  }

  console.log(`${disallowed} disallowed URL(s), ${slowed} URL(s) under a declared crawl-delay`);
  process.exit(disallowed === 0 ? 0 : 1);
}

main();
