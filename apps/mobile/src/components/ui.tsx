import { Ionicons } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { cardShadow, palettes, useTheme, type Theme } from '../theme';

/**
 * Shared primitives.
 *
 * Styles are precomputed for both schemes at module load rather than rebuilt per
 * render — with a few hundred job cards in a list, recreating style objects on
 * every frame is measurable.
 */

export type PillTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

// ─── layout ──────────────────────────────────────────────────────────────────

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return <View style={[s.card, cardShadow(theme), style]}>{children}</View>;
}

export function Section({
  title,
  children,
  style,
}: {
  title?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <View style={[s.section, style]}>
      {title ? <Text style={s.sectionTitle}>{title.toUpperCase()}</Text> : null}
      {children}
    </View>
  );
}

export function Divider(): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles[theme.scheme].divider]} />;
}

// ─── atoms ───────────────────────────────────────────────────────────────────

export function Pill({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: PillTone;
  icon?: keyof typeof Ionicons.glyphMap;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const palette = tonePalette(theme, tone);

  return (
    <View style={[s.pill, { backgroundColor: palette.background }]}>
      {icon ? <Ionicons name={icon} size={12} color={palette.foreground} /> : null}
      <Text style={[s.pillText, { color: palette.foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function tonePalette(theme: Theme, tone: PillTone): { background: string; foreground: string } {
  switch (tone) {
    case 'primary':
      return { background: theme.color.primarySoft, foreground: theme.color.primary };
    case 'success':
      return { background: theme.color.successSoft, foreground: theme.color.success };
    case 'warning':
      return { background: theme.color.warningSoft, foreground: theme.color.warning };
    case 'danger':
      return { background: theme.color.dangerSoft, foreground: theme.color.danger };
    default:
      return { background: theme.color.surfaceAlt, foreground: theme.color.textMuted };
  }
}

export function NewBadge(): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <View style={s.newBadge}>
      <Text style={s.newBadgeText}>NEW</Text>
    </View>
  );
}

/** Count bubble for the tab bar. Hidden at zero so it never becomes wallpaper. */
export function CountBadge({ count }: { count: number }): React.JSX.Element | null {
  const theme = useTheme();
  const s = styles[theme.scheme];
  if (count <= 0) return null;
  return (
    <View style={s.countBadge}>
      <Text style={s.countBadgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

export function DetailRow({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  tone?: PillTone;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const palette = tonePalette(theme, tone);
  return (
    <View style={s.detailRow}>
      <Ionicons name={icon} size={16} color={theme.color.textFaint} style={s.detailIcon} />
      <Text style={s.detailLabel}>{label}</Text>
      <Text style={[s.detailValue, { color: tone === 'neutral' ? theme.color.text : palette.foreground }]}>
        {value}
      </Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        s.button,
        pressed && !disabled ? s.buttonPressed : null,
        disabled ? s.buttonDisabled : null,
      ]}
    >
      {icon ? <Ionicons name={icon} size={17} color={theme.color.onPrimary} /> : null}
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <View style={s.centered}>
      <ActivityIndicator color={theme.color.primary} />
      {label ? <Text style={s.centeredText}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  return (
    <View style={s.centered}>
      <View style={s.emptyIconWrap}>
        <Ionicons name={icon} size={28} color={theme.color.textFaint} />
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyMessage}>{message}</Text>
      {actionLabel && onAction ? (
        <View style={s.emptyAction}>
          <PrimaryButton label={actionLabel} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

/** Inline warning strip. Used for config problems and fetch failures. */
export function Notice({
  tone = 'warning',
  title,
  message,
  onRetry,
}: {
  tone?: 'warning' | 'danger';
  title: string;
  message: string;
  onRetry?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const s = styles[theme.scheme];
  const palette = tonePalette(theme, tone);
  return (
    <View style={[s.notice, { backgroundColor: palette.background, borderColor: palette.foreground }]}>
      <Ionicons
        name={tone === 'danger' ? 'alert-circle-outline' : 'information-circle-outline'}
        size={18}
        color={palette.foreground}
      />
      <View style={s.noticeBody}>
        <Text style={[s.noticeTitle, { color: palette.foreground }]}>{title}</Text>
        <Text style={[s.noticeMessage, { color: palette.foreground }]}>{message}</Text>
      </View>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button">
          <Text style={[s.noticeRetry, { color: palette.foreground }]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      padding: theme.space(4),
    },
    section: {
      marginBottom: theme.space(5),
    },
    sectionTitle: {
      fontSize: theme.font.caption,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: theme.color.textFaint,
      marginBottom: theme.space(2),
      marginLeft: theme.space(1),
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.color.border,
      marginVertical: theme.space(3),
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space(1),
      paddingHorizontal: theme.space(2.5),
      paddingVertical: theme.space(1),
      borderRadius: theme.radius.pill,
      alignSelf: 'flex-start',
      maxWidth: '100%',
    },
    pillText: {
      fontSize: theme.font.caption,
      fontWeight: '600',
    },
    newBadge: {
      backgroundColor: theme.color.newBadge,
      paddingHorizontal: theme.space(2),
      paddingVertical: 2,
      borderRadius: theme.radius.sm,
    },
    newBadgeText: {
      color: theme.color.onNewBadge,
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 0.6,
    },
    countBadge: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 5,
      borderRadius: 9,
      backgroundColor: theme.color.newBadge,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countBadgeText: {
      color: theme.color.onNewBadge,
      fontSize: 11,
      fontWeight: '800',
    },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.space(2),
    },
    detailIcon: {
      width: 24,
    },
    detailLabel: {
      fontSize: theme.font.body,
      color: theme.color.textMuted,
      flexShrink: 0,
    },
    detailValue: {
      fontSize: theme.font.body,
      fontWeight: '600',
      flex: 1,
      textAlign: 'right',
    },
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.space(2),
      backgroundColor: theme.color.primary,
      paddingVertical: theme.space(3.5),
      paddingHorizontal: theme.space(5),
      borderRadius: theme.radius.md,
    },
    buttonPressed: {
      opacity: 0.85,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonText: {
      color: theme.color.onPrimary,
      fontSize: theme.font.body,
      fontWeight: '700',
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.space(8),
      paddingVertical: theme.space(12),
      gap: theme.space(2),
    },
    centeredText: {
      fontSize: theme.font.body,
      color: theme.color.textMuted,
    },
    emptyIconWrap: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.color.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: theme.space(2),
    },
    emptyTitle: {
      fontSize: theme.font.heading,
      fontWeight: '700',
      color: theme.color.text,
      textAlign: 'center',
    },
    emptyMessage: {
      fontSize: theme.font.body,
      color: theme.color.textMuted,
      textAlign: 'center',
      lineHeight: 21,
    },
    emptyAction: {
      marginTop: theme.space(3),
    },
    notice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.space(2.5),
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      padding: theme.space(3),
    },
    noticeBody: {
      flex: 1,
      gap: 2,
    },
    noticeTitle: {
      fontSize: theme.font.label,
      fontWeight: '700',
    },
    noticeMessage: {
      fontSize: theme.font.caption,
      lineHeight: 17,
      opacity: 0.9,
    },
    noticeRetry: {
      fontSize: theme.font.label,
      fontWeight: '700',
    },
  });

const styles = {
  light: makeStyles(palettes.light),
  dark: makeStyles(palettes.dark),
};
