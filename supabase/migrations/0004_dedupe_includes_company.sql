-- Make job uniqueness include the company.
--
-- `0001_init.sql` declared `unique (source, external_id)`, which reads as though it
-- were scoped per source. It is not. The scraper sends the literal
-- `source = 'COMPANY_WEBSITE'` for all twelve of its targets (see `JOB_SOURCE` in
-- `packages/scraper-core/src/cli.ts`), so the key was effectively `external_id`
-- alone — with no company in it at all. A live check confirms the table has exactly
-- one distinct `source` value.
--
-- That matters because employers share ATS platforms. AIA and Manulife both run
-- Workday; HSBC and Morgan Stanley both run Eightfold. Requisition ids are issued
-- per tenant, so two employers can legitimately produce the same id — and on a
-- collision the scraper's upsert would merge two different employers' postings into
-- one row, the later silently taking over the earlier one's company_id, title and
-- url. Nothing is broken today (no collisions exist across the 751 rows), so this
-- migration tightens the constraint without repairing any data.

-- Fail loudly rather than silently discarding rows if a collision does exist.
-- `add constraint` would reject duplicates anyway; naming them turns a bare 23505
-- into something diagnosable.
do $$
declare
  offenders text;
begin
  select string_agg(dupes.external_id, ', ' order by dupes.external_id)
    into offenders
  from (
    select external_id
    from public.jobs
    group by company_id, source, external_id
    having count(*) > 1
  ) as dupes;

  if offenders is not null then
    raise exception 'jobs has duplicate (company_id, source, external_id) rows: %', offenders;
  end if;
end
$$;

alter table public.jobs
  drop constraint if exists jobs_source_external_id_key;

alter table public.jobs
  add constraint jobs_company_source_external_id_key
  unique (company_id, source, external_id);
