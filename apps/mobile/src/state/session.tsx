import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { clearStoredUnlockCode, getStoredUnlockCode, setStoredUnlockCode } from '../lib/codes';
import {
  fetchApplications,
  recordApplication,
  verifyUnlockCode,
} from '../lib/supabase';
import type { AppliedJob } from '../types';

/**
 * The two-code application gate.
 *
 * Two separate codes, because they answer two different questions:
 *
 *   UNLOCK_APPLICATION_CODE      "is this me?"  — opens the application area and
 *                                authorises reading the application history.
 *   BEFORE_APPLICATION_CODE      "are you sure?" — required on every single submit.
 *                                Deliberate friction, so a stray tap can never file
 *                                a real application.
 *
 * Neither code lives in the app bundle. Both are stored as bcrypt hashes in
 * Supabase and verified inside SECURITY DEFINER functions, so verification requires
 * the network and a stolen APK yields nothing.
 *
 * The unlock code is remembered in the OS keystore so it is typed once per install
 * rather than once per launch; `lock()` forgets it again.
 */

export interface SessionState {
  /** True once the unlock code has been verified (this session or a stored one). */
  unlocked: boolean;
  /** True while a stored code is being re-verified on launch. */
  restoring: boolean;
  /** The unlock code, needed by the history RPC. Null while locked. */
  code: string | null;
  /** Verify and remember a code. Returns false when it is wrong. */
  unlock: (candidate: string) => Promise<boolean>;
  /** Forget the code and drop everything it authorised. */
  lock: () => Promise<void>;

  applications: AppliedJob[];
  /** Ids of jobs already applied to, for the "Applied" badge on the list. */
  appliedJobIds: Set<string>;
  loadingApplications: boolean;
  applicationsError: string | null;
  refreshApplications: () => Promise<void>;

  /**
   * Record one application. Requires the BEFORE_APPLICATION code.
   * Throws a `RestError` whose `isCodeRejection` is true for a wrong code.
   */
  record: (input: {
    jobId: string;
    beforeApplyCode: string;
    resumeKey?: string | undefined;
    notes?: string | undefined;
  }) => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [code, setCode] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [applications, setApplications] = useState<AppliedJob[]>([]);
  const [loadingApplications, setLoadingApplications] = useState(false);
  const [applicationsError, setApplicationsError] = useState<string | null>(null);

  const loadApplications = useCallback(async (unlockCode: string): Promise<void> => {
    setLoadingApplications(true);
    try {
      const rows = await fetchApplications(unlockCode);
      setApplications(rows);
      setApplicationsError(null);
    } catch (caught) {
      setApplicationsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingApplications(false);
    }
  }, []);

  // On launch, re-verify any remembered code. The stored value is treated as a
  // candidate, not as proof: if it no longer works (the code was rotated on the
  // server) it is discarded rather than leaving the app half-unlocked.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const stored = await getStoredUnlockCode();
      if (!stored) {
        if (!cancelled) setRestoring(false);
        return;
      }

      let valid = false;
      try {
        valid = await verifyUnlockCode(stored);
      } catch {
        // Offline: keep the code and stay locked. The user can retry from Settings.
        valid = false;
      }

      if (cancelled) return;

      if (valid) {
        setCode(stored);
        void loadApplications(stored);
      } else {
        await clearStoredUnlockCode();
      }
      setRestoring(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadApplications]);

  const unlock = useCallback(
    async (candidate: string): Promise<boolean> => {
      const trimmed = candidate.trim();
      if (!trimmed) return false;

      const ok = await verifyUnlockCode(trimmed);
      if (!ok) return false;

      setCode(trimmed);
      await setStoredUnlockCode(trimmed);
      void loadApplications(trimmed);
      return true;
    },
    [loadApplications],
  );

  const lock = useCallback(async (): Promise<void> => {
    setCode(null);
    setApplications([]);
    setApplicationsError(null);
    await clearStoredUnlockCode();
  }, []);

  const refreshApplications = useCallback(async (): Promise<void> => {
    if (!code) return;
    await loadApplications(code);
  }, [code, loadApplications]);

  const record = useCallback<SessionState['record']>(
    async (input) => {
      if (!code) throw new Error('Locked: unlock before applying.');

      await recordApplication({
        code: input.beforeApplyCode.trim(),
        jobId: input.jobId,
        resumeKey: input.resumeKey,
        notes: input.notes,
      });

      // Refresh rather than optimistically inserting: the server owns
      // `applied_at` and the unique-on-job_id upsert semantics.
      await loadApplications(code);
    },
    [code, loadApplications],
  );

  const appliedJobIds = useMemo(
    () => new Set(applications.map((application) => application.job_id)),
    [applications],
  );

  const value = useMemo<SessionState>(
    () => ({
      unlocked: code !== null,
      restoring,
      code,
      unlock,
      lock,
      applications,
      appliedJobIds,
      loadingApplications,
      applicationsError,
      refreshApplications,
      record,
    }),
    [
      code,
      restoring,
      unlock,
      lock,
      applications,
      appliedJobIds,
      loadingApplications,
      applicationsError,
      refreshApplications,
      record,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
