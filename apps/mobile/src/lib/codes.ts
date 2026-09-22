import * as SecureStore from 'expo-secure-store';

/**
 * The unlock code, kept in the OS keystore rather than AsyncStorage.
 *
 * It is a credential: it is what authorises reading the application history and
 * recording new applications, so it belongs in `SecureStore` (Android Keystore /
 * iOS Keychain) rather than in a plain-text AsyncStorage entry.
 *
 * The code is never sent anywhere except to the `app_unlock` / `list_applications`
 * RPCs, and the server only ever stores a bcrypt hash of it — so a database dump
 * and an APK teardown both reveal nothing.
 */

const UNLOCK_KEY = 'applyez.unlockCode';

export async function getStoredUnlockCode(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(UNLOCK_KEY);
  } catch {
    // A keystore failure must not brick the app; the user can re-enter the code.
    return null;
  }
}

export async function setStoredUnlockCode(code: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(UNLOCK_KEY, code);
  } catch {
    /* ignore */
  }
}

export async function clearStoredUnlockCode(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(UNLOCK_KEY);
  } catch {
    /* ignore */
  }
}
