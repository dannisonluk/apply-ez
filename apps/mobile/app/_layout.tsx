import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { addNotificationResponseListener, configureNotificationChannel } from '../src/lib/push';
import { JobsProvider } from '../src/state/jobs';
import { useTheme } from '../src/theme';

export default function RootLayout(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();

  useEffect(() => {
    // Creating the Android channel is idempotent and must happen before any
    // notification arrives, so it runs at startup rather than at registration.
    void configureNotificationChannel();
  }, []);

  useEffect(() => {
    // Handled here rather than in the Jobs screen: a tap can arrive while the user
    // is on Settings, in which case the Jobs screen is not mounted to receive it.
    const subscription = addNotificationResponseListener((route) => {
      if (!route) return;
      if (route.name === 'job') {
        router.push(`/job/${route.jobId}`);
        return;
      }
      // Land on the list with the New filter already applied.
      router.push({ pathname: '/', params: { filter: 'new' } });
    });
    return () => subscription.remove();
  }, [router]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <SafeAreaProvider>
        <JobsProvider>
          <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.color.background },
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="job/[id]"
              options={{
                headerShown: true,
                title: 'Job',
                headerBackTitle: 'Back',
                headerStyle: { backgroundColor: theme.color.background },
                headerTintColor: theme.color.primary,
                headerTitleStyle: { color: theme.color.text },
                headerShadowVisible: false,
              }}
            />
          </Stack>
        </JobsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
