import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { disablePushToken, registerPushToken } from './supabase';
import { getDeviceId, getPushEnabled, getStoredPushToken, setStoredPushToken } from './storage';

/**
 * Push notification registration.
 *
 * The notification is SENT by the scraper after a run finds new jobs — see
 * `packages/scraper-core/src/lib/push.ts`. This module only acquires the Expo push
 * token and stores it so the scraper can find the device.
 *
 * Note: remote push does not work in Expo Go on Android (SDK 53 removed it), so a
 * development build is required to test this. Registration degrades to a no-op
 * with a reason string rather than throwing, so the rest of the app is unaffected.
 */

export const NOTIFICATION_CHANNEL_ID = 'new-jobs';

// Foreground presentation. SDK 54 replaced `shouldShowAlert` with the banner/list
// pair, which lets a notification show in the banner without also entering the
// notification centre.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export interface PushRegistrationResult {
  token: string | null;
  /** Why registration did not produce a token. */
  reason?: string;
}

/**
 * The EAS project id, required by `getExpoPushTokenAsync` since SDK 49.
 *
 * Absent until the project is linked with `eas init`, which is the normal state
 * for a fresh clone — hence the explicit reason rather than a crash.
 */
function resolveProjectId(): string | undefined {
  const fromExtra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return fromExtra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

export async function configureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
    name: 'New jobs',
    importance: Notifications.AndroidImportance.DEFAULT,
    // Matches the app's primary colour so the notification looks native to it.
    lightColor: '#2563EB',
    vibrationPattern: [0, 200, 100, 200],
  });
}

export async function ensurePushRegistration(): Promise<PushRegistrationResult> {
  if (!(await getPushEnabled())) return { token: null, reason: 'Notifications are turned off.' };

  // Simulators and emulators cannot receive remote push.
  if (!Device.isDevice) {
    return { token: null, reason: 'Push notifications need a physical device.' };
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== 'granted') {
    return { token: null, reason: 'Notification permission was not granted.' };
  }

  await configureNotificationChannel();

  const projectId = resolveProjectId();
  if (!projectId) {
    return {
      token: null,
      reason: 'No EAS project id. Run `eas init` in apps/mobile to link the project.',
    };
  }

  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = result.data;

    const deviceId = await getDeviceId();
    await registerPushToken({
      token,
      deviceId,
      platform: Platform.OS,
      deviceName: Device.deviceName ?? undefined,
    });
    await setStoredPushToken(token);

    return { token };
  } catch (caught) {
    return {
      token: null,
      reason: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/** Turn notifications off and tell the server to stop sending to this device. */
export async function turnOffPush(): Promise<void> {
  const token = await getStoredPushToken();
  if (token) {
    try {
      await disablePushToken(token);
    } catch {
      // Best effort: the local flag below is what the user actually asked for, and
      // a failed server call must not leave the switch stuck on.
    }
  }
  await setStoredPushToken(null);
}

/** Re-register when the user turns notifications back on. */
export async function turnOnPush(): Promise<PushRegistrationResult> {
  return ensurePushRegistration();
}

/** Where a tapped notification should take the user. */
export type NotificationRoute = { name: 'new-jobs' } | { name: 'job'; jobId: string } | null;

/**
 * Subscribe to a tap on a notification.
 *
 * The scraper sends `{ route: 'new-jobs' }` (it does not know the database uuid of
 * the job it just wrote), but `jobId` is still honoured so a future targeted
 * notification works without changing this contract.
 */
export function addNotificationResponseListener(
  handler: (route: NotificationRoute) => void,
): Notifications.Subscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as
      | { route?: unknown; jobId?: unknown }
      | undefined;

    if (typeof data?.jobId === 'string') {
      handler({ name: 'job', jobId: data.jobId });
      return;
    }
    if (data?.route === 'new-jobs') {
      handler({ name: 'new-jobs' });
      return;
    }
    handler(null);
  });
}
