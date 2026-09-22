import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, EmptyState, Pill, PrimaryButton, Spinner } from '../../src/components/ui';
import { formatRelative } from '../../src/lib/format';
import { useSession } from '../../src/state/session';
import { palettes, useTheme, type Theme } from '../../src/theme';
import { RESUME_SLOT_LABELS, type ResumeSlot } from '../../src/lib/storage';
import type { AppliedJob } from '../../src/types';

export default function ApplicationsScreen(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const insets = useSafeAreaInsets();

  const {
    unlocked,
    restoring,
    unlock,
    applications,
    loadingApplications,
    applicationsError,
    refreshApplications,
  } = useSession();

  if (restoring) {
    return (
      <View style={[s.screen, { paddingTop: insets.top }]}>
        <Spinner label="Checking…" />
      </View>
    );
  }

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={s.title}>Applied</Text>
        <Text style={s.subtitle}>
          {unlocked
            ? 'Every application you have confirmed, newest first.'
            : 'Locked. Enter your unlock code to see your application history.'}
        </Text>
      </View>

      {!unlocked ? (
        <UnlockPanel onUnlock={unlock} />
      ) : loadingApplications && applications.length === 0 ? (
        <Spinner label="Loading applications…" />
      ) : (
        <FlatList
          data={applications}
          keyExtractor={(item) => item.job_id}
          renderItem={({ item }) => <ApplicationCard application={item} />}
          contentContainerStyle={[
            s.listContent,
            applications.length === 0 ? s.listContentEmpty : null,
          ]}
          ItemSeparatorComponent={Separator}
          refreshControl={
            <RefreshControl
              refreshing={loadingApplications}
              onRefresh={() => void refreshApplications()}
              tintColor={theme.color.primary}
              colors={[theme.color.primary]}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="checkmark-done-outline"
              title="No applications yet"
              message={
                applicationsError
                  ? applicationsError
                  : 'Once you confirm an application from a job page, it is recorded here.'
              }
            />
          }
        />
      )}
    </View>
  );
}

/** Inline unlock form, so the user does not have to detour through Settings. */
function UnlockPanel({
  onUnlock,
}: {
  onUnlock: (code: string) => Promise<boolean>;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(code);
      if (!ok) setError('That code was not accepted.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [code, onUnlock]);

  return (
    <View style={s.unlockWrap}>
      <Card>
        <View style={s.unlockIconWrap}>
          <Ionicons name="lock-closed-outline" size={26} color={theme.color.primary} />
        </View>
        <Text style={s.unlockTitle}>Unlock</Text>
        <Text style={s.unlockMessage}>
          The code is verified by the server and never stored in the app bundle.
        </Text>

        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="Unlock code"
          placeholderTextColor={theme.color.textFaint}
          style={s.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />

        {error ? <Text style={s.unlockError}>{error}</Text> : null}

        <View style={s.unlockButton}>
          <PrimaryButton
            label={busy ? 'Checking…' : 'Unlock'}
            onPress={() => void submit()}
            disabled={busy || code.trim().length === 0}
            icon="lock-open-outline"
          />
        </View>
      </Card>
    </View>
  );
}

function ApplicationCard({ application }: { application: AppliedJob }): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const router = useRouter();

  const applied = formatRelative(application.applied_at);
  const resume = application.resume_key
    ? (RESUME_SLOT_LABELS[application.resume_key as ResumeSlot] ?? application.resume_key)
    : null;

  return (
    <Pressable
      onPress={() => router.push(`/job/${application.job_id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${application.title} at ${application.company_name ?? 'unknown company'}`}
      style={({ pressed }) => [s.card, pressed ? s.cardPressed : null]}
    >
      <Text style={s.cardTitle} numberOfLines={2}>
        {application.title}
      </Text>
      <View style={s.metaRow}>
        <Ionicons name="business-outline" size={13} color={theme.color.textFaint} />
        <Text style={s.company} numberOfLines={1}>
          {application.company_name ?? 'Unknown company'}
        </Text>
      </View>

      <View style={s.pillRow}>
        <Pill label="Applied" tone="success" icon="checkmark-circle" />
        {resume ? <Pill label={resume} icon="document-text-outline" /> : null}
        {application.job_status === 'EXPIRED' ? <Pill label="Posting closed" /> : null}
      </View>

      <View style={s.footerRow}>
        <Text style={s.footerText}>{applied}</Text>
        {application.notes ? (
          <Text style={s.footerNote} numberOfLines={1}>
            {application.notes}
          </Text>
        ) : (
          <Pressable
            onPress={() => void Linking.openURL(application.url)}
            hitSlop={8}
            accessibilityRole="link"
          >
            <Text style={s.link}>Open posting</Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

function Separator(): React.JSX.Element {
  const theme = useTheme();
  return <View style={{ height: theme.space(3) }} />;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.color.background,
    },
    header: {
      paddingHorizontal: theme.space(4),
      paddingTop: theme.space(3),
      paddingBottom: theme.space(3),
      gap: theme.space(1),
    },
    title: {
      fontSize: theme.font.title,
      fontWeight: '800',
      color: theme.color.text,
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      lineHeight: 17,
    },
    listContent: {
      paddingHorizontal: theme.space(4),
      paddingBottom: theme.space(10),
    },
    listContentEmpty: {
      flexGrow: 1,
    },
    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      padding: theme.space(4),
      gap: theme.space(2),
    },
    cardPressed: {
      opacity: 0.7,
    },
    cardTitle: {
      fontSize: theme.font.body + 1,
      fontWeight: '700',
      color: theme.color.text,
      lineHeight: 21,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(1.5),
    },
    company: {
      fontSize: theme.font.label,
      color: theme.color.textMuted,
      fontWeight: '600',
      flexShrink: 1,
    },
    pillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.space(1.5),
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.space(2),
      marginTop: theme.space(0.5),
    },
    footerText: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
    },
    footerNote: {
      flex: 1,
      textAlign: 'right',
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
    },
    link: {
      fontSize: theme.font.caption,
      fontWeight: '700',
      color: theme.color.primary,
    },
    unlockWrap: {
      paddingHorizontal: theme.space(4),
    },
    unlockIconWrap: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: theme.color.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'center',
      marginBottom: theme.space(2),
    },
    unlockTitle: {
      fontSize: theme.font.heading,
      fontWeight: '700',
      color: theme.color.text,
      textAlign: 'center',
    },
    unlockMessage: {
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
      textAlign: 'center',
      lineHeight: 17,
      marginTop: theme.space(1),
    },
    input: {
      marginTop: theme.space(4),
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
    unlockError: {
      marginTop: theme.space(2),
      fontSize: theme.font.caption,
      color: theme.color.danger,
      textAlign: 'center',
    },
    unlockButton: {
      marginTop: theme.space(4),
    },
  });

const styles = {
  light: makeStyles(palettes.light),
  dark: makeStyles(palettes.dark),
};
