import type { Page } from 'playwright';
import type { DetailResult, Platform, ScrapedListItem } from './types.js';
import { cleanDetailText, hasStructuredDetail, stripHtmlToText } from './utils.js';
import { extractItemsFromJsonLd } from './extract-list.js';
import { normalizeSectionText, normalizeSectionValue } from '../../types/index.js';

function toSectionBullets(value: string | undefined): string[] | undefined {
  const text = normalizeSectionText(value);
  if (!text) return undefined;
  const bullets = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^(\-|\*|•|\d+[\.\)]|[A-Za-z]\))\s+/, '').trim())
    .filter(Boolean);
  return bullets.length > 0 ? bullets.slice(0, 30) : undefined;
}

function compactBullets(value: Array<string | undefined> | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = normalizeSectionValue(value.filter((item): item is string => typeof item === 'string'));
  return normalized.bullets.length > 0 ? normalized.bullets : undefined;
}

function joinBullets(value: string[] | undefined): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.join('\n');
}

async function extractPageupDetail(page: Page): Promise<DetailResult | undefined> {
  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const joinValues = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
      const joinSections = (sections) => Object.values(sections)
        .flatMap((item) => Array.isArray(item) ? item : typeof item === 'string' ? [item] : [])
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .join('\\n\\n');
      const root = document.querySelector('#job-content');
      if (!root) return null;
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const info = {};
      root.querySelectorAll('#job-detail-info-row .col').forEach((col) => {
        let label = '';
        Array.from(col.childNodes).forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'b') {
            label = text(node).replace(/:$/, '').toLowerCase();
            return;
          }
          if (node.nodeType === Node.ELEMENT_NODE && label) {
            info[label] = text(node);
            label = '';
          }
        });
      });
      const details = root.querySelector('#job-details') || root;
      const sections = {};
      let current = '';
      let stopCollecting = false;
      const nodes = Array.from(details.querySelectorAll('p, li, h2, h3, strong'));
      nodes.forEach((node) => {
        if (stopCollecting) return;
        const nodeText = text(node);
        const strong = node.querySelector('strong');
        const strongText = text(strong);
        const heading = (strongText || nodeText).replace(/:$/, '').toLowerCase();
        if (/^your future work life$/i.test(heading) || /^your future work life$/i.test(nodeText)) {
          stopCollecting = true;
          current = '';
          return;
        }
        if (/^(job summary|main purpose of the job)$/i.test(heading)) {
          current = 'roleIntroduction';
          return;
        } else if (/^(key responsibilities|responsibilities|role and responsibilities|main areas of responsibility|role purpose)$/i.test(heading)) {
          current = 'keyResponsibilities';
          return;
        } else if (/^(qualifications|requirements|qualifications\\s*\\/\\s*requirements)$/i.test(heading)) {
          current = 'requirements';
          return;
        }
        if (!current || !nodeText) return;
        const value = nodeText.replace(strongText, '').replace(/^(job summary|main purpose of the job|key responsibilities|responsibilities|role and responsibilities|main areas of responsibility|role purpose|qualifications|requirements|qualifications\\s*\\/\\s*requirements):?/i, '').trim();
        if (/^your future work life$/i.test(value)) {
          stopCollecting = true;
          current = '';
          return;
        }
        if (!value) return;
        if (!sections[current]) sections[current] = [];
        const target = sections[current];
        if (Array.isArray(target)) target.push(value);
      });
      return {
        description: joinSections(sections),
        location: info.location || undefined,
        department: info.department || undefined,
        workSchedule: info['work type'] || undefined,
        rawEmploymentType: info['work type'] || undefined,
        sectionContent: sections,
        topMetadata: {
          department: info.department || undefined,
          workSchedule: info['work type'] || undefined,
          employmentType: info['work type'] || undefined,
        },
      };
    })()`,
  );
  return detail ?? undefined;
}

async function extractOracleDetail(page: Page): Promise<DetailResult | undefined> {
  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const joinValues = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
      const joinSections = (sections) => Object.values(sections)
        .flatMap((item) => Array.isArray(item) ? item : typeof item === 'string' ? [item] : [])
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .join('\\n\\n');
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const descriptionRoot = document.querySelector('.job-details__description-content.basic-formatter');
      if (!descriptionRoot) return null;
      const sections = {};
      let intro = [];
      Array.from(descriptionRoot.children).forEach((block) => {
        const blockText = text(block);
        if (!blockText) return;
        const heading = text(block.querySelector('strong')).replace(/:$/, '').toLowerCase();
        const items = Array.from(block.querySelectorAll('li')).map(text).filter(Boolean);
        if (/requirements?/.test(heading)) {
          const fallbackRequirement = blockText.replace(/^Requirements:?\\s*/i, '').trim();
          if (items.length) sections.requirements = items;
          else if (fallbackRequirement) sections.requirements = [fallbackRequirement];
          return;
        }
        Array.from(block.querySelectorAll('p')).forEach((paragraph) => {
          const paragraphText = text(paragraph);
          if (paragraphText && !/^(requirements?|key responsibilities):?$/i.test(paragraphText)) intro.push(paragraphText);
        });
        if (items.length) {
          sections.keyResponsibilities = sections.keyResponsibilities ? sections.keyResponsibilities.concat(items) : items;
          return;
        }
        if (!block.querySelector('p')) intro.push(blockText);
      });
      if (intro.length) sections.roleIntroduction = intro.join('\\n');
      if (sections.roleIntroduction) {
        const marker = sections.roleIntroduction.lastIndexOf('Key Responsibilities:');
        if (marker >= 0) sections.roleIntroduction = sections.roleIntroduction.slice(0, marker).trim();
      }
      const meta = {};
      document.querySelectorAll('.job-meta__item').forEach((item) => {
        const key = text(item.querySelector('.job-meta__title')).toLowerCase();
        const value = text(item.querySelector('.job-meta__subitem'));
        if (key && value) meta[key] = value;
      });
      const firstIntro = intro.find((line) => /^join the\\s+/i.test(line)) || '';
      const department = (firstIntro.match(/^join the\\s+(.+?)(?:\\s+team|\\s+department|\\.|,|$)/i) || [])[1];
      return {
        description: joinSections(sections),
        postedAt: meta['posting date'] || undefined,
        applicationDeadline: meta['apply before'] || undefined,
        department: department || undefined,
        requirements: joinValues(sections.requirements).join('\\n') || undefined,
        sectionContent: sections,
        topMetadata: {
          department: department || undefined,
          deadline: meta['apply before'] || undefined,
          applicationDeadline: meta['apply before'] || undefined,
        },
      };
    })()`,
  );
  return detail ?? undefined;
}

async function extractTowngasDetail(page: Page): Promise<DetailResult | undefined> {
  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const joinValues = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
      const joinSections = (sections) => Object.values(sections)
        .flatMap((item) => Array.isArray(item) ? item : typeof item === 'string' ? [item] : [])
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .join('\\n\\n');
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const root =
        document.querySelector('.jobContent, .jobDetailWrapper, .jobDetail, .job-detail, .jobDetails, .job-details, .career-detail, main, article') ||
        document.querySelector('#content, .content');
      if (!root) return null;
      const sections = {};
      function descriptionAfterTitle(titleText) {
        const title = Array.from(root.querySelectorAll('.title')).find((node) => text(node).toLowerCase() === titleText.toLowerCase());
        if (!title) return '';
        let current = title.nextElementSibling;
        while (current && text(current).length === 0) current = current.nextElementSibling;
        if (!current) return '';
        const items = Array.from(current.querySelectorAll('li')).map(text).filter(Boolean);
        if (items.length) return items;
        const children = Array.from(current.children)
          .filter((node) => !node.classList || !node.classList.contains('title'))
          .map(text)
          .filter(Boolean);
        return children.length > 0 ? children : [text(current)].filter(Boolean);
      }
      const responsibilities = descriptionAfterTitle('The Job');
      const requirements = descriptionAfterTitle('The Person');
      if (responsibilities) sections.keyResponsibilities = responsibilities;
      if (requirements) sections.requirements = requirements;
      const deadlineLine = Array.from(document.querySelectorAll('div, span, p'))
        .map(text)
        .find((line) => /Deadline for application:/i.test(line)) || '';
      const deadlineText = deadlineLine || text(document.body);
      const companyMeta = document.querySelector('.jobDetailCompany');
      const postedAt = text(companyMeta && companyMeta.querySelector('.post-date'));
      // Always return whatever was actually found. Previously this returned {}
      // whenever the JD sections did not match, which silently discarded a
      // successfully parsed deadline and posted date on every affected posting.
      const hasSections = Object.keys(sections).length > 0;
      const requirementsText = hasSections ? joinValues(sections.requirements).join('\\n') : '';
      return {
        ...(hasSections ? { description: joinSections(sections) } : {}),
        ...(postedAt ? { postedAt } : {}),
        ...(deadlineText ? { applicationDeadline: deadlineText } : {}),
        ...(requirementsText ? { requirements: requirementsText } : {}),
        ...(hasSections ? { sectionContent: sections } : {}),
        ...(deadlineText
          ? { topMetadata: { deadline: deadlineText, applicationDeadline: deadlineText } }
          : {}),
      };
    })()`,
  );
  if (!detail) return undefined;
  const keyResponsibilities = Array.isArray(detail.sectionContent?.keyResponsibilities)
    ? compactBullets(detail.sectionContent.keyResponsibilities.map((item) => cleanDetailText(item)))
    : toSectionBullets(typeof detail.sectionContent?.keyResponsibilities === 'string' ? detail.sectionContent.keyResponsibilities : undefined);
  const requirements = Array.isArray(detail.sectionContent?.requirements)
    ? compactBullets(detail.sectionContent.requirements.map((item) => cleanDetailText(item)))
    : toSectionBullets(typeof detail.sectionContent?.requirements === 'string' ? detail.sectionContent.requirements : detail.requirements);
  const description = [...(keyResponsibilities ?? []), ...(requirements ?? [])].join('\n\n') || cleanDetailText(detail.description);
  const requirementsText = joinBullets(requirements);
  return {
    ...detail,
    ...(description ? { description } : {}),
    ...(requirementsText ? { requirements: requirementsText } : {}),
    sectionContent: {
      ...(keyResponsibilities ? { keyResponsibilities } : {}),
      ...(requirements ? { requirements } : {}),
    },
  };
}

async function extractSuccessFactorsDetail(page: Page): Promise<DetailResult | undefined> {
  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const joinValues = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
      const joinSections = (sections) => Object.values(sections)
        .flatMap((item) => Array.isArray(item) ? item : typeof item === 'string' ? [item] : [])
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .join('\\n\\n');
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const sections = {};
      let publishedAt = '';
      document.querySelectorAll('[data-careersite-propertyid="date"]').forEach((node) => {
        const value = text(node);
        if (!publishedAt && value) publishedAt = value;
      });
      function listAfterStrong(pattern) {
        const strong = Array.from(document.querySelectorAll('strong')).find((node) => pattern.test(text(node)));
        if (!strong) return '';
        let current = strong.parentElement ? strong.parentElement.nextElementSibling : strong.nextElementSibling;
        for (let i = 0; current && i < 8; i += 1, current = current.nextElementSibling) {
          if (current.querySelector && Array.from(current.querySelectorAll('strong')).some((node) => node !== strong && text(node))) break;
          const list = current.tagName && current.tagName.toLowerCase() === 'ul' ? current : current.querySelector && current.querySelector('ul');
          if (list) {
            const items = Array.from(list.querySelectorAll('li')).map(text).filter(Boolean);
            if (items.length) return items;
          }
        }
        const parentList = strong.parentElement ? strong.parentElement.querySelector('ul') : null;
        return parentList ? Array.from(parentList.querySelectorAll('li')).map(text).filter(Boolean) : [];
      }
      sections.keyResponsibilities = listAfterStrong(/responsibilities/i);
      sections.requirements = listAfterStrong(/successful in this role|must have|requirements/i);
      const deadlineStrong = Array.from(document.querySelectorAll('strong')).find((node) => /applic(?:a|ai)tion deadline/i.test(text(node)));
      let deadline = '';
      if (deadlineStrong) {
        const parentText = text(deadlineStrong.parentElement);
        deadline = parentText.replace(/applic(?:a|ai)tion deadline:?/i, '').trim();
      }
      return {
        description: joinSections(sections).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\\b(Board)or\\b/g, '$1 or'),
        postedAt: publishedAt || undefined,
        applicationDeadline: deadline || undefined,
        requirements: joinValues(sections.requirements).join('\\n').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\\b(Board)or\\b/g, '$1 or') || undefined,
        sectionContent: {
          ...(sections.keyResponsibilities ? { keyResponsibilities: sections.keyResponsibilities } : {}),
          ...(sections.requirements ? { requirements: sections.requirements } : {}),
        },
        topMetadata: {
          deadline: deadline || undefined,
          applicationDeadline: deadline || undefined,
        },
      };
    })()`,
  );
  return detail ?? undefined;
}

async function extractEightfoldDetail(page: Page): Promise<DetailResult | undefined> {
  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const bodyText = text(document.body);
      if (!bodyText) return null;
      const headingPatterns = [
        ['roleIntroduction', /^(firm risk management|background on the position|about the role|team profile)$/i],
        ['keyResponsibilities', /^(primary responsibilities|responsibilities|what you'll do|what you will do)$/i],
        ['requirements', /^(requirements|qualifications|skills required|what we're looking for|what you need)$/i],
      ];
      const sections = {};
      let current = 'roleIntroduction';
      const nodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, strong, b, p, li, div'));
      nodes.forEach((node) => {
        const value = text(node);
        if (!value || value.length > 1200) return;
        const heading = headingPatterns.find(([, pattern]) => pattern.test(value.replace(/:$/, '')));
        if (heading) {
          current = heading[0];
          return;
        }
        if (!current || /^(apply|share|save job)$/i.test(value)) return;
        sections[current] = sections[current] ? sections[current] + '\\n' + value : value;
      });
      const description = Object.values(sections).filter(Boolean).join('\\n\\n') || bodyText;
      return {
        description,
        requirements: sections.requirements || undefined,
        sectionContent: Object.keys(sections).length ? sections : undefined,
      };
    })()`,
  );
  return detail ?? undefined;
}

async function extractHsbcDetail(page: Page): Promise<DetailResult | undefined> {
  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const root = document.querySelector('.custom-jd-container') || document;
      const fields = {};
      Array.from(root.querySelectorAll('.custom-jd-field')).forEach((field) => {
        const label = text(field.querySelector('h1, h2, h3, h4, strong, b'));
        const valueNode = Array.from(field.children).find((child) => !/^H[1-6]$/i.test(child.tagName));
        const value = text(valueNode) || text(field).replace(label, '').trim();
        if (label && value) fields[label.toLowerCase()] = value;
      });
      const read = (...labels) => {
        for (const label of labels) {
          const direct = fields[label.toLowerCase()];
          if (direct) return direct;
        }
        return '';
      };
      const descriptionRoot =
        document.querySelector('.job-description, [class*="job-description"], [data-ph-at-id*="job-description"], .jd-info, main') ||
        document.body;
      const description = text(descriptionRoot);
      const jobType = read('Job Type', 'Employment Type');
      const postedAt = read('Date Posted', 'Posted Date');
      const applicationDeadline = read('Apply By', 'Application Deadline', 'Closing Date');
      return {
        description,
        postedAt: postedAt || undefined,
        applicationDeadline: applicationDeadline || undefined,
        rawEmploymentType: jobType || undefined,
        topMetadata: {
          employmentType: jobType || undefined,
          applicationDeadline: applicationDeadline || undefined,
          deadline: applicationDeadline || undefined,
        },
      };
    })()`,
  );
  return detail ?? undefined;
}

export async function extractTaleoDetail(page: Page, item: ScrapedListItem): Promise<DetailResult | undefined> {
  if (!item.listUrl || !item.detailActionSelector) return undefined;
  await page.goto(item.listUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  const link = page.locator(item.detailActionSelector).first();
  if (!(await link.isVisible().catch(() => false))) return undefined;
  await Promise.all([
    page.waitForURL(/jobdetail\.ftl/i, { timeout: 15_000 }).catch(() => undefined),
    link.click({ timeout: 10_000 }),
  ]);
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

  const detail = await page.evaluate<DetailResult | null>(
    `(() => {
      const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
      const body = document.body;
      if (!body) return null;
      const sections = {};
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, strong, b'));
        function collectAfterHeading(pattern) {
          const heading = headings.find((node) => pattern.test(text(node)));
          if (!heading) return '';
          const items = [];
          let current = heading.parentElement;
          for (let i = 0; current && i < 8; i += 1, current = current.nextElementSibling) {
            const nodes = Array.from(current.querySelectorAll('li'));
            const listItems = nodes.map(text).filter(Boolean);
            if (listItems.length) items.push(...listItems);
            if (i > 0 && headings.some((node) => node !== heading && current && current.contains(node))) break;
          }
        return items.join('\\n');
      }
      const responsibilities = collectAfterHeading(/responsibilit|duties|major activities|job description/i);
      const requirements = collectAfterHeading(/requirement|qualification|experience|knowledge/i);
      if (responsibilities) sections.keyResponsibilities = responsibilities;
      if (requirements) sections.requirements = requirements;
      return {
        url: location.href,
        description: Object.values(sections).filter(Boolean).join('\\n\\n') || '',
        requirements: sections['requirements'] || undefined,
        sectionContent: Object.keys(sections).length ? sections : undefined,
      };
    })()`,
  );
  return detail ?? undefined;
}

export async function extractDetail(page: Page, url: string, platform: Platform): Promise<DetailResult> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: platform === 'successfactors' ? 60_000 : 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

  const platformDetail =
    platform === 'pageup'
      ? await extractPageupDetail(page)
      : platform === 'oracle'
        ? await extractOracleDetail(page)
        : platform === 'towngas'
          ? await extractTowngasDetail(page)
          : platform === 'successfactors'
            ? await extractSuccessFactorsDetail(page)
            : platform === 'eightfold'
              ? await extractEightfoldDetail(page)
              : platform === 'hsbc'
                ? await extractHsbcDetail(page)
                : undefined;

  // Generic page text is the safety net for EVERY platform.
  //
  // Structured extractors return partial data, and return nothing at all whenever
  // the source markup shifts (which is routine for these career sites). Downstream
  // backfill needs the JD body to recover experience / deadline / employment type,
  // so a structured result with no description is merged with the page text rather
  // than returned as-is, and a failed structured extraction falls through to it
  // instead of returning an empty object.
  const readPageText = async (): Promise<string | undefined> => {
    try {
      const html = await page.content();
      const text = stripHtmlToText(html);
      if (!text) return undefined;
      return text.length > 30_000 ? text.slice(0, 30_000) : text;
    } catch {
      return undefined;
    }
  };

  if (platformDetail && hasStructuredDetail(platformDetail)) {
    if (platformDetail.description && platformDetail.description.length > 200) return platformDetail;
    const text = await readPageText();
    return { ...platformDetail, ...(text ? { description: text } : {}) };
  }

  const jsonLdJobs = await extractItemsFromJsonLd(page, url);
  if (jsonLdJobs[0]?.description) {
    const detail: DetailResult = {
      description: jsonLdJobs[0].description,
    };
    if (jsonLdJobs[0].location) detail.location = jsonLdJobs[0].location;
    if (jsonLdJobs[0].postedAt) detail.postedAt = jsonLdJobs[0].postedAt;
    return detail;
  }

  const text = await readPageText();
  return text ? { description: text } : {};
}
