import type { Page } from 'playwright';
import type { ScrapedListItem, SelectorConfig } from './types.js';
import { looksLikeJobTitle, normalizeText, normalizeTowngasUrl, stripHtmlToText, toAbsoluteUrl } from './utils.js';

export async function extractItemsFromDom(
  page: Page,
  selectorConfig: SelectorConfig,
  baseUrl: string,
): Promise<ScrapedListItem[]> {
  const items = await page.evaluate<ScrapedListItem[], void>(
    `(() => {
      const cfg = ${JSON.stringify(selectorConfig)};
      const nodes = Array.from(document.querySelectorAll(cfg.listSelector));
      function textFrom(node) {
        return (node && node.textContent ? node.textContent : '').replace(/\\s+/g, ' ').trim();
      }
      function slugSegment(value) {
        return String(value || '')
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 120);
      }
      function attrFrom(node) {
        if (!node || !node.getAttribute) return '';
        return (
          node.getAttribute('href') ||
          node.getAttribute('data-job-url') ||
          node.getAttribute('data-apply-url') ||
          node.getAttribute('rel') ||
          node.getAttribute('data-url') ||
          node.getAttribute('data-href') ||
          node.getAttribute('data-link') ||
          node.getAttribute('data-path') ||
          ''
        );
      }
      function selectorWithoutScope(selector) {
        return String(selector || '')
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && part !== ':scope')
          .join(', ');
      }

      return nodes.map((node) => {
        const explicitUrlSelector = selectorWithoutScope(cfg.urlSelector);
        const explicitTitleSelector = selectorWithoutScope(cfg.titleSelector);
        const link =
          explicitUrlSelector && node.matches(explicitUrlSelector)
            ? node
            : explicitUrlSelector
              ? node.querySelector(explicitUrlSelector)
              : null;
        const titleNode =
          explicitTitleSelector && node.matches(explicitTitleSelector)
            ? node
            : explicitTitleSelector
              ? node.querySelector(explicitTitleSelector)
              : null;
        const title = textFrom(titleNode);
        const rawUrl = attrFrom(link) || attrFrom(node) || (title ? '#' + slugSegment(title) : '');
        return {
          title: title || textFrom(node),
          url: rawUrl,
          location: cfg.locationSelector ? textFrom(node.querySelector(cfg.locationSelector)) : '',
          meta: cfg.metaSelector ? textFrom(node.querySelector(cfg.metaSelector)) : '',
          description: cfg.descriptionSelector ? textFrom(node.querySelector(cfg.descriptionSelector)) : '',
        };
      });
    })()`,
    undefined,
  );
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      ...item,
      title: normalizeText(item.title),
      url: item.url ? toAbsoluteUrl(item.url, baseUrl) : '',
      location: normalizeText(item.location),
      meta: normalizeText(item.meta),
      description: normalizeText(item.description),
    }))
    .filter((item) => looksLikeJobTitle(item.title) && item.url.startsWith('http'));
}

export async function extractTowngasItemsFromDom(page: Page, baseUrl: string): Promise<ScrapedListItem[]> {
  const cleanTitle = (value: string): string => {
    const withoutMeta = value
      .replace(/The HK and China Gas Co(?:mpany)? Ltd.*$/i, '')
      .replace(/Posted on:.*$/i, '')
      .trim();
    const half = Math.floor(withoutMeta.length / 2);
    if (withoutMeta.length % 2 === 0 && withoutMeta.slice(0, half) === withoutMeta.slice(half)) {
      return withoutMeta.slice(0, half).trim();
    }
    const doubled = withoutMeta.match(/^(.+?)\1/i);
    return (doubled?.[1] ?? withoutMeta).trim();
  };

  const items: ScrapedListItem[] = [];
  const nodes = page.locator('.jobSearchResultItem[rel], .jobSearchResultItem');
  const count = await nodes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const node = nodes.nth(index);
    const rawText = normalizeText(await node.textContent().catch(() => ''));
    const rawUrl = normalizeText((await node.getAttribute('rel').catch(() => null)) ?? (await node.getAttribute('href').catch(() => null)));
    const title = cleanTitle(rawText);
    const postedAt = rawText.match(/Posted on:\s*([0-9-]+)/i)?.[1] ?? '';
    const url = rawUrl ? normalizeTowngasUrl(rawUrl, baseUrl) : '';
    if (!title || !url.startsWith('http')) continue;
    items.push({
      title,
      url,
      location: 'Hong Kong',
      postedAt,
      description: title,
    });
  }
  return items;
}

export async function extractShkpItemsFromDom(page: Page, baseUrl: string): Promise<ScrapedListItem[]> {
  const items = await page.evaluate<ScrapedListItem[], void>(
    `(() => {
      const baseUrl = ${JSON.stringify(baseUrl)};
      const seen = new Set();
      function textFrom(node) {
        return (node && node.textContent ? node.textContent : '').replace(/\\s+/g, ' ').trim();
      }
      function absolute(raw) {
        try {
          return raw ? new URL(raw, baseUrl).toString() : '';
        } catch {
          return '';
        }
      }
      function add(job) {
        if (!job || !job.title || !job.url) return;
        const key = job.title + '|' + job.url;
        if (seen.has(key)) return;
        seen.add(key);
        jobs.push(job);
      }
      function fieldFromRowText(text, labels) {
        for (const label of labels) {
          const pattern = new RegExp(label + '\\\\s*[:：]?\\\\s*([^|\\\\n]+)', 'i');
          const match = text.match(pattern);
          if (match && match[1]) return match[1].trim();
        }
        return '';
      }
      const jobs = [];
      const root = document.getElementById('accorJobs') || document.querySelector('.accordion-group.accordion-collapse-mobile-ctn');
      if (!root) return jobs;
      const desktopRows = Array.from(root.querySelectorAll('.hidden-xs.fake-table-row'));
      for (const row of desktopRows) {
        const values = Array.from(row.querySelectorAll('.fake-item'));
        const rowText = textFrom(row);
        const location =
          textFrom(row.querySelector('.item-region')) ||
          fieldFromRowText(rowText, ['Location', 'Region']) ||
          'Hong Kong';
        const department =
          textFrom(values.find((node) => node.classList.contains('jobs-category') && !node.classList.contains('item-region'))) ||
          textFrom(row.querySelector('.jobs-category:not(.item-region)')) ||
          fieldFromRowText(rowText, ['Department', 'Category']);
        const links = Array.from(row.querySelectorAll('.jobs-list a[href]'));
        for (const link of links) {
          const title = textFrom(link) || link.getAttribute('title') || '';
          const url = absolute(link.getAttribute('href') || '');
          if (!title || !url) continue;
          add({
            title,
            url,
            location,
            department,
            description: department ? title + ' - ' + department : title,
          });
        }
      }
      const mobilePanels = Array.from(root.querySelectorAll('.panel.panel-default.visible-xs'));
      for (const panel of mobilePanels) {
        const category = textFrom(panel.querySelector('.panel-heading .collapse-ctrl'));
        const rowText = textFrom(panel);
        const location = fieldFromRowText(rowText, ['Location', 'Region']) || 'Hong Kong';
        const links = Array.from(panel.querySelectorAll('.accordion-content .jobs-list a[href]'));
        for (const link of links) {
          const title = textFrom(link) || link.getAttribute('title') || '';
          const url = absolute(link.getAttribute('href') || '');
          if (!title || !url) continue;
          add({
            title,
            url,
            location,
            department: category,
            description: category ? title + ' - ' + category : title,
          });
        }
      }
      return jobs;
    })()`,
    undefined,
  );
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      ...item,
      title: normalizeText(item.title),
      url: item.url ? toAbsoluteUrl(item.url, baseUrl) : '',
      location: normalizeText(item.location) || 'Hong Kong',
      department: normalizeText(item.department),
      description: normalizeText(item.description),
    }))
    .filter((item) => looksLikeJobTitle(item.title) && item.url.startsWith('http'));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function titleCaseSlug(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' / ');
}

export function extractShkpItemsFromHtml(html: string, baseUrl: string): ScrapedListItem[] {
  const items: ScrapedListItem[] = [];
  const seen = new Set<string>();
  const linkPattern = /<a\b[^>]*href=(["'])([^"']*\/job-vacancies\/[^"']+\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) !== null) {
    const rawHref = match[2] ?? '';
    const rawTitle = match[3] ?? '';
    const href = decodeHtmlEntities(rawHref);
    const title = normalizeText(decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, ' ')));
    if (!title) continue;

    const url = toAbsoluteUrl(href, baseUrl);
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return '';
      }
    })();
    const categorySlug = path.match(/\/job-vacancies\/([^/]+)\//i)?.[1] ?? '';
    const department = titleCaseSlug(categorySlug);
    const key = `${title}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title,
      url,
      location: 'Hong Kong',
      department,
      description: department ? `${title} - ${department}` : title,
    });
  }

  return items.filter((item) => looksLikeJobTitle(item.title) && item.url.startsWith('http'));
}

interface ShkpListJsonItem {
  region?: unknown;
  category?: unknown;
  country?: unknown;
  link?: unknown;
  langcode?: unknown;
  title?: unknown;
}

function stringFromJson(value: unknown): string {
  return typeof value === 'string' ? normalizeText(stripHtmlToText(value)) : '';
}

export function extractShkpItemsFromJson(payload: unknown, baseUrl: string): ScrapedListItem[] {
  if (!Array.isArray(payload)) return [];

  const items: ScrapedListItem[] = [];
  const seen = new Set<string>();

  for (const value of payload as ShkpListJsonItem[]) {
    const title = stringFromJson(value.title);
    const directLink = typeof value.link === 'string' ? value.link : '';
    const langcode = typeof value.langcode === 'string' ? value.langcode : '';
    const linkFromLangcode = langcode.match(/\bhref=(["'])(.*?)\1/i)?.[2] ?? '';
    const rawUrl = directLink || decodeHtmlEntities(linkFromLangcode);
    if (!title || !rawUrl) continue;

    const url = toAbsoluteUrl(decodeHtmlEntities(rawUrl), baseUrl);
    const location = stringFromJson(value.region) || stringFromJson(value.country) || 'Hong Kong';
    const department = stringFromJson(value.category);
    const key = `${title}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title,
      url,
      location,
      department,
      description: department ? `${title} - ${department}` : title,
    });
  }

  return items.filter((item) => looksLikeJobTitle(item.title) && item.url.startsWith('http'));
}

export async function extractMtrItemsFromDom(page: Page, baseUrl: string): Promise<ScrapedListItem[]> {
  const items = await page.evaluate<ScrapedListItem[]>(
    `(() => {
      const base = ${JSON.stringify(baseUrl)};
      const textFrom = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const field = (text, label, nextLabels) => {
        const start = text.indexOf(label);
        if (start < 0) return '';
        let value = text.slice(start + label.length);
        for (const next of nextLabels) {
          const nextIndex = value.indexOf(next);
          if (nextIndex >= 0) value = value.slice(0, nextIndex);
        }
        return value.trim();
      };
      const attrSelector = (id) => (id ? '[id="' + id.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]' : '');
      return Array.from(
        document.querySelectorAll('a[onclick*="requisition_openRequisitionDescription"], h2 .titlelink a, a[id*="reqTitleLinkAction"]'),
      )
        .map((link) => {
          const row = link.closest('tr') || link.closest('li') || link.parentElement || link;
          const title = textFrom(link);
          const rowText = textFrom(row);
          const url = new URL('jobdetail.ftl', base);
          return {
            title,
            url: url.toString(),
            listUrl: base,
            detailActionSelector: attrSelector(link.id || ''),
            location: field(rowText, 'Work Location(s):', ['Schedule:', 'Job Posting:', 'Closing Date:']),
            rawEmploymentType: field(rowText, 'Schedule:', ['Job Posting:', 'Closing Date:']),
            workSchedule: field(rowText, 'Schedule:', ['Job Posting:', 'Closing Date:']),
            postedAt: field(rowText, 'Job Posting:', ['Closing Date:']),
            applicationDeadline: field(rowText, 'Closing Date:', []),
            description: title,
          };
        })
        .filter((item) => item.title && /\\(Ref:\\s*[A-Za-z0-9]+\\)/i.test(item.title));
    })()`,
  );
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is ScrapedListItem => Boolean(item && item.title && item.url))
    .map((item) => ({
      ...item,
      title: normalizeText(item.title),
      location: normalizeText(item.location),
      description: normalizeText(item.description),
    }));
}

export async function extractItemsFromJsonLd(page: Page, baseUrl: string): Promise<ScrapedListItem[]> {
  const rawItems = await page.evaluate<string[], void>(
    `(() => Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((node) => node.textContent ?? '').filter(Boolean))()`,
    undefined,
  );
  if (!Array.isArray(rawItems)) return [];
  const jobs: ScrapedListItem[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record['@graph']) visit(record['@graph']);

    const rawType = record['@type'];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (types.some((item) => String(item).toLowerCase() === 'jobposting')) {
      const title = typeof record.title === 'string' ? record.title : '';
      const url = typeof record.url === 'string' ? record.url : baseUrl;
      const locationValue = record.jobLocation;
      let location = 'Hong Kong';
      if (Array.isArray(locationValue) && locationValue[0] && typeof locationValue[0] === 'object') {
        const address = (locationValue[0] as Record<string, unknown>).address;
        location =
          typeof address === 'object' && address
            ? Object.values(address as Record<string, unknown>).filter(Boolean).join(', ')
            : 'Hong Kong';
      }
      const item: ScrapedListItem = {
        title,
        url: toAbsoluteUrl(url, baseUrl),
        location,
      };
      if (typeof record.description === 'string') item.description = stripHtmlToText(record.description);
      if (typeof record.datePosted === 'string') item.postedAt = record.datePosted;
      jobs.push(item);
    }
  };

  for (const raw of rawItems) {
    try {
      visit(JSON.parse(raw) as unknown);
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  return jobs.filter((job) => looksLikeJobTitle(job.title));
}

export async function extractItemsFromEmbeddedJson(page: Page, baseUrl: string): Promise<ScrapedListItem[]> {
  const rawItems = await page.evaluate<ScrapedListItem[], void>(
    `(() => {
      const baseUrl = ${JSON.stringify(baseUrl)};
      const jobs = [];
      const seen = new Set();
      function text(value) {
        return typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';
      }
      function absolute(raw) {
        const value = text(raw);
        if (!value) return '';
        try {
          return new URL(value, baseUrl).toString();
        } catch {
          return '';
        }
      }
      function slug(value) {
        return text(value)
          .toLowerCase()
          .replace(/[^a-z0-9\\u3400-\\u9fff]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 120);
      }
      function pick(obj, keys) {
        for (const key of keys) {
          const value = obj[key];
          if (typeof value === 'string' && value.trim()) return value;
        }
        return '';
      }
      function visit(value, depth) {
        if (!value || depth > 8) return;
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, depth + 1));
          return;
        }
        if (typeof value !== 'object') return;
        const obj = value;
        const title = pick(obj, ['title', 'jobTitle', 'job_title', 'name', 'positionTitle', 'requisitionTitle']);
        const rawUrl = pick(obj, ['url', 'jobUrl', 'job_url', 'applyUrl', 'applyURL', 'externalPath', 'canonicalUrl']);
        const id = pick(obj, ['id', 'jobId', 'jobID', 'reqId', 'requisitionId', 'referenceNumber']);
        const location = pick(obj, ['location', 'jobLocation', 'city', 'country']);
        const description = pick(obj, ['description', 'summary', 'jobDescription']);
        if (title && (rawUrl || id)) {
          const url = absolute(rawUrl) || (id ? new URL('#' + encodeURIComponent(slug(id || title)), baseUrl).toString() : '');
          const key = title + '|' + url;
          if (url && !seen.has(key)) {
            seen.add(key);
            jobs.push({
              title,
              url,
              location,
              description,
              meta: pick(obj, ['department', 'category', 'jobType', 'employmentType', 'postedDate', 'datePosted']),
              postedAt: pick(obj, ['postedDate', 'datePosted', 'createdDate']),
            });
          }
        }
        Object.values(obj).forEach((item) => visit(item, depth + 1));
      }
      Array.from(document.querySelectorAll('script'))
        .map((node) => node.textContent || '')
        .filter((value) => value.trim().startsWith('{') || value.trim().startsWith('['))
        .forEach((raw) => {
          try {
            visit(JSON.parse(raw), 0);
          } catch {
          }
        });
      return jobs;
    })()`,
    undefined,
  );
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => ({
      ...item,
      title: normalizeText(item.title),
      url: item.url ? toAbsoluteUrl(item.url, baseUrl) : '',
      location: normalizeText(item.location),
      meta: normalizeText(item.meta),
      description: normalizeText(item.description),
      postedAt: normalizeText(item.postedAt),
    }))
    .filter((item) => looksLikeJobTitle(item.title) && item.url.startsWith('http'));
}
