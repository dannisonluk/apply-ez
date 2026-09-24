import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useJobs } from '../../src/state/jobs';
import { useSession } from '../../src/state/session';
import { useTheme } from '../../src/theme';

export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { newCount } = useJobs();
  const { applications } = useSession();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.primary,
        tabBarInactiveTintColor: theme.color.textFaint,
        tabBarStyle: {
          backgroundColor: theme.color.surface,
          borderTopColor: theme.color.border,
          // Sized explicitly rather than left to the default. react-navigation derives
          // the bar height from the safe-area inset alone, which on a gesture-nav
          // device leaves the icon and label sitting on the home indicator and looking
          // clipped. The inset is still honoured; it just is not the only term.
          height: 58 + insets.bottom,
          paddingTop: theme.space(1.5),
          paddingBottom: insets.bottom + theme.space(1.5),
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: theme.color.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Jobs',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="briefcase-outline" size={size} color={color} />
          ),
          // Badge reflects jobs that arrived since the previous session. It stays
          // for the whole session (see `JobsProvider`) and clears on next open.
          tabBarBadge: newCount > 0 ? newCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.color.newBadge,
            color: theme.color.onNewBadge,
            fontSize: 10,
            fontWeight: '800',
          },
        }}
      />
      <Tabs.Screen
        name="applications"
        options={{
          title: 'Applied',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="checkmark-done-outline" size={size} color={color} />
          ),
          // Only meaningful once unlocked; the screen itself shows the lock prompt.
          tabBarBadge: applications.length > 0 ? applications.length : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.color.success,
            color: theme.color.onPrimary,
            fontSize: 10,
            fontWeight: '800',
          },
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
