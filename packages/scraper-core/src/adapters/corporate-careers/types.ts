import type { JobIngest, JobSectionContent } from '../../types/index.js';

export type Platform = 'pageup' | 'successfactors' | 'towngas' | 'taleo' | 'oracle' | 'eightfold' | 'hsbc' | 'shkp';

export interface CorporateCareersConfig {
  platform?: Platform;
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  maxJobs?: number;
  fullCrawl?: boolean;
  includeDetailPages?: boolean;
  location?: string;
  locale?: string;
  listSelector?: string;
  titleSelector?: string;
  urlSelector?: string;
  locationSelector?: string;
  metaSelector?: string;
  descriptionSelector?: string;
}

export interface ScrapedListItem {
  title: string;
  url: string;
  location?: string;
  meta?: string;
  description?: string;
  postedAt?: string;
  applicationDeadline?: string;
  department?: string;
  workSchedule?: string;
  rawEmploymentType?: string;
  listUrl?: string;
  detailActionSelector?: string;
}

export interface DetailResult {
  description?: string;
  location?: string;
  postedAt?: string;
  requirements?: string;
  sectionContent?: JobSectionContent;
  topMetadata?: JobIngest['topMetadata'];
  department?: string;
  workSchedule?: string;
  applicationDeadline?: string;
  rawEmploymentType?: string;
  url?: string;
}

export type SelectorConfig = Required<Pick<CorporateCareersConfig, 'listSelector' | 'titleSelector' | 'urlSelector'>> &
  Pick<CorporateCareersConfig, 'locationSelector' | 'metaSelector' | 'descriptionSelector'>;
