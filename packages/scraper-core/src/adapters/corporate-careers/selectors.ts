import type { Platform, SelectorConfig } from './types.js';

export const PLATFORM_SELECTORS: Record<Platform, SelectorConfig> = {
  pageup: {
    listSelector: 'a[href*="/jobs/"], a[href*="/job/"], a[href*="/listing/"], .job-link, .position-title a',
    titleSelector: 'h2, h3, .job-title, .position-title, span, div',
    urlSelector: ':scope',
    locationSelector: '.location, [class*="location"], [data-automation*="location"]',
    metaSelector: '.work-type, .job-info, [class*="employment"], [class*="category"]',
  },
  successfactors: {
    listSelector: 'tr[data-job-id], tr.jobResultItem, .jobResultItem, a.jobTitle-link, a[href*="/job/"]',
    titleSelector: '.jobTitle-link, .jobTitle, a, h3, h2',
    urlSelector: 'a[href]',
    locationSelector: '.jobLocation, .location, [headers*="location"], [class*="location"]',
    metaSelector: '.jobDate, .date, [class*="date"]',
  },
  towngas: {
    listSelector:
      '.jobSearchResultItem[rel], .jobSearchResultItem, a[href*="Job-Details"], a[href*="Job-Detail"], a[href*="JobDetail"], a[href*="job-detail"], .job-listing, .career-listing, .vacancy',
    titleSelector: '.jobSearchResultItemTitle, .job-title, .title, a, h2, h3, :scope',
    urlSelector: 'a[href], :scope',
    locationSelector: '.location, [class*="location"], td:nth-child(2)',
    metaSelector: 'td, .meta, .date',
  },
  taleo: {
    listSelector:
      'tr[id^="requisitionListInterface.ID"][id$=".row"], .job, .jobListJobTitle, a[href*="jobdetail"], a[href*="joblist"]',
    titleSelector: 'a[href*="jobdetail"], a, .jobTitle, .title, h2, h3, :scope',
    urlSelector: 'a[href*="jobdetail"], a[href], :scope',
    locationSelector: '.location, [class*="location"], td:nth-child(3)',
    metaSelector: '.date, [class*="date"], td',
  },
  oracle: {
    listSelector: 'li[data-qa="searchResultItem"], [data-testid*="job"], article, a[href*="/jobs/"], a[href*="/job/"]',
    titleSelector: 'h2, h3, [data-testid*="title"], [data-qa*="title"], a, span, :scope',
    urlSelector: 'a[href]',
    locationSelector: '[data-testid*="location"], .location, [class*="location"]',
    metaSelector: '[data-testid*="date"], .date, [class*="date"]',
    descriptionSelector: '[data-testid*="description"], .description',
  },
  eightfold: {
    listSelector:
      '[data-test-id="job-listing"], .cardContainer-GcY1a[data-test-id="job-listing"], a[href*="/careers/job"], a[href*="pid="], [role="listitem"], .position, .job-card',
    titleSelector: 'h2, h3, [class*="title"], [class*="position"], a, :scope',
    urlSelector: 'a[href], :scope',
    locationSelector: '[class*="location"], [data-testid*="location"]',
    metaSelector: '[class*="employment"], [class*="timestamp"], [class*="date"]',
  },
  hsbc: {
    listSelector:
      '[data-ph-at-id*="job"], [data-ph-at-id*="jobs-list"] li, [data-testid*="job"], [class*="job-card"], [class*="jobCard"], [class*="job-list"] li, a[href*="/careers/job"], a[href*="/job/"]',
    titleSelector:
      '[data-ph-at-id*="job-title"], [data-testid*="title"], [class*="job-title"], [class*="jobTitle"], h2, h3, a, :scope',
    urlSelector: 'a[href*="/careers/job"], a[href*="/job/"], a[href]',
    locationSelector:
      '[data-ph-at-id*="job-location"], [data-testid*="location"], [class*="location"], [class*="job-location"]',
    metaSelector:
      '[data-ph-at-id*="job-category"], [data-ph-at-id*="job-date"], [data-testid*="date"], [class*="category"], [class*="date"], [class*="posted"]',
    descriptionSelector: '[data-ph-at-id*="job-description"], [data-testid*="description"], [class*="description"]',
  },
  shkp: {
    listSelector:
      '.job-vacancy, .jobVacancy, .job-listing, .vacancy, .views-row, .search-result, table tbody tr, a[href*="job-vacancies"], a[href*="job-vacancy"], a[href*="vacancy"]',
    titleSelector:
      '.job-title, .jobTitle, .vacancy-title, .field-title, td:first-child a, td:first-child, h2, h3, a, :scope',
    urlSelector: 'a[href*="job-vacancies"], a[href*="job-vacancy"], a[href*="vacancy"], a[href]',
    locationSelector:
      '.job-location, .location, .field-location, td:nth-child(2), [class*="location"], [class*="joblocat"]',
    metaSelector:
      '.department, .job-type, .date, .field-date, td:nth-child(3), td:nth-child(4), [class*="department"], [class*="date"]',
    descriptionSelector: '.summary, .description, .field-summary, td',
  },
};
