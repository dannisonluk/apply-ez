import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, DetailRow, Notice, PrimaryButton, Section } from '../../src/components/ui';
import { formatRelative } from '../../src/lib/format';
import { ensurePushRegistration, turnOffPush, turnOnPush } from '../../src/lib/push';
import {
  clearCache,
  getPushEnabled,
  getResumeSelection,
  getStoredPushToken,
  setPushEnabled,
  type ResumeSlot,
} from '../../src/lib/storage';
import { useJobs } from '../../src/state/jobs';
import { palettes, useTheme, type Theme } from '../../src/theme';

const RESUME_SLOTS: Array<{ key: ResumeSlot; label: string; hint: string }> = [
  { key: 'tech', label: 'Tech / programmer', hint: 'Engineering roles' },
  { key: 'data', label: 'Data + business analyst', hint: 'Analytics and BA roles' },
  { key: 'general', label: 'General', hint: 'Everything else' },
];

export default function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const insets = useSafeAreaInsets();
  const { jobs, newCount, lastSyncedAt, fromCache, refresh, refreshing } = useJobs();

  const [pushEnabled, setPushEnabledState] = useState(true);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumes, setResumes] = useState<Partial<Record<ResumeSlot, string>>>({});

  useEffect(() => {
    void (async () => {
      setPushEnabledState(await getPushEnabled());
      setPushToken(await getStoredPushToken());
      setResumes(await getResumeSelection());
    })();
  }, []);

  const onTogglePush = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setPushEnabledState(next);
      await setPushEnabled(next);

      if (!next) {
        await turnOffPush();
        setPushToken(null);
        setPushNote(null);
        setBusy(false);
        return;
      }

      const result = await turnOnPush();
      setPushToken(result.token);
      setPushNote(result.reason ?? null);
      setBusy(false);
    },
    [],
  );

  const onRegisterPush = useCallback(async () => {
    setBusy(true);
    const result = await ensurePushRegistration();
    setPushToken(result.token);
    setPushNote(result.reason ?? null);
    setBusy(false);
  }, []);

  const onClearCache = useCallback(() => {
    Alert.alert(
      'Clear saved list?',
      'The next refresh will download everything again. Your new-job markers are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await clearCache();
              await refresh();
            })();
          },
        },
      ],
    );
  }, [refresh]);

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingTop: insets.top + theme.space(3), paddingBottom: insets.bottom + theme.space(8) }]}
    >
      <Text style={s.title}>Settings</Text>

      <Section title="Notifications">
        <Card>
          <View style={s.switchRow}>
            <View style={s.switchLabel}>
              <Text style={s.switchTitle}>New job alerts</Text>
              <Text style={s.switchHint}>
                Sent after a scrape run finds new postings. The scraper runs every four hours.
              </Text>
            </View>
            <Switch
              value={pushEnabled}
              onValueChange={(next) => void onTogglePush(next)}
              disabled={busy}
              trackColor={{ true: theme.color.primary, false: theme.color.borderStrong }}
            />
          </View>

          {pushEnabled ? (
            <>
              <View style={s.spacer} />
              <DetailRow
                icon="key-outline"
                label="Device token"
                value={pushToken ? `${pushToken.slice(0, 22)}…` : 'Not registered'}
              />
              {pushNote ? (
                <View style={s.noticeWrap}>
                  <Notice tone="warning" title="Could not register" message={pushNote} />
                </View>
              ) : null}
              {!pushToken && !pushNote ? (
                <View style={s.spacer}>
                  <PrimaryButton label="Register this device" icon="notifications-outline" onPress={() => void onRegisterPush()} />
                </View>
              ) : null}
            </>
          ) : null}
        </Card>
      </Section>

      <Section title="Resumes">
        <Card>
          {RESUME_SLOTS.map((slot, index) => (
            <View key={slot.key}>
              {index > 0 ? <View style={s.rowDivider} /> : null}
              <View style={s.resumeRow}>
                <View style={s.resumeIcon}>
                  <Ionicons name="document-text-outline" size={16} color={theme.color.textFaint} />
                </View>
                <View style={s.resumeBody}>
                  <Text style={s.resumeLabel}>{slot.label}</Text>
                  <Text style={s.resumeHint}>
                    {resumes[slot.key] ?? slot.hint}
                  </Text>
                </View>
                <View style={s.soonPill}>
                  <Text style={s.soonText}>Soon</Text>
                </View>
              </View>
            </View>
          ))}
          <Text style={s.sectionNote}>
            PDFs will be stored in Cloudflare R2 and attached when an application is prepared. Nothing
            is uploaded yet — the apply flow is the next phase.
          </Text>
        </Card>
      </Section>

      <Section title="Data">
        <Card>
          <DetailRow icon="briefcase-outline" label="Active jobs" value={String(jobs.length)} />
          <DetailRow icon="sparkles-outline" label="New this session" value={String(newCount)} />
          <DetailRow
            icon="sync-outline"
            label="Last sync"
            value={lastSyncedAt ? formatRelative(new Date(lastSyncedAt).toISOString()) : 'Never'}
          />
          <DetailRow icon="save-outline" label="Source" value={fromCache ? 'Saved copy' : 'Live'} />
          <View style={s.spacer} />
          <PrimaryButton
            label={refreshing ? 'Refreshing…' : 'Refresh now'}
            icon="refresh-outline"
            onPress={() => void refresh()}
            disabled={refreshing}
          />
          <Pressable onPress={onClearCache} style={s.dangerButton} accessibilityRole="button">
            <Ionicons name="trash-outline" size={16} color={theme.color.danger} />
            <Text style={s.dangerButtonText}>Clear saved list</Text>
          </Pressable>
        </Card>
      </Section>

      <Section title="About">
        <Card>
          <DetailRow icon="pricetag-outline" label="App version" value={Constants.expoConfig?.version ?? '0.1.0'} />
          <DetailRow icon="logo-react" label="Expo SDK" value={String(Constants.expoConfig?.sdkVersion ?? '54')} />
          <DetailRow icon="git-branch-outline" label="Scraper" value="12 HK employers" />
          <DetailRow icon="time-outline" label="Schedule" value="Every 4 hours" />
        </Card>
      </Section>

      <Text style={s.footer}>
        Job data is scraped from public careers pages. Always confirm details on the company's own
        posting before applying.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.color.background,
    },
    content: {
      paddingHorizontal: theme.space(4),
    },
    title: {
      fontSize: theme.font.title,
      fontWeight: '800',
      color: theme.color.text,
      letterSpacing: -0.5,
      marginBottom: theme.space(4),
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(4),
    },
    switchLabel: {
      flex: 1,
      gap: 2,
    },
    switchTitle: {
      fontSize: theme.font.body,
      fontWeight: '700',
      color: theme.color.text,
    },
    switchHint: {
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
      lineHeight: 17,
    },
    spacer: {
      marginTop: theme.space(3),
    },
    noticeWrap: {
      marginTop: theme.space(3),
    },
    rowDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.color.border,
      marginVertical: theme.space(3),
    },
    resumeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(3),
    },
    resumeIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.color.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    resumeBody: {
      flex: 1,
      gap: 1,
    },
    resumeLabel: {
      fontSize: theme.font.label,
      fontWeight: '600',
      color: theme.color.text,
    },
    resumeHint: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
    },
    soonPill: {
      backgroundColor: theme.color.surfaceAlt,
      paddingHorizontal: theme.space(2.5),
      paddingVertical: 2,
      borderRadius: theme.radius.pill,
    },
    soonText: {
      fontSize: 10,
      fontWeight: '700',
      color: theme.color.textFaint,
      letterSpacing: 0.4,
    },
    sectionNote: {
      marginTop: theme.space(4),
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      lineHeight: 17,
    },
    dangerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.space(2),
      marginTop: theme.space(2.5),
      paddingVertical: theme.space(3),
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.danger,
    },
    dangerButtonText: {
      fontSize: theme.font.label,
      fontWeight: '600',
      color: theme.color.danger,
    },
    footer: {
      marginTop: theme.space(6),
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      lineHeight: 17,
      textAlign: 'center',
    },
  });

const styles = {
  light: makeStyles(palettes.light),
  dark: makeStyles(palettes.dark),
};
