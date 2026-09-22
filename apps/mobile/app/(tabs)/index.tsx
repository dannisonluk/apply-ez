import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JobCard } from '../../src/components/JobCard';
import { EmptyState, Notice, Spinner } from '../../src/components/ui';
import { daysUntil, formatRelative } from '../../src/lib/format';
import { useConfigStatus, useJobs } from '../../src/state/jobs';
import { palettes, useTheme, type Theme } from '../../src/theme';
import type { JobView } from '../../src/types';

type FilterKey = 'all' | 'new' | 'closing';
/** Which half of the board is being shown. */
type StatusKey = 'active' | 'closed';

const FILTERS: Array<{ key: FilterKey; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { key: 'all', label: 'All', icon: 'list-outline' },
  { key: 'new', label: 'New', icon: 'sparkles-outline' },
  { key: 'closing', label: 'Closing soon', icon: 'hourglass-outline' },
];

export default function JobsScreen(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const {
    jobs,
    visible,
    lowRelevance,
    expired,
    newCount,
    loading,
    refreshing,
    error,
    lastSyncedAt,
    fromCache,
    refresh,
    minRelevance,
    showFiltered,
    setShowFiltered,
  } = useJobs();
  const { ready, hint } = useConfigStatus();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [status, setStatus] = useState<StatusKey>('active');
  const [query, setQuery] = useState('');

  // A tapped notification routes here with `?filter=new`, so the user lands
  // directly on what the notification was about.
  const params = useLocalSearchParams<{ filter?: string }>();
  useEffect(() => {
    if (params.filter === 'new' || params.filter === 'closing' || params.filter === 'all') {
      setFilter(params.filter);
    }
  }, [params.filter]);

  // The active band: everything except the postings the reconcile retired.
  //
  // `showFiltered` has to change what is rendered, not only what the banner says.
  // It widens the pool by re-deriving from `jobs` rather than by concatenating
  // `visible` and `lowRelevance`, so the server's ordering (first_seen_at desc)
  // still holds across both bands — a revealed low-match job appears where it
  // belongs chronologically instead of being appended after every high-match one.
  const activePool = useMemo(
    () => (showFiltered ? jobs.filter((job) => !job.isExpired) : visible),
    [showFiltered, jobs, visible],
  );

  // Expired jobs are never mixed into the active list: a closed posting is not
  // actionable, so it must not compete with live ones for attention.
  const base = status === 'closed' ? expired : activePool;

  // Chip counts describe the pool they filter. Deriving them from `visible` alone
  // would let the banner announce "Showing 135 low-match jobs" while "All" still
  // reported only the high-match total.
  const newInPool = useMemo(
    () => activePool.filter((job) => job.isNew).length,
    [activePool],
  );

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();

    let next = base.filter((job) => {
      if (status === 'closed') return true;
      if (filter === 'new' && !job.isNew) return false;
      if (filter === 'closing') {
        const days = daysUntil(job.deadline);
        // Only jobs that are still open and within three weeks.
        if (days === null || days < 0 || days > 21) return false;
      }
      return true;
    });

    if (needle) next = next.filter((job) => matches(job, needle));

    // "Closing soon" is only useful when ordered by deadline.
    if (filter === 'closing' && status === 'active') {
      next = [...next].sort((a, b) => {
        const left = daysUntil(a.deadline) ?? Number.MAX_SAFE_INTEGER;
        const right = daysUntil(b.deadline) ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });
    }

    return next;
  }, [base, filter, status, query]);

  const openJob = useCallback(
    (job: JobView) => {
      router.push(`/job/${job.id}`);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: JobView }) => <JobCard job={item} onPress={openJob} />,
    [openJob],
  );

  const keyExtractor = useCallback((item: JobView) => item.id, []);

  if (!ready) {
    return (
      <View style={[s.screen, { paddingTop: insets.top + theme.space(4) }]}>
        <EmptyState
          icon="construct-outline"
          title="Not configured yet"
          message={hint ?? 'Supabase credentials are missing.'}
        />
      </View>
    );
  }

  const hiddenCount = lowRelevance.length;

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <View style={s.titleRow}>
          <Text style={s.title}>Jobs</Text>
          {newCount > 0 ? (
            <View style={s.newCountPill}>
              <Text style={s.newCountText}>{newCount} new</Text>
            </View>
          ) : null}
        </View>
        <Text style={s.subtitle}>{syncLabel(lastSyncedAt, fromCache)}</Text>

        <View style={s.searchWrap}>
          <Ionicons name="search-outline" size={16} color={theme.color.textFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search title, company or skill"
            placeholderTextColor={theme.color.textFaint}
            style={s.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {query.length > 0 ? (
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button">
              <Ionicons name="close-circle" size={16} color={theme.color.textFaint} />
            </Pressable>
          ) : null}
        </View>

        {/* Active vs closed. A segmented control rather than a chip, because these
            two are mutually exclusive views of the board, not stackable filters. */}
        <View style={s.segment}>
          <SegmentButton
            label="Active"
            count={activePool.length}
            active={status === 'active'}
            onPress={() => setStatus('active')}
          />
          <SegmentButton
            label="Closed"
            count={expired.length}
            active={status === 'closed'}
            onPress={() => setStatus('closed')}
          />
        </View>

        {status === 'active' ? (
          <View style={s.filterRow}>
            {FILTERS.map((option) => {
              const active = filter === option.key;
              const count =
                option.key === 'new'
                  ? newInPool
                  : option.key === 'all'
                    ? activePool.length
                    : undefined;
              return (
                <Pressable
                  key={option.key}
                  onPress={() => setFilter(option.key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[s.chip, active ? s.chipActive : null]}
                >
                  <Ionicons
                    name={option.icon}
                    size={13}
                    color={active ? theme.color.primary : theme.color.textMuted}
                  />
                  <Text style={[s.chipText, active ? s.chipTextActive : null]}>
                    {option.label}
                    {count !== undefined ? ` ${count}` : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={s.closedHint}>
            Postings the scraper no longer finds on the company site. Kept here so a job never
            silently disappears.
          </Text>
        )}
      </View>

      {/* The relevance filter is never silent: when it hides something, it says how
          much and offers to reveal it. A filter that hides jobs without saying so is
          how you miss the one posting you would have wanted. */}
      {status === 'active' && hiddenCount > 0 && !showFiltered ? (
        <Pressable
          onPress={() => setShowFiltered(true)}
          accessibilityRole="button"
          style={s.hiddenBanner}
        >
          <Ionicons name="funnel-outline" size={14} color={theme.color.textMuted} />
          <Text style={s.hiddenText}>
            {hiddenCount} low-match {hiddenCount === 1 ? 'job' : 'jobs'} hidden (below{' '}
            {minRelevance})
          </Text>
          <Text style={s.hiddenAction}>Show</Text>
        </Pressable>
      ) : null}

      {status === 'active' && showFiltered && hiddenCount > 0 ? (
        <Pressable
          onPress={() => setShowFiltered(false)}
          accessibilityRole="button"
          style={s.hiddenBanner}
        >
          <Ionicons name="funnel" size={14} color={theme.color.primary} />
          <Text style={s.hiddenText}>
            Showing {hiddenCount} low-match {hiddenCount === 1 ? 'job' : 'jobs'}
          </Text>
          <Text style={s.hiddenAction}>Hide</Text>
        </Pressable>
      ) : null}

      {error ? (
        <View style={s.noticeWrap}>
          <Notice
            tone="danger"
            title="Could not refresh"
            message={`${error}${fromCache ? ' Showing the last saved list.' : ''}`}
            onRetry={() => void refresh()}
          />
        </View>
      ) : null}

      {loading ? (
        <Spinner label="Loading jobs…" />
      ) : (
        <FlatList
          data={list}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={[s.listContent, list.length === 0 ? s.listContentEmpty : null]}
          ItemSeparatorComponent={Separator}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={theme.color.primary}
              colors={[theme.color.primary]}
            />
          }
          ListEmptyComponent={
            <EmptyList
              filter={filter}
              status={status}
              query={query}
              onReset={() => {
                setFilter('all');
                setQuery('');
              }}
            />
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        />
      )}
    </View>
  );
}

function SegmentButton({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[s.segmentButton, active ? s.segmentButtonActive : null]}
    >
      <Text style={[s.segmentText, active ? s.segmentTextActive : null]}>
        {label} {count}
      </Text>
    </Pressable>
  );
}

function matches(job: JobView, needle: string): boolean {
  return (
    job.title.toLowerCase().includes(needle) ||
    job.companyName.toLowerCase().includes(needle) ||
    (job.department?.toLowerCase().includes(needle) ?? false) ||
    job.skills.some((skill) => skill.toLowerCase().includes(needle)) ||
    job.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

function syncLabel(lastSyncedAt: number | null, fromCache: boolean): string {
  if (!lastSyncedAt) return 'Not synced yet';
  const relative = formatRelative(new Date(lastSyncedAt).toISOString());
  return fromCache ? `Saved copy · ${relative}` : `Updated ${relative}`;
}

function Separator(): React.JSX.Element {
  const theme = useTheme();
  return <View style={{ height: theme.space(3) }} />;
}

function EmptyList({
  filter,
  status,
  query,
  onReset,
}: {
  filter: FilterKey;
  status: StatusKey;
  query: string;
  onReset: () => void;
}): React.JSX.Element {
  if (query.trim()) {
    return (
      <EmptyState
        icon="search-outline"
        title="No matches"
        message={`Nothing matches “${query.trim()}”.`}
        actionLabel="Clear search"
        onAction={onReset}
      />
    );
  }
  if (status === 'closed') {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Nothing closed yet"
        message="Jobs appear here once the scraper stops finding them on the company site. Nothing has been retired so far."
      />
    );
  }
  if (filter === 'new') {
    return (
      <EmptyState
        icon="sparkles-outline"
        title="Nothing new"
        message="No jobs have been posted since you last opened the app. The scraper runs every four hours."
        actionLabel="Show all jobs"
        onAction={onReset}
      />
    );
  }
  if (filter === 'closing') {
    return (
      <EmptyState
        icon="hourglass-outline"
        title="Nothing closing soon"
        message="No open postings have a deadline in the next three weeks."
        actionLabel="Show all jobs"
        onAction={onReset}
      />
    );
  }
  return (
    <EmptyState
      icon="briefcase-outline"
      title="No jobs yet"
      message="Once the scraper completes its first run, postings will appear here. You can also pull down to refresh."
    />
  );
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
      gap: theme.space(2),
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(2.5),
    },
    title: {
      fontSize: theme.font.title,
      fontWeight: '800',
      color: theme.color.text,
      letterSpacing: -0.5,
    },
    newCountPill: {
      backgroundColor: theme.color.primarySoft,
      paddingHorizontal: theme.space(2.5),
      paddingVertical: 3,
      borderRadius: theme.radius.pill,
    },
    newCountText: {
      color: theme.color.primary,
      fontSize: theme.font.caption,
      fontWeight: '700',
    },
    subtitle: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      marginTop: -theme.space(1),
    },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(2),
      backgroundColor: theme.color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(2),
    },
    searchInput: {
      flex: 1,
      fontSize: theme.font.body,
      color: theme.color.text,
      padding: 0,
    },
    segment: {
      flexDirection: 'row',
      backgroundColor: theme.color.surfaceAlt,
      borderRadius: theme.radius.md,
      padding: 3,
      gap: 3,
    },
    segmentButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.space(2),
      borderRadius: theme.radius.sm,
    },
    segmentButtonActive: {
      backgroundColor: theme.color.surface,
    },
    segmentText: {
      fontSize: theme.font.label,
      fontWeight: '700',
      color: theme.color.textMuted,
    },
    segmentTextActive: {
      color: theme.color.primary,
    },
    filterRow: {
      flexDirection: 'row',
      gap: theme.space(2),
      flexWrap: 'wrap',
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(1.5),
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(1.5),
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    chipActive: {
      backgroundColor: theme.color.primarySoft,
      borderColor: theme.color.primary,
    },
    chipText: {
      fontSize: theme.font.label,
      color: theme.color.textMuted,
      fontWeight: '600',
    },
    chipTextActive: {
      color: theme.color.primary,
    },
    closedHint: {
      fontSize: theme.font.caption,
      color: theme.color.textFaint,
      lineHeight: 17,
    },
    hiddenBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(2),
      marginHorizontal: theme.space(4),
      marginBottom: theme.space(2),
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(2),
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.surfaceAlt,
    },
    hiddenText: {
      flex: 1,
      fontSize: theme.font.caption,
      color: theme.color.textMuted,
    },
    hiddenAction: {
      fontSize: theme.font.caption,
      fontWeight: '700',
      color: theme.color.primary,
    },
    noticeWrap: {
      paddingHorizontal: theme.space(4),
      paddingBottom: theme.space(2),
    },
    listContent: {
      paddingHorizontal: theme.space(4),
      paddingBottom: theme.space(10),
    },
    listContentEmpty: {
      flexGrow: 1,
    },
  });

const styles = {
  light: makeStyles(palettes.light),
  dark: makeStyles(palettes.dark),
};
