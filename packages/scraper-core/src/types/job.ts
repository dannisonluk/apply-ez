import { z } from 'zod';

/**
 * Vendored job contracts, extracted from `@ineedajob/types`.
 *
 * Only the schemas the scraper actually needs are kept here. The original package
 * also carried district / user / review / salary contracts tied to the 9to6 web
 * product; those are irrelevant to a standalone scraper and were dropped, which
 * also removes the `district.ts` dependency chain.
 */

export const jobSourceSchema = z.enum([
  'JOBSDB',
  'LINKEDIN',
  'GREENHOUSE',
  'LEVER',
  'WORKDAY',
  'COMPANY_WEBSITE',
  'MANUAL',
  'CONTRIBUTOR',
  'HR_POSTED',
]);
export type JobSource = z.infer<typeof jobSourceSchema>;

export const jobStatusSchema = z.enum(['ACTIVE', 'EXPIRED', 'TAKEN_DOWN', 'HIDDEN', 'DRAFT']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobLevelCodeSchema = z.enum([
  'INTERN',
  'ENTRY',
  'JUNIOR',
  'MID',
  'SENIOR',
  'LEAD',
  'MANAGER',
  'DIRECTOR',
  'EXECUTIVE',
]);
export type JobLevelCode = z.infer<typeof jobLevelCodeSchema>;

/**
 * Public employment taxonomy used by job filters.
 *
 * Keep source-specific labels in `rawEmploymentType` when the upstream value is
 * more specific than this product taxonomy.
 */
export const jobEmploymentTypeSchema = z.enum(['PERMANENT', 'CONTRACT', 'INTERNSHIP']);
export type JobEmploymentType = z.infer<typeof jobEmploymentTypeSchema>;

export function normalizeJobEmploymentType(value: unknown): JobEmploymentType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!normalized) return undefined;

  if (
    /\bintern(ship)?\b/.test(normalized) ||
    /\btrainee\b/.test(normalized) ||
    /\bplacement\b/.test(normalized)
  ) {
    return 'INTERNSHIP';
  }

  if (
    /\bcontract(or)?\b/.test(normalized) ||
    /\bfixed term\b/.test(normalized) ||
    /\btemporary\b/.test(normalized) ||
    /\btemp\b/.test(normalized) ||
    /\bfreelance\b/.test(normalized)
  ) {
    return 'CONTRACT';
  }

  if (
    /\bpermanent\b/.test(normalized) ||
    /\bfull time\b/.test(normalized) ||
    /\bfulltime\b/.test(normalized) ||
    /\bregular\b/.test(normalized)
  ) {
    return 'PERMANENT';
  }

  return undefined;
}

export const jobWorkArrangementSchema = z.enum(['ONSITE', 'HYBRID', 'REMOTE', 'UNKNOWN']);
export type JobWorkArrangement = z.infer<typeof jobWorkArrangementSchema>;

export const jobClassificationSchema = z.object({
  seniority: z.string().max(80).optional(),
  jobFunction: z.string().max(120).optional(),
  workArrangement: jobWorkArrangementSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  signals: z.array(z.string().max(120)).max(12).optional(),
});
export type JobClassification = z.infer<typeof jobClassificationSchema>;

export const jobSectionContentSchema = z.object({
  roleIntroduction: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  keyResponsibilities: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  requirements: z.union([z.string(), z.array(z.string())]).nullable().optional(),
});
export type JobSectionContent = z.infer<typeof jobSectionContentSchema>;

/**
 * The posting body as titled sections, for the job detail page.
 *
 * Stored rather than derived on read, because the raw description is deliberately
 * not kept — it is by far the largest field a posting has, and the app only ever
 * renders the parsed form.
 */
export const jobJdBlockSchema = z.union([
  z.object({ kind: z.literal('bullets'), items: z.array(z.string()).min(1).max(24) }),
  z.object({
    kind: z.literal('group'),
    heading: z.string(),
    items: z.array(z.string()).min(1).max(24),
  }),
  z.object({ kind: z.literal('paragraph'), text: z.string() }),
]);

export const jobJdSectionSchema = z.object({
  heading: z.string().nullable(),
  blocks: z.array(jobJdBlockSchema).min(1).max(24),
});
export type JobJdSectionShape = z.infer<typeof jobJdSectionSchema>;

/**
 * Source-specific metadata that is not reliable enough for first-class columns.
 * Frequently queried fields are promoted to Job columns while this object
 * preserves the original scraper context.
 */
export const jobTopMetadataSchema = z.object({
  jobFunction: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
  jobLevel: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  applicationDeadline: z.string().nullable().optional(),
  workSchedule: z.string().nullable().optional(),
  contractType: z.string().nullable().optional(),
  yearsOfExperience: z.string().nullable().optional(),
  remotePolicy: z.string().nullable().optional(),
});
export type JobTopMetadata = z.infer<typeof jobTopMetadataSchema>;

/**
 * Scraper ingest payload — brief job info plus dates.
 *
 * Deep description / requirements / section content are deliberately not part of
 * this contract: the pipeline strips them at the boundary so the ingest payload
 * stays small regardless of what an adapter emits.
 */
export const jobIngestSchema = z.object({
  externalId: z.string().min(1),
  companyName: z.string().min(1),
  companyDomain: z.string().optional(),
  title: z.string().min(1),
  location: z.string().optional(),
  url: z.string().url(),
  applyUrl: z.string().url().optional(),
  source: jobSourceSchema,
  tags: z.array(z.string()).optional(),
  salaryMin: z.number().int().optional(),
  salaryMax: z.number().int().optional(),
  salaryCurrency: z.string().optional(),
  remote: z.boolean().optional(),
  employmentType: z.string().optional(),
  jobLevel: z.string().optional(),
  department: z.string().optional(),
  applicationDeadline: z.string().datetime().optional(),
  workSchedule: z.string().optional(),
  rawEmploymentType: z.string().optional(),
  requiresVisa: z.boolean().optional(),
  experienceMin: z.number().int().min(0).max(60).optional(),
  classification: jobClassificationSchema.optional(),
  /**
   * Relevance scoring (see `lib/relevance.ts`). `relevanceScore` is 0-100 and is
   * the only thing the app filters on — it is a score rather than a boolean so the
   * display threshold can be changed in the app without re-scraping.
   */
  relevanceScore: z.number().int().min(0).max(100).optional(),
  roleFamily: z.string().max(40).optional(),
  filterReason: z.string().max(200).optional(),
  publishedAt: z.string().datetime(),
  topMetadata: jobTopMetadataSchema.optional(),
  /**
   * The posting body as titled sections, built by `buildJdSections` from whatever
   * the adapter had — a named `sectionContent` object or a single `description` blob.
   *
   * `.catch([])` is load-bearing, not decoration. `prepareJobsForIngest` DROPS a job
   * whose schema parse fails, so a strict field here would silently delete postings
   * over a malformed job description. A section that will not validate has to degrade
   * to "no JD shown", never to "job missing".
   */
  jdSections: z.array(jobJdSectionSchema).max(8).catch([]).optional(),
});
export type JobIngest = z.infer<typeof jobIngestSchema>;

export const jobIngestBatchSchema = z.object({
  jobs: z.array(jobIngestSchema).min(1).max(500),
});
export type JobIngestBatch = z.infer<typeof jobIngestBatchSchema>;
