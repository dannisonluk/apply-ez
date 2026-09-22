import { useColorScheme } from 'react-native';

/**
 * Two full palettes rather than a single scheme with overrides — dark mode
 * surfaces need different lightness relationships, not inverted hues. Inverting
 * a light palette gives muddy greys and unreadable accent colours.
 */
export interface Theme {
  scheme: 'light' | 'dark';
  color: {
    background: string;
    surface: string;
    surfaceAlt: string;
    border: string;
    borderStrong: string;
    text: string;
    textMuted: string;
    textFaint: string;
    primary: string;
    primarySoft: string;
    onPrimary: string;
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    danger: string;
    dangerSoft: string;
    newBadge: string;
    onNewBadge: string;
  };
  space: (n: number) => number;
  radius: { sm: number; md: number; lg: number; pill: number };
  font: {
    title: number;
    heading: number;
    body: number;
    label: number;
    caption: number;
  };
}

const SPACING_UNIT = 4;

const light: Theme = {
  scheme: 'light',
  color: {
    background: '#F5F7FA',
    surface: '#FFFFFF',
    surfaceAlt: '#F1F3F7',
    border: '#E3E7EE',
    borderStrong: '#CBD2DD',
    text: '#0F172A',
    textMuted: '#5A6577',
    textFaint: '#94A0B3',
    primary: '#2563EB',
    primarySoft: '#EDF3FE',
    onPrimary: '#FFFFFF',
    success: '#067647',
    successSoft: '#E9F9F0',
    warning: '#B54708',
    warningSoft: '#FEF6E7',
    danger: '#B42318',
    dangerSoft: '#FEF1F0',
    newBadge: '#2563EB',
    onNewBadge: '#FFFFFF',
  },
  space: (n) => n * SPACING_UNIT,
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  font: { title: 26, heading: 18, body: 15, label: 13, caption: 12 },
};

const dark: Theme = {
  scheme: 'dark',
  color: {
    background: '#0B1220',
    surface: '#131C2E',
    surfaceAlt: '#1A2438',
    border: '#26314A',
    borderStrong: '#35425E',
    text: '#E9EEF8',
    textMuted: '#9AA7BD',
    textFaint: '#6B7A94',
    primary: '#6BA1FF',
    primarySoft: '#17253F',
    onPrimary: '#0B1220',
    success: '#4ADE80',
    successSoft: '#11271C',
    warning: '#FBBF24',
    warningSoft: '#2B2210',
    danger: '#FB7185',
    dangerSoft: '#2B1519',
    newBadge: '#6BA1FF',
    onNewBadge: '#0B1220',
  },
  space: (n) => n * SPACING_UNIT,
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  font: { title: 26, heading: 18, body: 15, label: 13, caption: 12 },
};

export const palettes = { light, dark };

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}

/** Card elevation. Shadows are near-invisible on dark surfaces, so dark mode
 *  relies on a slightly lighter surface plus a border instead. */
export function cardShadow(theme: Theme) {
  if (theme.scheme === 'dark') return {};
  return {
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  };
}
