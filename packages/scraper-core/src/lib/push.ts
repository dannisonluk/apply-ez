import { request } from 'undici';

/**
 * Expo push notifications.
 *
 * The scraper is the only thing that knows a scrape found new jobs, so it is the
 * natural place to send the notification — no separate worker needed.
 *
 * Notes on the Expo push API:
 *   - Messages are batched, max 100 per request.
 *   - The POST returns a per-message *receipt ticket*, not a delivery result. A
 *     ticket with `status: 'error'` and `details.error === 'DeviceNotRegistered'`
 *     means the app was uninstalled or the token rotated; that token must be
 *     disabled or it will be retried forever.
 *   - Delivery receipts (the actual outcome) require a second poll of
 *     `/push/getReceipts`. That is deliberately not done here: the failure mode we
 *     care about, DeviceNotRegistered, already shows up in the ticket.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

export interface PushTokenRow {
  token: string;
  device_id: string | null;
  platform: string | null;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  /** Android notification channel id. Must match the app's channel. */
  channelId?: string;
}

export interface PushSendResult {
  /** Messages Expo accepted into its queue. */
  accepted: number;
  /** Tokens Expo rejected outright. */
  invalid: string[];
  /** Tokens whose device is gone; the caller should disable these. */
  unregistered: string[];
  errors: string[];
}

/** Matches `NOTIFICATION_CHANNEL_ID` in apps/mobile/src/lib/push.ts. */
export const NEW_JOBS_CHANNEL_ID = 'new-jobs';

export function isValidExpoPushToken(token: string): boolean {
  return /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token);
}

/**
 * Send messages and classify the outcome.
 *
 * Never throws: a push failure must not fail a scrape run, so every error is
 * collected into the result instead.
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  options: {
    accessToken?: string | undefined;
    timeoutMs?: number | undefined;
    /** Overridable so tests can point at a local mock instead of Expo. */
    url?: string | undefined;
  } = {},
): Promise<PushSendResult> {
  const result: PushSendResult = { accepted: 0, invalid: [], unregistered: [], errors: [] };
  if (messages.length === 0) return result;

  const valid = messages.filter((message) => {
    if (isValidExpoPushToken(message.to)) return true;
    result.invalid.push(message.to);
    return false;
  });
  if (valid.length === 0) return result;

  const endpoint = options.url ?? EXPO_PUSH_URL;

  for (let index = 0; index < valid.length; index += BATCH_SIZE) {
    const batch = valid.slice(index, index + BATCH_SIZE);

    try {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
          ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
        headersTimeout: options.timeoutMs ?? 20_000,
        bodyTimeout: options.timeoutMs ?? 20_000,
      });

      const raw = await response.body.text();

      if (response.statusCode < 200 || response.statusCode >= 300) {
        result.errors.push(`Expo push ${response.statusCode}: ${raw.slice(0, 200)}`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        result.errors.push(`Expo push returned non-JSON: ${raw.slice(0, 200)}`);
        continue;
      }

      // A single message is returned as an object; a batch as an array. Normalise.
      const payload = parsed as { data?: unknown };
      const tickets = Array.isArray(payload.data) ? payload.data : [payload.data];

      tickets.forEach((ticket, ticketIndex) => {
        const entry = ticket as
          | { status?: string; message?: string; details?: { error?: string } }
          | undefined;
        const token = batch[ticketIndex]?.to;

        if (entry?.status === 'ok') {
          result.accepted += 1;
          return;
        }

        const errorCode = entry?.details?.error;
        if (errorCode === 'DeviceNotRegistered' && token) {
          result.unregistered.push(token);
          return;
        }
        result.errors.push(`${errorCode ?? 'unknown'}: ${entry?.message ?? 'no message'}`);
      });
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return result;
}

export interface NewJobsNotice {
  title: string;
  body: string;
}

/**
 * Compose the notification for a batch of newly seen jobs.
 *
 * A single job is named outright; several are summarised with a count and the
 * first one, which is more useful in a notification shade than a bare count.
 */
export function buildNewJobsNotice(
  jobs: Array<{ title: string; companyName?: string | undefined }>,
): NewJobsNotice | null {
  const first = jobs[0];
  if (!first) return null;

  if (jobs.length === 1) {
    return {
      title: first.title,
      body: first.companyName ? `New at ${first.companyName}` : 'New job posting',
    };
  }

  const company = first.companyName ? ` at ${first.companyName}` : '';
  return {
    title: `${jobs.length} new jobs`,
    body: `${first.title}${company}, and ${jobs.length - 1} more`,
  };
}
