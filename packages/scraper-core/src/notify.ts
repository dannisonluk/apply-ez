import type { JobIngest } from './types/index.js';
import { buildNewJobsNotice, NEW_JOBS_CHANNEL_ID, sendExpoPush } from './lib/push.js';
import type { JobStore } from './store.js';

/**
 * Push notification for a scrape run that found new jobs.
 *
 * Lives next to `store.ts` rather than in `lib/` because it is a run-level
 * concern (it needs the store and the run's config), not pipeline logic.
 *
 * Fail-soft by design: notifications are a nicety, and a push outage must never
 * turn a successful scrape into a failed run.
 */

export interface NotifyLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface NotifyResult {
  tokens: number;
  accepted: number;
  unregistered: number;
  errors: string[];
}

export async function notifyNewJobs(input: {
  store: JobStore;
  /** The ingest payload written this run, used to name the new postings. */
  jobs: JobIngest[];
  newExternalIds: string[];
  logger: NotifyLogger;
}): Promise<NotifyResult | null> {
  if (process.env.PUSH_ENABLED === 'false') return null;
  if (input.newExternalIds.length === 0) return null;

  try {
    const tokens = await input.store.listPushTokens();
    if (tokens.length === 0) return null;

    const newIdSet = new Set(input.newExternalIds);
    const newJobs = input.jobs
      .filter((job) => newIdSet.has(job.externalId))
      .map((job) => ({ title: job.title, companyName: job.companyName }));

    const notice = buildNewJobsNotice(newJobs);
    if (!notice) return null;

    const result = await sendExpoPush(
      tokens.map((row) => ({
        to: row.token,
        title: notice.title,
        body: notice.body,
        // The app routes this to the Jobs tab with the New filter applied. Carrying
        // a job id would need the DB uuid, which is not known at this point — and
        // showing every new job is more useful than deep-linking to one.
        data: { route: 'new-jobs' },
        sound: 'default' as const,
        channelId: NEW_JOBS_CHANNEL_ID,
      })),
      { accessToken: process.env.EXPO_ACCESS_TOKEN },
    );

    if (result.unregistered.length > 0) {
      // These devices uninstalled the app or rotated their token. Leaving them
      // enabled would mean retrying them on every single run, forever.
      await input.store.disablePushTokens(result.unregistered);
      input.logger.info('disabled unregistered push tokens', {
        count: result.unregistered.length,
      });
    }

    input.logger.info('push notification sent', {
      tokens: tokens.length,
      accepted: result.accepted,
      unregistered: result.unregistered.length,
      errors: result.errors.slice(0, 3),
    });

    return {
      tokens: tokens.length,
      accepted: result.accepted,
      unregistered: result.unregistered.length,
      errors: result.errors,
    };
  } catch (error) {
    input.logger.warn('push notification failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
