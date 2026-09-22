import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, DetailRow, Divider, EmptyState, NewBadge, Notice, Pill, PrimaryButton, Section, Spinner } from '../../src/components/ui';
import { RestError, fetchJob } from '../../src/lib/supabase';
import {
  deadlineInfo,
  formatDate,
  formatEmploymentType,
  formatRelative,
  formatSalary,
  formatSeniority,
  formatWorkArrangement,
  formatYoe,
} from '../../src/lib/format';
import { useJobs } from '../../src/state/jobs';
import { useSession } from '../../src/state/session';
import { palettes, useTheme, type Theme } from '../../src/theme';
import { toJobView, type JobView } from '../../src/types';

const RESUME_SLOTS = [
  { key: 'tech', label: 'Tech' },
  { key: 'data', label: 'Data / BA' },
  { key: 'general', label: 'General' },
] as const;

export default function JobDetailScreen(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';

  const { jobs } = useJobs();
  const { unlocked, applications, record, unlock } = useSession();

  // Prefer the already-loaded row so the screen paints instantly, including when
  // it was reached by tapping a card. A notification tap or a cold deep link has
  // nothing in memory, so fall back to a single-row fetch.
  const [fetched, setFetched] = useState<JobView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromList = useMemo(() => jobs.find((job) => job.id === id) ?? null, [jobs, id]);

  useEffect(() => {
    if (fromList || !id) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const row = await fetchJob(id);
        if (cancelled) return;
        if (!row) {
          setError('This job is no longer available.');
        } else {
          setFetched(toJobView(row, null));
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromList, id]);

  const job = fromList ?? fetched;

  // Put the real title in the native header once it is known.
  useEffect(() => {
    if (job) navigation.setOptions({ title: job.companyName });
  }, [job, navigation]);

  if (loading) return <Spinner label="Loading job…" />;

  if (!job) {
    return (
      <EmptyState
        icon={error ? 'alert-circle-outline' : 'help-circle-outline'}
        title={error ? 'Unavailable' : 'Job not found'}
        message={error ?? 'This posting is no longer in the active list.'}
      />
    );
  }

  const deadline = deadlineInfo(job.deadline);
  const inferredDeadline = job.inferredDeadline ? formatDate(`${job.inferredDeadline}T00:00:00Z`) : null;
  const yoe = formatYoe(job.yoeMin, job.yoeMax, job.experienceMin);
  const salary = formatSalary(job.salary);
  const employment = formatEmploymentType(job.employmentType);
  const arrangement = formatWorkArrangement(job.workArrangement);
  const seniority = formatSeniority(job.seniority);

  const application = applications.find((item) => item.job_id === job.id) ?? null;

  const open = (url: string) => {
    void Linking.openURL(url).catch(() => setError(`Could not open ${url}`));
  };

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingBottom: insets.bottom + theme.space(10) }]}
    >
      <View style={s.headerBlock}>
        <View style={s.badgeRow}>
          {job.isNew && !job.isExpired ? <NewBadge /> : null}
          {job.applied ? <Pill label="Applied" tone="success" icon="checkmark-circle" /> : null}
          {job.isExpired ? <Pill label="Closed" icon="lock-closed-outline" /> : null}
        </View>
        <Text style={s.title}>{job.title}</Text>
        <View style={s.companyRow}>
          <Ionicons name="business-outline" size={14} color={theme.color.textMuted} />
          <Text style={s.company}>{job.companyName}</Text>
          {job.location ? (
            <>
              <Text style={s.dot}>·</Text>
              <Ionicons name="location-outline" size={14} color={theme.color.textMuted} />
              <Text style={s.company}>{job.location}</Text>
            </>
          ) : null}
        </View>
      </View>

      {error ? <Notice tone="danger" title="Something went wrong" message={error} /> : null}

      {job.isExpired ? (
        <Notice
          tone="warning"
          title="This posting has closed"
          message="The scraper no longer finds it on the company site. The link may still work, but do not expect a response."
        />
      ) : null}

      {deadline.label ? (
        <Card style={s.deadlineCard}>
          <View style={s.deadlineRow}>
            <Ionicons
              name={deadline.tone === 'passed' ? 'close-circle-outline' : 'hourglass-outline'}
              size={18}
              color={
                deadline.tone === 'urgent'
                  ? theme.color.danger
                  : deadline.tone === 'soon'
                    ? theme.color.warning
                    : deadline.tone === 'passed'
                      ? theme.color.textFaint
                      : theme.color.success
              }
            />
            <View style={s.deadlineText}>
              <Text style={s.deadlineLabel}>{deadline.label}</Text>
              {deadline.date ? <Text style={s.deadlineDate}>Application deadline {deadline.date}</Text> : null}
            </View>
          </View>
        </Card>
      ) : null}

      {job.summary ? (
        <Section title="AI summary">
          <Card>
            <View style={s.summaryHeader}>
              <Ionicons name="sparkles-outline" size={14} color={theme.color.primary} />
              <Text style={s.summaryHeaderText}>
                Generated from the posting{job.enrichStatus === 'OK' ? '' : ' (pending)'}
              </Text>
            </View>
            <Text style={s.summaryText}>{job.summary}</Text>
          </Card>
        </Section>
      ) : null}

      {job.flags.length > 0 ? (
        <Section title="Worth knowing">
          <Card>
            <View style={s.flagList}>
              {job.flags.map((flag) => (
                <View key={flag} style={s.flagItem}>
                  <Ionicons name="alert-circle-outline" size={15} color={theme.color.warning} />
                  <Text style={s.flagText}>{flag}</Text>
                </View>
              ))}
            </View>
          </Card>
        </Section>
      ) : null}

      <Section title="Details">
        <Card>
          {employment ? <DetailRow icon="document-text-outline" label="Type" value={employment} /> : null}
          {arrangement ? <DetailRow icon="home-outline" label="Work arrangement" value={arrangement} /> : null}
          {seniority ? <DetailRow icon="trending-up-outline" label="Level" value={seniority} /> : null}
          {yoe ? <DetailRow icon="briefcase-outline" label="Experience" value={yoe} /> : null}
          {salary ? <DetailRow icon="cash-outline" label="Salary" value={salary} /> : null}
          {job.department ? <DetailRow icon="people-outline" label="Department" value={job.department} /> : null}
          {job.workSchedule ? <DetailRow icon="time-outline" label="Schedule" value={job.workSchedule} /> : null}
          <DetailRow
            icon="globe-outline"
            label="Remote"
            value={job.remote ? 'Yes' : 'Not stated'}
          />
          {inferredDeadline && !deadline.date ? (
            // The LLM's deadline is shown only when the deterministic scraper path
            // found nothing, and is labelled so it is never mistaken for a fact.
            <DetailRow icon="help-circle-outline" label="Deadline (inferred)" value={inferredDeadline} tone="warning" />
          ) : null}
          <Divider />
          <DetailRow icon="eye-outline" label="First seen" value={formatRelative(job.firstSeenAt)} />
          <DetailRow icon="calendar-outline" label="Posted" value={formatDate(job.publishedAt) ?? 'Unknown'} />
        </Card>
      </Section>

      {/* Explains why this job is where it is. Without it, a low-match job that the
          user has explicitly revealed would look identical to a good match. */}
      <Section title="Match">
        <Card>
          <View style={s.matchRow}>
            <View
              style={[
                s.matchScore,
                {
                  backgroundColor:
                    job.relevanceBand === 'high'
                      ? theme.color.successSoft
                      : job.relevanceBand === 'medium'
                        ? theme.color.primarySoft
                        : theme.color.surfaceAlt,
                },
              ]}
            >
              <Text style={s.matchScoreValue}>{job.relevanceScore}</Text>
              <Text style={s.matchScoreLabel}>/ 100</Text>
            </View>
            <View style={s.matchBody}>
              <Text style={s.matchTitle}>
                {job.relevanceBand === 'high'
                  ? 'Strong match'
                  : job.relevanceBand === 'medium'
                    ? 'Possible match'
                    : job.relevanceBand === 'low'
                      ? 'Low match'
                      : 'Filtered out'}
              </Text>
              <Text style={s.matchHint}>
                {job.filterReason
                  ? `Scored by ${job.filterReason.replace(/,/g, ', ')}`
                  : 'No relevance signals found in the title.'}
              </Text>
            </View>
          </View>
        </Card>
      </Section>

      {job.skills.length > 0 ? (
        <Section title={`Skills (${job.skills.length})`}>
          <Card>
            <View style={s.pillWrap}>
              {job.skills.map((skill) => (
                <Pill key={skill} label={skill} tone="primary" />
              ))}
            </View>
          </Card>
        </Section>
      ) : null}

      {job.responsibilities.length > 0 ? (
        <Section title="What you'd own">
          <Card>
            <View style={s.bulletList}>
              {job.responsibilities.map((item, index) => (
                <View key={`${index}-${item.slice(0, 16)}`} style={s.bulletItem}>
                  <Text style={s.bulletDot}>•</Text>
                  <Text style={s.bulletText}>{item}</Text>
                </View>
              ))}
            </View>
          </Card>
        </Section>
      ) : null}

      {job.tags.length > 0 ? (
        <Section title="Tags">
          <View style={s.pillWrap}>
            {job.tags.map((tag) => (
              <Pill key={tag} label={tag} />
            ))}
          </View>
        </Section>
      ) : null}

      <Section title="Apply">
        <Card>
          <View style={s.stepRow}>
            <View style={s.stepNumber}>
              <Text style={s.stepNumberText}>1</Text>
            </View>
            <View style={s.stepBody}>
              <Text style={s.stepTitle}>Open the application form</Text>
              <Text style={s.stepHint}>
                This opens {job.companyName}'s own site. You fill it in there.
              </Text>
            </View>
          </View>
          <View style={s.spacer} />
          <PrimaryButton
            label="Apply on the company site"
            icon="open-outline"
            onPress={() => open(job.applyUrl ?? job.url)}
          />
          {job.applyUrl ? (
            <>
              <View style={s.spacerSmall} />
              <Pressable onPress={() => open(job.url)} style={s.secondaryButton} accessibilityRole="button">
                <Ionicons name="document-text-outline" size={16} color={theme.color.textMuted} />
                <Text style={s.secondaryButtonText}>View the original posting</Text>
              </Pressable>
            </>
          ) : null}

          <Divider />

          <View style={s.stepRow}>
            <View style={s.stepNumber}>
              <Text style={s.stepNumberText}>2</Text>
            </View>
            <View style={s.stepBody}>
              <Text style={s.stepTitle}>Record it once you have submitted</Text>
              <Text style={s.stepHint}>
                Confirming asks for the application code, so a stray tap can never file anything.
              </Text>
            </View>
          </View>
          <View style={s.spacer} />

          {application ? (
            <AppliedRecord
              appliedAt={application.applied_at}
              resumeKey={application.resume_key}
            />
          ) : null}

          <ApplyRecorder
            unlocked={unlocked}
            alreadyApplied={application !== null}
            onUnlock={unlock}
            onSubmit={async (resumeKey, beforeApplyCode) => {
              await record({ jobId: job.id, beforeApplyCode, resumeKey });
            }}
          />
        </Card>
      </Section>

      <Text style={s.actionNote}>
        Nothing is submitted automatically. The app records an application only after you say you
        sent it, and every application stops at this final manual step.
      </Text>
    </ScrollView>
  );
}

/** The confirmation panel. Two gates: unlock the area, then the per-submit code. */
function ApplyRecorder({
  unlocked,
  alreadyApplied,
  onUnlock,
  onSubmit,
}: {
  unlocked: boolean;
  alreadyApplied: boolean;
  onUnlock: (code: string) => Promise<boolean>;
  onSubmit: (resumeKey: string, beforeApplyCode: string) => Promise<void>;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];

  const [unlockInput, setUnlockInput] = useState('');
  const [resumeKey, setResumeKey] = useState<string>('tech');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doUnlock = useCallback(async (): Promise<void> => {
    if (!unlockInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(unlockInput);
      if (ok) setUnlockInput('');
      else setError('That unlock code was not accepted.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [onUnlock, unlockInput]);

  const doSubmit = useCallback(async (): Promise<void> => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(resumeKey, code);
      setCode('');
    } catch (caught) {
      if (caught instanceof RestError && caught.isCodeRejection) {
        setError('That application code was not accepted.');
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setBusy(false);
    }
  }, [code, onSubmit, resumeKey]);

  if (!unlocked) {
    return (
      <>
        <TextInput
          value={unlockInput}
          onChangeText={setUnlockInput}
          placeholder="Unlock code"
          placeholderTextColor={theme.color.textFaint}
          style={s.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={() => void doUnlock()}
        />
        {error ? <Text style={s.errorText}>{error}</Text> : null}
        <View style={s.spacerSmall} />
        <PrimaryButton
          label={busy ? 'Checking…' : 'Unlock'}
          icon="lock-open-outline"
          onPress={() => void doUnlock()}
          disabled={busy || unlockInput.trim().length === 0}
        />
      </>
    );
  }

  return (
    <>
      <Text style={s.fieldLabel}>Resume used</Text>
      <View style={s.resumeRow}>
        {RESUME_SLOTS.map((slot) => {
          const active = resumeKey === slot.key;
          return (
            <Pressable
              key={slot.key}
              onPress={() => setResumeKey(slot.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[s.resumeChip, active ? s.resumeChipActive : null]}
            >
              <Text style={[s.resumeChipText, active ? s.resumeChipTextActive : null]}>
                {slot.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={s.spacerSmall} />
      <Text style={s.fieldLabel}>Application code</Text>
      <TextInput
        value={code}
        onChangeText={setCode}
        placeholder="Required to confirm"
        placeholderTextColor={theme.color.textFaint}
        style={s.input}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        returnKeyType="go"
        onSubmitEditing={() => void doSubmit()}
      />

      {error ? <Text style={s.errorText}>{error}</Text> : null}

      <View style={s.spacerSmall} />
      <PrimaryButton
        label={
          busy
            ? 'Recording…'
            : alreadyApplied
              ? 'Update the recorded application'
              : 'I have submitted — record it'
        }
        icon="checkmark-circle-outline"
        onPress={() => void doSubmit()}
        disabled={busy || code.trim().length === 0}
      />
    </>
  );
}

function AppliedRecord({
  appliedAt,
  resumeKey,
}: {
  appliedAt: string;
  resumeKey: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const label = RESUME_SLOTS.find((slot) => slot.key === resumeKey)?.label ?? resumeKey;

  return (
    <View style={s.appliedBox}>
      <Ionicons name="checkmark-circle" size={18} color={theme.color.success} />
      <View style={s.appliedBody}>
        <Text style={s.appliedTitle}>Recorded {formatRelative(appliedAt)}</Text>
        <Text style={s.appliedHint}>
          {label ? `Resume: ${label}` : 'No resume recorded'}
        </Text>
      </View>
    </View>
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
      paddingTop: theme.space(2),
      gap: theme.space(3),
    },
    headerBlock: {
      gap: theme.space(2),
      paddingBottom: theme.space(1),
    },
    badgeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.space(1.5),
    },
    title: {
      fontSize: theme.font.title - 3,
      fontWeight: '800',
      color: theme.color.text,
      letterSpacing: -0.4,
      lineHeight: 30,
    },
    companyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(1.5),
      flexWrap: 'wrap',
    },
    company: {
      fontSize: theme.font.label,
      color: theme.color.textMuted,
      fontWeight: '600',
    },
    dot: {
      color: theme.color.textFaint,
    },
    deadlineCard: {
      paddingVertical: theme.space(3.5),
    },
    deadlineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(3),
    },
    deadlineText: {
      flex: 1,
      gap: 1,
    },
    deadlineLabel: {
      fontSize: theme.font.body,
      fontWeight: '700',
      color: theme.color.text,
    },
    deadlineDate: {
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
    },
    summaryHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(1.5),
      marginBottom: theme.space(2),
    },
    summaryHeaderText: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      fontWeight: '600',
    },
    summaryText: {
      fontSize: theme.font.body,
      color: theme.color.text,
      lineHeight: 22,
    },
    flagList: {
      gap: theme.space(2.5),
    },
    flagItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.space(2),
    },
    flagText: {
      flex: 1,
      fontSize: theme.font.label,
      color: theme.color.text,
      lineHeight: 19,
    },
    matchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(3),
    },
    matchScore: {
      width: 62,
      height: 62,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    matchScoreValue: {
      fontSize: theme.font.heading,
      fontWeight: '800',
      color: theme.color.text,
    },
    matchScoreLabel: {
      fontSize: 10,
      color: theme.color.textFaint,
    },
    matchBody: {
      flex: 1,
      gap: 2,
    },
    matchTitle: {
      fontSize: theme.font.body,
      fontWeight: '700',
      color: theme.color.text,
    },
    matchHint: {
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
      lineHeight: 17,
    },
    pillWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.space(2),
    },
    bulletList: {
      gap: theme.space(2),
    },
    bulletItem: {
      flexDirection: 'row',
      gap: theme.space(2),
    },
    bulletDot: {
      color: theme.color.textFaint,
      fontSize: theme.font.body,
      lineHeight: 21,
    },
    bulletText: {
      flex: 1,
      fontSize: theme.font.label,
      color: theme.color.text,
      lineHeight: 20,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.space(3),
    },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.color.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNumberText: {
      fontSize: theme.font.caption,
      fontWeight: '800',
      color: theme.color.primary,
    },
    stepBody: {
      flex: 1,
      gap: 2,
    },
    stepTitle: {
      fontSize: theme.font.body,
      fontWeight: '700',
      color: theme.color.text,
    },
    stepHint: {
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
      lineHeight: 17,
    },
    fieldLabel: {
      fontSize: theme.font.caption,
      fontWeight: '700',
      color: theme.color.textMuted,
      marginBottom: theme.space(1.5),
    },
    input: {
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
    resumeRow: {
      flexDirection: 'row',
      gap: theme.space(2),
    },
    resumeChip: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: theme.space(2.5),
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    resumeChipActive: {
      backgroundColor: theme.color.primarySoft,
      borderColor: theme.color.primary,
    },
    resumeChipText: {
      fontSize: theme.font.label,
      fontWeight: '700',
      color: theme.color.textMuted,
    },
    resumeChipTextActive: {
      color: theme.color.primary,
    },
    appliedBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(2.5),
      padding: theme.space(3),
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.successSoft,
      marginBottom: theme.space(3),
    },
    appliedBody: {
      flex: 1,
      gap: 1,
    },
    appliedTitle: {
      fontSize: theme.font.label,
      fontWeight: '700',
      color: theme.color.success,
    },
    appliedHint: {
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
    },
    spacer: {
      marginTop: theme.space(3),
    },
    spacerSmall: {
      marginTop: theme.space(2.5),
    },
    secondaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.space(2),
      paddingVertical: theme.space(3),
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.borderStrong,
    },
    secondaryButtonText: {
      fontSize: theme.font.label,
      fontWeight: '600',
      color: theme.color.textMuted,
    },
    actionNote: {
      marginTop: theme.space(3),
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      lineHeight: 17,
    },
  });

const styles = {
  light: makeStyles(palettes.light),
  dark: makeStyles(palettes.dark),
};
