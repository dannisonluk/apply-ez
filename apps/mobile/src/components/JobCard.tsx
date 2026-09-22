import { Ionicons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { cardShadow, palettes, useTheme, type Theme } from '../theme';
import type { JobView } from '../types';
import {
  deadlineInfo,
  formatEmploymentType,
  formatRelative,
  formatSeniority,
  formatYoe,
  shortTitle,
} from '../lib/format';
import { NewBadge, Pill, type PillTone } from './ui';

/**
 * One row in the job list.
 *
 * Memoised because the list can hold a few hundred rows and the parent re-renders
 * on every refresh tick.
 */
export const JobCard = React.memo(function JobCard({
  job,
  onPress,
}: {
  job: JobView;
  onPress: (job: JobView) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];

  const deadline = useMemo(() => deadlineInfo(job.deadline), [job.deadline]);
  const deadlineTone: PillTone =
    deadline.tone === 'urgent'
      ? 'danger'
      : deadline.tone === 'soon'
        ? 'warning'
        : deadline.tone === 'open'
          ? 'success'
          : 'neutral';

  const yoe = formatYoe(job.yoeMin, job.yoeMax, job.experienceMin);
  const employment = formatEmploymentType(job.employmentType);
  const seniority = formatSeniority(job.seniority);
  const posted = formatRelative(job.firstSeenAt);

  // An expired posting is still shown, but never as if it were actionable: it is
  // dimmed and the deadline pill is replaced by a plain "Closed" label. This is the
  // difference between "this job closed" and "this job was never scraped", which
  // the app could not express before.
  const dimmed = job.isExpired || job.relevanceBand === 'low' || job.relevanceBand === 'filtered';

  return (
    <Pressable
      onPress={() => onPress(job)}
      accessibilityRole="button"
      accessibilityLabel={`${job.title} at ${job.companyName}${job.isExpired ? ', closed' : ''}`}
      style={({ pressed }) => [
        s.card,
        cardShadow(theme),
        dimmed ? s.cardDimmed : null,
        pressed ? s.pressed : null,
      ]}
    >
      <View style={s.headerRow}>
        {job.isNew && !job.isExpired ? <NewBadge /> : null}
        <Text style={s.title} numberOfLines={2}>
          {shortTitle(job.title, 96)}
        </Text>
      </View>

      <View style={s.metaRow}>
        <Ionicons name="business-outline" size={13} color={theme.color.textFaint} />
        <Text style={s.company} numberOfLines={1}>
          {job.companyName}
        </Text>
        {job.location ? (
          <>
            <Text style={s.dot}>·</Text>
            <Text style={s.location} numberOfLines={1}>
              {job.location}
            </Text>
          </>
        ) : null}
      </View>

      {job.summary ? (
        <Text style={s.summary} numberOfLines={2}>
          {job.summary}
        </Text>
      ) : null}

      <View style={s.pillRow}>
        {job.applied ? <Pill label="Applied" tone="success" icon="checkmark-circle" /> : null}
        {job.isExpired ? <Pill label="Closed" icon="lock-closed-outline" /> : null}
        {employment ? <Pill label={employment} tone="primary" /> : null}
        {seniority ? <Pill label={seniority} /> : null}
        {yoe ? <Pill label={yoe} icon="briefcase-outline" /> : null}
        {job.department ? <Pill label={job.department} /> : null}
      </View>

      <View style={s.footerRow}>
        {job.isExpired ? (
          <Pill label="No longer accepting" icon="close-circle-outline" />
        ) : deadline.label ? (
          <Pill
            label={deadline.label}
            tone={deadlineTone}
            icon={deadline.tone === 'passed' ? 'time-outline' : 'hourglass-outline'}
          />
        ) : (
          <View />
        )}
        <Text style={s.posted}>{posted}</Text>
      </View>

      {job.flags.length > 0 ? (
        <View style={s.flagRow}>
          <Ionicons name="warning-outline" size={13} color={theme.color.warning} />
          <Text style={s.flagText} numberOfLines={1}>
            {job.flags.join(' · ')}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      padding: theme.space(4),
      gap: theme.space(2),
    },
    cardDimmed: {
      opacity: 0.6,
    },
    pressed: {
      opacity: 0.7,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.space(2),
    },
    title: {
      flex: 1,
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
    dot: {
      color: theme.color.textFaint,
      fontSize: theme.font.label,
    },
    location: {
      fontSize: theme.font.label,
      color: theme.color.textFaint,
      flexShrink: 1,
    },
    summary: {
      fontSize: theme.font.label,
      color: theme.color.textMuted,
      lineHeight: 18,
    },
    pillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.space(1.5),
      marginTop: theme.space(0.5),
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.space(2),
      marginTop: theme.space(0.5),
    },
    posted: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
    },
    flagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(1.5),
      marginTop: theme.space(1),
      paddingTop: theme.space(2),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.color.border,
    },
    flagText: {
      flex: 1,
      fontSize: theme.font.caption,
      color: theme.color.warning,
    },
  });

const styles = {
  light: makeStyles(palettes.light),
  dark: makeStyles(palettes.dark),
};
