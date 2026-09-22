import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { useJobs } from '../../src/state/jobs';
import { useTheme } from '../../src/theme';

export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();
  const { newCount } = useJobs();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.primary,
        tabBarInactiveTintColor: theme.color.textFaint,
        tabBarStyle: {
          backgroundColor: theme.color.surface,
          borderTopColor: theme.color.border,
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
