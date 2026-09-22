/**
 * Cathay adapter data contracts.
 *
 * Keep these types close to the adapter because they model Cathay-specific
 * source fields, not the canonical job DTO used by the rest of the platform.
 */
export interface CathayConfig {
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  fullCrawl?: boolean;
  pageParam?: string;
  pageStartAt?: number;
  includeDetailPages?: boolean;
  maxDetailJobs?: number;
  forceHttp?: boolean;
  sitemapMaxJobs?: number;
  startUrl?: string;
  entryUrls?: string[];
}

export interface CathaySectionContent {
  keyResponsibilities?: string | null;
  requirements?: string | null;
}

export interface CathayTopMetadata {
  jobFunction?: string | null;
  department?: string | null;
  employmentType?: string | null;
  jobLevel?: string | null;
  country?: string | null;
  deadline?: string | null;
}

export interface ParsedCathayDetail {
  title: string;
  location: string | undefined;
  description: string;
  requirements: string | undefined;
  applyUrl: string | undefined;
  sectionContent: CathaySectionContent;
  topMetadata: CathayTopMetadata;
}
