import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, DetailRow, Notice, PrimaryButton, Section } from '../../src/components/ui';
import { formatRelative } from '../../src/lib/format';
import { ensurePushRegistration, turnOffPush, turnOnPush } from '../../src/lib/push';
import {
  clearCache,
  getPushEnabled,
  getResumeSelection,
  getStoredPushToken,
  RESUME_SLOT_LABELS,
  setPushEnabled,
  type ResumeSlot,
} from '../../src/lib/storage';
import { useJobs } from '../../src/state/jobs';
import { useSession } from '../../src/state/session';
import { palettes, useTheme, type Theme } from '../../src/theme';

const RESUME_SLOTS: Array<{ key: ResumeSlot; label: string; hint: string }> = [
  { key: 'tech', label: RESUME_SLOT_LABELS.tech, hint: 'Engineering and developer roles' },
  { key: 'data', label: RESUME_SLOT_LABELS.data, hint: 'Analytics and business analyst roles' },
  { key: 'general', label: RESUME_SLOT_LABELS.general, hint: 'Everything else' },
];

/**
 * Named alias rather than an inline generic.
 *
 * `useState<Partial<Record<...>>>({})` inside a .tsx file is parsed as a JSX
 * element, because the double closing angle bracket makes the generic ambiguous.
 * Naming the type removes the ambiguity.
 */
type ResumeMap = Partial<Record<ResumeSlot, string>>;

/**
 * Preset relevance thresholds.
 *
 * Exposed as named presets rather than a raw 0-100 slider: the exact number is not
 * meaningful to the user, but "hide the noise" vs "show me everything" is.
 */
const RELEVANCE_PRESETS: Array<{ value: number; label: string; hint: string }> = [
  { value: 20, label: 'Loose', hint: 'Only drop the obvious non-matches' },
  { value: 35, label: 'Balanced', hint: 'Recommended' },
  { value: 60, label: 'Strict', hint: 'Tech and data roles only' },
];

export default function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const insets = useSafeAreaInsets();
  const {
    jobs,
    visible,
    lowRelevance,
    expired,
    newCount,
    lastSyncedAt,
    fromCache,
    refresh,
    refreshing,
    minRelevance,
    setMinRelevance,
    showFiltered,
    setShowFiltered,
  } = useJobs();
  const { unlocked, restoring, unlock, lock, applications } = useSession();

  const [pushEnabled, setPushEnabledState] = useState(true);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumes, setResumes] = useState<ResumeMap>({});

  const [codeInput, setCodeInput] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setPushEnabledState(await getPushEnabled());
      setPushToken(await getStoredPushToken());
      setResumes(await getResumeSelection());
    })();
  }, []);

  const onTogglePush = useCallback(async (next: boolean) => {
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
  }, []);

  const onRegisterPush = useCallback(async () => {
    setBusy(true);
    const result = await ensurePushRegistration();
    setPushToken(result.token);
    setPushNote(result.reason ?? null);
    setBusy(false);
  }, []);

  const onUnlock = useCallback(async () => {
    if (!codeInput.trim()) return;
    setCodeBusy(true);
    setCodeError(null);
    try {
      const ok = await unlock(codeInput);
      if (ok) {
        setCodeInput('');
      } else {
        setCodeError('That code was not accepted.');
      }
    } catch (caught) {
      setCodeError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCodeBusy(false);
    }
  }, [codeInput, unlock]);

  const onLock = useCallback(() => {
    Alert.alert(
      'Lock the application area?',
      'You will need to re-enter the unlock code to see your application history or record a new application.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Lock', style: 'destructive', onPress: () => void lock() },
      ],
    );
  }, [lock]);

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
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + theme.space(3), paddingBottom: insets.bottom + theme.space(8) },
      ]}
    >
      <Text style={s.title}>Settings</Text>

      <Section title="Application codes">
        <Card>
          {restoring ? (
            <Text style={s.sectionNote}>Checking the stored code…</Text>
          ) : unlocked ? (
            <>
              <View style={s.statusRow}>
                <Ionicons name="lock-open-outline" size={18} color={theme.color.success} />
                <Text style={s.statusText}>Unlocked</Text>
              </View>
              <Text style={s.sectionNote}>
                Your unlock code is remembered in this device's keystore. The code that confirms an
                application is asked for on every submit and is never stored.
              </Text>
              <View style={s.spacer} />
              <Pressable onPress={onLock} style={s.outlineButton} accessibilityRole="button">
                <Ionicons name="lock-closed-outline" size={16} color={theme.color.text} />
                <Text style={s.outlineButtonText}>Lock now</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={s.switchHint}>
                Both codes are verified by the server and stored there only as hashes, so they are
                never part of the app bundle.
              </Text>
              <TextInput
                value={codeInput}
                onChangeText={setCodeInput}
                placeholder="Unlock code"
                placeholderTextColor={theme.color.textFaint}
                style={s.input}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={() => void onUnlock()}
              />
              {codeError ? <Text style={s.errorText}>{codeError}</Text> : null}
              <View style={s.spacer} />
              <PrimaryButton
                label={codeBusy ? 'Checking…' : 'Unlock'}
                icon="lock-open-outline"
                onPress={() => void onUnlock()}
                disabled={codeBusy || codeInput.trim().length === 0}
              />
            </>
          )}
        </Card>
      </Section>

      <Section title="Relevance filter">
        <Card>
          <Text style={s.switchHint}>
            Each job is scored 0-100 by the scraper based on the role. Low-scoring postings — cabin
            crew, bar and service roles — are hidden from the list but never deleted.
          </Text>
          <View style={s.spacer} />
          <View style={s.presetRow}>
            {RELEVANCE_PRESETS.map((preset) => {
              const active = minRelevance === preset.value;
              return (
                <Pressable
                  key={preset.value}
                  onPress={() => setMinRelevance(preset.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[s.preset, active ? s.presetActive : null]}
                >
                  <Text style={[s.presetLabel, active ? s.presetLabelActive : null]}>
                    {preset.label}
                  </Text>
                  <Text style={s.presetHint}>{preset.hint}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={s.spacer} />
          <View style={s.switchRow}>
            <View style={s.switchLabel}>
              <Text style={s.switchTitle}>Show hidden jobs</Text>
              <Text style={s.switchHint}>
                Reveal the {lowRelevance.length} low-match {lowRelevance.length === 1 ? 'job' : 'jobs'}{' '}
                the filter is currently holding back.
              </Text>
            </View>
            <Switch
              value={showFiltered}
              onValueChange={setShowFiltered}
              trackColor={{ true: theme.color.primary, false: theme.color.borderStrong }}
            />
          </View>
        </Card>
      </Section>

      <Section title="Notifications">
        <Card>
          <View style={s.switchRow}>
            <View style={s.switchLabel}>
              <Text style={s.switchTitle}>New job alerts</Text>
              <Text style={s.switchHint}>
                Sent after a scrape run finds new postings. The scraper runs every six hours.
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
                  <PrimaryButton
                    label="Register this device"
                    icon="notifications-outline"
                    onPress={() => void onRegisterPush()}
                  />
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
                  <Text style={s.resumeHint}>{resumes[slot.key] ?? slot.hint}</Text>
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
          <DetailRow icon="briefcase-outline" label="Active jobs" value={String(visible.length)} />
          <DetailRow icon="funnel-outline" label="Hidden by filter" value={String(lowRelevance.length)} />
          <DetailRow icon="lock-closed-outline" label="Closed jobs" value={String(expired.length)} />
          <DetailRow
            icon="checkmark-done-outline"
            label="Applied"
            value={unlocked ? String(applications.length) : 'Locked'}
          />
          <DetailRow icon="sparkles-outline" label="New this session" value={String(newCount)} />
          <DetailRow
            icon="sync-outline"
            label="Last sync"
            value={lastSyncedAt ? formatRelative(new Date(lastSyncedAt).toISOString()) : 'Never'}
          />
          <DetailRow icon="save-outline" label="Source" value={fromCache ? 'Saved copy' : 'Live'} />
          <DetailRow icon="layers-outline" label="Rows fetched" value={String(jobs.length)} />
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
          <DetailRow
            icon="pricetag-outline"
            label="App version"
            value={Constants.expoConfig?.version ?? '0.1.0'}
          />
          <DetailRow
            icon="logo-react"
            label="Expo SDK"
            value={String(Constants.expoConfig?.sdkVersion ?? '54')}
          />
          <DetailRow icon="git-branch-outline" label="Scraper" value="12 HK employers" />
          <DetailRow icon="time-outline" label="Schedule" value="Every 6 hours" />
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
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(2),
    },
    statusText: {
      fontSize: theme.font.body,
      fontWeight: '700',
      color: theme.color.success,
    },
    spacer: {
      marginTop: theme.space(3),
    },
    noticeWrap: {
      marginTop: theme.space(3),
    },
    input: {
      marginTop: theme.space(3),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(2.5),
      fontSize: theme.font.body,
      color: theme.color.text,
      backgroundColor: theme.color.surfaceAlt,
      textAlign: 'center',
      letterSpacing: 2,
    },
    errorText: {
      marginTop: theme.space(2),
      fontSize: theme.font.caption,
      color: theme.color.danger,
      textAlign: 'center',
    },
    outlineButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.space(2),
      paddingVertical: theme.space(3),
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.borderStrong,
    },
    outlineButtonText: {
      fontSize: theme.font.label,
      fontWeight: '600',
      color: theme.color.text,
    },
    presetRow: {
      flexDirection: 'row',
      gap: theme.space(2),
    },
    preset: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
      paddingVertical: theme.space(2.5),
      paddingHorizontal: theme.space(2),
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    presetActive: {
      backgroundColor: theme.color.primarySoft,
      borderColor: theme.color.primary,
    },
    presetLabel: {
      fontSize: theme.font.label,
      fontWeight: '700',
      color: theme.color.textMuted,
    },
    presetLabelActive: {
      color: theme.color.primary,
    },
    presetHint: {
      fontSize: 10,
      color: theme.color.textFaint,
      textAlign: 'center',
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
      marginTop: theme.space(3),
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
