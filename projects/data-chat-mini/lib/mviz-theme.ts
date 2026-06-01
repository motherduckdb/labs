type MvizCustomTheme = {
  name?: string;
  extends?: 'light' | 'dark';
  colors?: Partial<{
    primary: string;
    secondary: string;
    tertiary: string;
    positive: string;
    warning: string;
    error: string;
    accent: string;
    background: string;
    paper: string;
    text: string;
    textSecondary: string;
    border: string;
  }>;
  palette?: string[];
  fonts?: {
    family?: string;
    mono?: string;
    import?: string;
  };
};

export const MVIZ_FONT_IMPORT_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';

export const MVIZ_CUSTOM_THEME = {
  name: 'data-chat',
  extends: 'light',
  colors: {
    background: '#FFFFFF',
    paper: '#FFFFFF',
    text: '#1C1E26',
    textSecondary: '#6B7280',
    border: '#ECEDEF',
    accent: '#2563EB',
    positive: '#0E9F6E',
    warning: '#F59E0B',
    error: '#DC2626',
  },
  palette: ['#9F7AEA', '#0D9488', '#60A5FA', '#F59E0B', '#9CA3AF', '#1D4ED8'],
  fonts: {
    family: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'Roboto Mono', ui-monospace, monospace",
    import: MVIZ_FONT_IMPORT_URL,
  },
} satisfies MvizCustomTheme;
