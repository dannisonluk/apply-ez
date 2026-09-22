import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { config, MISSING_CONFIG_HINT } from '../lib/config';
import { fetchJobs } from '../lib/supabase';
import {
  getCachedJobs,
  getLastOpenedAt,
  setCachedJobs,
  setLastOpenedAt,
} from '../lib/storage';
import { toJobView, type JobRow, type JobView } from '../types';

/**
 * Job list state, shared between the list screen and the tab badge.
 *
 * The "new job" rule, which is the whole point of the app:
 *
 *   new  ==  first_seen_at > lastOpenedAt, where lastOpenedAt is the value read
 *            at the START of this session.
 *
 * Capturing the baseline before updating it is what makes the badge behave: the
 * jobs you are looking at right now stay flagged for this session, and the flag
 * clears the next time you open the app. Using `published_at` instead would be
 * wrong — many careers sites omit it, so the scraper falls back to `now()`, which
 * makes every job look new on every run.
 *
 * On first launch there is no baseline, so nothing is flagged rather than the
 * entire backlog being claimed as new.
 */

export interface JobsState {
  jobs: JobView[];
  /** Jobs that arrived since the previous session. */
  newCount: number;
  /** True only for the very first load, when there is nothing cached to show. */
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastSyncedAt: number | null;
  /** True when the visible list came from disk rather than the network. */
  fromCache: boolean;
  refresh: () => Promise<void>;
}

const JobsContext = createContext<JobsState | null>(null);

export function JobsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [rows, setRows] = useState<JobRow[]>([]);
  const [newSince, setNewSince] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const bootstrapped = useRef(false);

  const load = useCallback(async (options: { silent: boolean }): Promise<void> => {
    if (!options.silent) setRefreshing(true);
    try {
      const fresh = await fetchJobs();
      setRows(fresh);
      setError(null);
      setFromCache(false);
      setLastSyncedAt(Date.now());
      void setCachedJobs(fresh);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      // 1. Capture the baseline BEFORE updating it.
      const previousOpen = await getLastOpenedAt();
      setNewSince(previousOpen);

      // 2. Paint the cache immediately so the list is never blank on a cold start.
      const cached = await getCachedJobs();
      if (cached) {
        setRows(cached.rows);
        setLastSyncedAt(cached.at);
        setFromCache(true);
        setLoading(false);
      }

      // 3. Mark this session as opened. The in-memory baseline above is what the
      //    NEW flags use, so this does not clear them.
      await setLastOpenedAt(Date.now());

      // 4. Refresh from the network. Silent when the cache already painted.
      await load({ silent: cached !== null });
    })();
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    await load({ silent: false });
  }, [load]);

  const jobs = useMemo(() => rows.map((row) => toJobView(row, newSince)), [rows, newSince]);
  const newCount = useMemo(() => jobs.filter((job) => job.isNew).length, [jobs]);

  const value = useMemo<JobsState>(
    () => ({ jobs, newCount, loading, refreshing, error, lastSyncedAt, fromCache, refresh }),
    [jobs, newCount, loading, refreshing, error, lastSyncedAt, fromCache, refresh],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): JobsState {
  const value = useContext(JobsContext);
  if (!value) throw new Error('useJobs must be used inside <JobsProvider>');
  return value;
}

/** Shown instead of an error when the app has not been pointed at a project yet. */
export function useConfigStatus(): { ready: boolean; hint: string | null } {
  return useMemo(
    () => ({ ready: config.isConfigured, hint: config.isConfigured ? null : MISSING_CONFIG_HINT }),
    [],
  );
}
