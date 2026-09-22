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

  const { jobs, newCount, loading, refreshing, error, lastSyncedAt, fromCache, refresh } = useJobs();
  const { ready, hint } = useConfigStatus();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');

  // A tapped notification routes here with `?filter=new`, so the user lands
  // directly on what the notification was about.
  const params = useLocalSearchParams<{ filter?: string }>();
  useEffect(() => {
    if (params.filter === 'new' || params.filter === 'closing' || params.filter === 'all') {
      setFilter(params.filter);
    }
  }, [params.filter]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    let list = jobs.filter((job) => {
      if (filter === 'new' && !job.isNew) return false;
      if (filter === 'closing') {
        const days = daysUntil(job.deadline);
        // Only jobs that are still open and within three weeks.
        if (days === null || days < 0 || days > 21) return false;
      }
      return true;
    });

    if (needle) {
      list = list.filter((job) => matches(job, needle));
    }

    // "Closing soon" is only useful when ordered by deadline.
    if (filter === 'closing') {
      list = [...list].sort((a, b) => {
        const left = daysUntil(a.deadline) ?? Number.MAX_SAFE_INTEGER;
        const right = daysUntil(b.deadline) ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });
    }

    return list;
  }, [jobs, filter, query]);

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

        <View style={s.filterRow}>
          {FILTERS.map((option) => {
            const active = filter === option.key;
            const count =
              option.key === 'new' ? newCount : option.key === 'all' ? jobs.length : undefined;
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
      </View>

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
          data={visible}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={[
            s.listContent,
            visible.length === 0 ? s.listContentEmpty : null,
          ]}
          ItemSeparatorComponent={Separator}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={theme.color.primary}
              colors={[theme.color.primary]}
            />
          }
          ListEmptyComponent={<EmptyList filter={filter} query={query} onReset={() => { setFilter('all'); setQuery(''); }} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        />
      )}
    </View>
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
  query,
  onReset,
}: {
  filter: FilterKey;
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
