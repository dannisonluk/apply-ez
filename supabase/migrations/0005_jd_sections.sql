-- Store the posting body as titled sections, for the job detail page.
--
-- Until now the detail page could only show `summary`, a single paragraph, because
-- the ingest boundary deliberately dropped the deep-content fields. What a job board
-- actually shows is the employer's own headings with bullets underneath, and that is
-- what this column carries.
--
-- The raw `description` is deliberately NOT kept alongside it. It is by far the
-- largest field a posting has, and nothing reads it once it has been parsed —
-- storing both would roughly double the table for a column with no reader. The
-- scraper parses at ingest time (`buildJdSections` in `types/section-content.ts`)
-- and stores only the result.
--
-- Shape:
--   [ { "heading": "Requirements" | null,
--       "blocks": [ ... ] } ]
-- where a block is exactly one of
--   { "kind": "paragraph", "text": "..." }
--   { "kind": "bullets",   "items": [ "...", "..." ] }
--   { "kind": "group",     "heading": "...", "items": [ "...", "..." ] }
--
-- Defaults to '[]' rather than null so the app has one shape to render and never has
-- to tell "no JD" apart from "not fetched yet".

alter table public.jobs
  add column if not exists jd_sections jsonb not null default '[]'::jsonb;

comment on column public.jobs.jd_sections is
  'Posting body split into titled sections for the detail page. Parsed at ingest from the adapter''s sectionContent or description; the raw description is not retained. Empty until a crawl refetches the posting detail.';
