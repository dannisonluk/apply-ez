import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
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

// ─── filter panel ────────────────────────────────────────────────────────────

type SortKey = 'discovered' | 'posted' | 'match';

/** Vertical room the job list keeps for itself when the filter panel is open. */
const MIN_LIST_HEIGHT = 140;

const SORTS: Array<{ key: SortKey; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { key: 'discovered', label: 'Newest', icon: 'sparkles-outline' },
  { key: 'posted', label: 'Posted', icon: 'calendar-outline' },
  { key: 'match', label: 'Best match', icon: 'star-outline' },
];

/**
 * Years-of-experience buckets.
 *
 * Buckets rather than a slider because the underlying number is genuinely coarse:
 * it is whatever the model read off the JD, and a posting that says "3 to 5 years"
 * has a range, not a point. A slider would imply a precision the data does not have.
 *
 * "Not stated" is a real bucket, not a fallback. Before enrichment runs, no job has
 * a YOE at all, and hiding those silently would empty the board.
 */
const YOE_BUCKETS: Array<{
  key: string;
  label: string;
  min: number | null;
  max: number | null;
}> = [
  { key: '0-2', label: '0–2 yrs', min: 0, max: 2 },
  { key: '3-5', label: '3–5 yrs', min: 3, max: 5 },
  { key: '6-9', label: '6–9 yrs', min: 6, max: 9 },
  { key: '10+', label: '10+ yrs', min: 10, max: Number.MAX_SAFE_INTEGER },
  { key: 'unspecified', label: 'Not stated', min: null, max: null },
];

const EMPLOYMENT_TYPES: Array<{ key: string; label: string }> = [
  { key: 'PERMANENT', label: 'Permanent' },
  { key: 'CONTRACT', label: 'Contract' },
  { key: 'INTERNSHIP', label: 'Internship' },
];

/** Best available years-of-experience: the model's range wins over the scraped floor. */
function jobYoe(job: JobView): number | null {
  return job.yoeMin ?? job.experienceMin ?? null;
}

function matchesYoe(job: JobView, key: string): boolean {
  const bucket = YOE_BUCKETS.find((entry) => entry.key === key);
  if (!bucket) return true;
  const yoe = jobYoe(job);
  if (bucket.min === null) return yoe === null;
  if (yoe === null) return false;
  return yoe >= bucket.min && yoe <= (bucket.max ?? Number.MAX_SAFE_INTEGER);
}

/** Counted from the pool, so a facet option is never offered with zero results. */
function facetCounts(
  jobs: JobView[],
  keyOf: (job: JobView) => string | null,
  labelOf: (job: JobView) => string,
): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const job of jobs) {
    const key = keyOf(job);
    if (!key) continue;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { label: labelOf(job), count: 1 });
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, label: value.label, count: value.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Add or remove one value from a multi-select list without mutating it. */
function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function JobsScreen(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // Where the panel starts, so the cap can be "what is actually left below it"
  // rather than a flat fraction of the window. A fraction ignores the header above
  // it: at 55% of a short viewport the panel still ran off the bottom, because the
  // header had already eaten half the screen. Null until the first layout.
  const [panelTop, setPanelTop] = useState<number | null>(null);
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

  // Panel filters. Component state rather than persisted storage, unlike the
  // relevance threshold and the show-filtered switch: those are standing
  // preferences, these are "what am I looking at right now" and should not survive
  // a restart as a filter you forgot to clear.
  const [panelOpen, setPanelOpen] = useState(false);
  const [companies, setCompanies] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [yoe, setYoe] = useState<string | null>(null);
  const [employment, setEmployment] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('discovered');

  /** Shown on the panel chip, so an active filter can never be invisible. */
  const activeFilterCount =
    companies.length + departments.length + (yoe ? 1 : 0) + (employment ? 1 : 0);

  const clearFilters = useCallback(() => {
    setCompanies([]);
    setDepartments([]);
    setYoe(null);
    setEmployment(null);
  }, []);

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
  /**
   * Everything the panel and the search box select, before the All / New /
   * Closing chips are applied.
   *
   * Split out so all three chips can report against the same pool. Counting the
   * All chip off `activePool` instead made the filters look broken: selecting a
   * company changed the list but not the number, which reads as "nothing
   * happened".
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return base.filter((job) => {
      if (companies.length > 0 && !companies.includes(job.companySlug)) return false;
      if (departments.length > 0 && !(job.department && departments.includes(job.department))) {
        return false;
      }
      if (yoe && !matchesYoe(job, yoe)) return false;
      if (employment && job.employmentType !== employment) return false;
      if (needle && !matches(job, needle)) return false;
      return true;
    });
  }, [base, query, companies, departments, yoe, employment]);

  /** True for an open posting whose deadline is inside the next three weeks. */
  const isClosingSoon = useCallback((job: JobView): boolean => {
    const days = daysUntil(job.deadline);
    return days !== null && days >= 0 && days <= 21;
  }, []);

  const chipCounts = useMemo(
    () => ({
      all: filtered.length,
      new: filtered.filter((job) => job.isNew).length,
      closing: filtered.filter(isClosingSoon).length,
    }),
    [filtered, isClosingSoon],
  );

  // Facet options are counted from the pool currently in view, so the panel never
  // offers an option that has zero results behind it.
  const companyFacets = useMemo(
    () =>
      facetCounts(base, (job) => job.companySlug || job.companyName, (job) => job.companyName),
    [base],
  );

  const departmentFacets = useMemo(
    () => facetCounts(base, (job) => job.department, (job) => job.department ?? ''),
    [base],
  );

  // Bucket counts need the bucket logic rather than a plain key, so they are
  // counted by walking the buckets per job — still linear, and one job lands in
  // exactly one bucket by construction.
  const yoeFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const job of base) {
      for (const bucket of YOE_BUCKETS) {
        if (matchesYoe(job, bucket.key)) {
          counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
          break;
        }
      }
    }
    return counts;
  }, [base]);

  const employmentFacets = useMemo(
    () => facetCounts(base, (job) => job.employmentType, (job) => job.employmentType ?? ''),
    [base],
  );

  const list = useMemo(() => {
    // The All / New / Closing chips only mean something on the active board.
    let next = filtered;
    if (status === 'active') {
      if (filter === 'new') next = next.filter((job) => job.isNew);
      if (filter === 'closing') next = next.filter(isClosingSoon);
    }

    // "Closing soon" is only useful when ordered by deadline, so it wins over the
    // sort picker rather than being overridden by it.
    if (filter === 'closing' && status === 'active') {
      return [...next].sort((a, b) => {
        const left = daysUntil(a.deadline) ?? Number.MAX_SAFE_INTEGER;
        const right = daysUntil(b.deadline) ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });
    }

    return [...next].sort((a, b) => {
      // firstSeenAt is the tiebreak everywhere: it is the only field every row
      // has, and it is what "newest" actually means to the user.
      const seenDesc = Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt);
      if (sort === 'match') {
        if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
        return seenDesc;
      }
      if (sort === 'posted') {
        const left = Date.parse(a.publishedAt);
        const right = Date.parse(b.publishedAt);
        if (right !== left) return right - left;
        return seenDesc;
      }
      return seenDesc;
    });
  }, [filtered, filter, status, sort, isClosingSoon]);

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
              // Every chip counts the same pool, so the three of them add up to
              // something the user can reason about while filtering.
              const count =
                option.key === 'new'
                  ? chipCounts.new
                  : option.key === 'all'
                    ? chipCounts.all
                    : chipCounts.closing;
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

      {/* Panel toggle. Offered on the Closed tab as well: a company filter is how
          you answer "has MTR closed anything recently". */}
      <Pressable
        testID="filters-toggle"
        onPress={() => setPanelOpen((open) => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: panelOpen }}
        style={[s.panelToggle, activeFilterCount > 0 ? s.panelToggleActive : null]}
      >
        <Ionicons
          name="options-outline"
          size={14}
          color={activeFilterCount > 0 ? theme.color.primary : theme.color.textMuted}
        />
        <Text style={[s.panelToggleText, activeFilterCount > 0 ? s.panelToggleTextActive : null]}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Text>
        <Ionicons
          name={panelOpen ? 'chevron-up-outline' : 'chevron-down-outline'}
          size={13}
          color={theme.color.textFaint}
        />
      </Pressable>

      {panelOpen ? (
        <View
          testID="filters-panel"
          style={s.panel}
          onLayout={(event) => setPanelTop(event.nativeEvent.layout.y)}
        >
          {/* The panel renders above the list rather than inside it, so when it grows
              taller than the space left under the header there is nothing to scroll
              it and the last facets fall off the bottom of the screen with no way to
              reach them. Capping the height and scrolling the facets keeps every
              filter reachable without turning the whole screen into a scroll view,
              which would break the list's own scrolling and pull-to-refresh. */}
          <ScrollView
            style={{
              maxHeight:
                panelTop === null
                  ? Math.round(windowHeight * 0.55)
                  : Math.max(
                      180,
                      Math.round(windowHeight - insets.top - panelTop - MIN_LIST_HEIGHT),
                    ),
            }}
            contentContainerStyle={s.panelScrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
          <FilterSection label="Sort" testID="facet-sort">
            {SORTS.map((option) => (
              <OptionChip
                key={option.key}
                label={option.label}
                icon={option.icon}
                selected={sort === option.key}
                onPress={() => setSort(option.key)}
              />
            ))}
          </FilterSection>

          <FilterSection label={`Company (${companyFacets.length})`} testID="facet-company">
            {companyFacets.map((facet) => (
              <OptionChip
                key={facet.key}
                label={facet.label}
                count={facet.count}
                selected={companies.includes(facet.key)}
                onPress={() => setCompanies((current) => toggleValue(current, facet.key))}
              />
            ))}
          </FilterSection>

          {departmentFacets.length > 0 ? (
            <FilterSection label="Department" testID="facet-department">
              {departmentFacets.slice(0, 12).map((facet) => (
                <OptionChip
                  key={facet.key}
                  label={facet.label}
                  count={facet.count}
                  selected={departments.includes(facet.key)}
                  onPress={() => setDepartments((current) => toggleValue(current, facet.key))}
                />
              ))}
            </FilterSection>
          ) : null}

          <FilterSection label="Experience" testID="facet-experience">
            {YOE_BUCKETS.map((bucket) => (
              <OptionChip
                key={bucket.key}
                label={bucket.label}
                count={yoeFacets.get(bucket.key) ?? 0}
                selected={yoe === bucket.key}
                onPress={() => setYoe((current) => (current === bucket.key ? null : bucket.key))}
              />
            ))}
          </FilterSection>

          <FilterSection label="Type" testID="facet-type">
            {EMPLOYMENT_TYPES.map((option) => (
              <OptionChip
                key={option.key}
                label={option.label}
                count={employmentFacets.find((facet) => facet.key === option.key)?.count ?? 0}
                selected={employment === option.key}
                onPress={() =>
                  setEmployment((current) => (current === option.key ? null : option.key))
                }
              />
            ))}
          </FilterSection>

          {activeFilterCount > 0 ? (
            <Pressable onPress={clearFilters} accessibilityRole="button" style={s.clearButton}>
              <Ionicons name="close-circle-outline" size={14} color={theme.color.textMuted} />
              <Text style={s.clearText}>Clear all filters</Text>
            </Pressable>
          ) : null}
          </ScrollView>
        </View>
      ) : null}

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

/** One option in the filter panel, using the same chip language as the list. */
function OptionChip({
  label,
  icon,
  selected,
  count,
  onPress,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap | undefined;
  selected: boolean;
  count?: number | undefined;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[s.chip, selected ? s.chipActive : null]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={13}
          color={selected ? theme.color.primary : theme.color.textMuted}
        />
      ) : null}
      <Text style={[s.chipText, selected ? s.chipTextActive : null]}>
        {label}
        {count !== undefined ? ` ${count}` : ''}
      </Text>
    </Pressable>
  );
}

function FilterSection({
  label,
  testID,
  children,
}: {
  label: string;
  /** Scopes the chips for tests, which would otherwise have to guess from text. */
  testID: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <View testID={testID} style={s.panelSection}>
      <Text style={s.panelLabel}>{label}</Text>
      <View style={s.panelOptions}>{children}</View>
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
        message="No jobs have been posted since you last opened the app. The scraper runs every six hours."
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
    panelToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: theme.space(1.5),
      marginHorizontal: theme.space(4),
      marginBottom: theme.space(2),
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(1.5),
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    panelToggleActive: {
      backgroundColor: theme.color.primarySoft,
      borderColor: theme.color.primary,
    },
    panelToggleText: {
      fontSize: theme.font.label,
      fontWeight: '700',
      color: theme.color.textMuted,
    },
    panelToggleTextActive: {
      color: theme.color.primary,
    },
    panelScrollContent: {
      gap: theme.space(3),
    },
    panel: {
      marginHorizontal: theme.space(4),
      marginBottom: theme.space(2),
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(3),
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      gap: theme.space(3),
    },
    panelSection: {
      gap: theme.space(1.5),
    },
    panelLabel: {
      fontSize: theme.font.caption,
      fontWeight: '700',
      color: theme.color.textMuted,
    },
    panelOptions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.space(1.5),
    },
    clearButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.space(1.5),
      paddingVertical: theme.space(2),
    },
    clearText: {
      fontSize: theme.font.caption,
      fontWeight: '700',
      color: theme.color.textMuted,
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
