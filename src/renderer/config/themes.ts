// Mercy Theme Engine — preset definitions. Each preset is a FULL token set
// (surfaces, text, accent, status colors), not a single accent swap — that's
// the difference between a real theme and a color filter. Every key here
// maps 1:1 to a CSS custom property already consumed by existing Tailwind
// classes (surface-*, primary-*, success/warning/error/info) and by the raw
// `--bg-*`/`--text-*`/`--border-*` variables in globals.css, so applying a
// theme is just writing these onto `:root` — no component changes needed.
export interface ThemeTokens {
  // Surface scale — low numbers read as "text" in light mode and "near-black
  // background" in dark mode (see globals.css's own comment on this scale).
  'surface-50': string; 'surface-100': string; 'surface-200': string; 'surface-300': string;
  'surface-400': string; 'surface-500': string; 'surface-600': string; 'surface-700': string;
  'surface-800': string; 'surface-850': string; 'surface-900': string; 'surface-925': string; 'surface-950': string;
  'bg-base': string; 'bg-panel': string; 'bg-card': string; 'bg-input': string; 'bg-hover': string;
  'border-color': string; 'border-hover': string;
  'text-primary': string; 'text-secondary': string; 'text-muted': string; 'text-faint': string;
  'scrollbar-thumb': string; 'scrollbar-hover': string;
  // Accent (the customizable "Mercy purple, or whatever you want" scale).
  'primary-50': string; 'primary-100': string; 'primary-200': string; 'primary-300': string; 'primary-400': string;
  'primary-500': string; 'primary-600': string; 'primary-700': string; 'primary-800': string; 'primary-900': string; 'primary-950': string;
  // Status.
  success: string; 'success-bg': string;
  warning: string; 'warning-bg': string;
  error: string; 'error-bg': string;
  info: string; 'info-bg': string;
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** Swatches shown on the preset card — accent, surface, a highlight. */
  swatch: [string, string, string];
  tokens: ThemeTokens;
}

const overlayDark = '255, 255, 255';

function darkBase(overrides: Partial<ThemeTokens>): ThemeTokens {
  const base: ThemeTokens = {
    'surface-50': '#f8fafc', 'surface-100': '#f1f5f9', 'surface-200': '#e2e8f0', 'surface-300': '#cbd5e1',
    'surface-400': '#94a3b8', 'surface-500': '#64748b', 'surface-600': '#475569', 'surface-700': '#334155',
    'surface-800': '#1e293b', 'surface-850': '#172033', 'surface-900': '#0f172a', 'surface-925': '#0b1120', 'surface-950': '#060a18',
    'bg-base': '#060a18', 'bg-panel': 'rgba(15, 23, 42, 0.6)', 'bg-card': 'rgba(15, 23, 42, 0.4)',
    'bg-input': 'rgba(255, 255, 255, 0.04)', 'bg-hover': 'rgba(255, 255, 255, 0.06)',
    'border-color': 'rgba(255, 255, 255, 0.06)', 'border-hover': 'rgba(255, 255, 255, 0.1)',
    'text-primary': '#f1f5f9', 'text-secondary': '#cbd5e1', 'text-muted': '#94a3b8', 'text-faint': '#64748b',
    'scrollbar-thumb': 'rgba(255, 255, 255, 0.12)', 'scrollbar-hover': 'rgba(255, 255, 255, 0.2)',
    'primary-50': '#eef2ff', 'primary-100': '#e0e7ff', 'primary-200': '#c7d2fe', 'primary-300': '#a5b4fc', 'primary-400': '#818cf8',
    'primary-500': '#6366f1', 'primary-600': '#4f46e5', 'primary-700': '#4338ca', 'primary-800': '#3730a3', 'primary-900': '#312e81', 'primary-950': '#1e1b4b',
    success: '#34d399', 'success-bg': 'rgba(52, 211, 153, 0.15)',
    warning: '#fbbf24', 'warning-bg': 'rgba(251, 191, 36, 0.15)',
    error: '#f87171', 'error-bg': 'rgba(248, 113, 113, 0.15)',
    info: '#38bdf8', 'info-bg': 'rgba(56, 189, 248, 0.15)',
  };
  return { ...base, ...overrides };
}

export const THEMES: ThemePreset[] = [
  {
    id: 'mercy-default', name: 'Mercy Default', description: 'The original Mercy identity — indigo accent on deep navy.',
    swatch: ['#6366f1', '#0f172a', '#f1f5f9'],
    tokens: darkBase({}),
  },
  {
    id: 'midnight', name: 'Midnight', description: 'Cooler, bluer surfaces with a calmer blue accent.',
    swatch: ['#3b82f6', '#0a1120', '#e2e8f0'],
    tokens: darkBase({
      'surface-800': '#0f1a2e', 'surface-850': '#0c1526', 'surface-900': '#0a111f', 'surface-925': '#080d19', 'surface-950': '#050810',
      'bg-base': '#050810', 'bg-panel': 'rgba(10, 17, 31, 0.65)', 'bg-card': 'rgba(10, 17, 31, 0.45)',
      'border-color': 'rgba(147, 197, 253, 0.08)', 'border-hover': 'rgba(147, 197, 253, 0.14)',
      'primary-50': '#eff6ff', 'primary-100': '#dbeafe', 'primary-200': '#bfdbfe', 'primary-300': '#93c5fd', 'primary-400': '#60a5fa',
      'primary-500': '#3b82f6', 'primary-600': '#2563eb', 'primary-700': '#1d4ed8', 'primary-800': '#1e40af', 'primary-900': '#1e3a8a', 'primary-950': '#172554',
      info: '#60a5fa', 'info-bg': 'rgba(96, 165, 250, 0.15)',
    }),
  },
  {
    id: 'carbon', name: 'Carbon', description: 'Neutral graphite surfaces with a warm amber accent — a tool, not a toy.',
    swatch: ['#f59e0b', '#141414', '#e5e5e5'],
    tokens: darkBase({
      'surface-800': '#1c1c1c', 'surface-850': '#161616', 'surface-900': '#111111', 'surface-925': '#0d0d0d', 'surface-950': '#080808',
      'bg-base': '#080808', 'bg-panel': 'rgba(17, 17, 17, 0.7)', 'bg-card': 'rgba(17, 17, 17, 0.5)',
      'border-color': 'rgba(255, 255, 255, 0.07)', 'border-hover': 'rgba(255, 255, 255, 0.13)',
      'text-primary': '#f5f5f5', 'text-secondary': '#d4d4d4', 'text-muted': '#a3a3a3', 'text-faint': '#737373',
      'primary-50': '#fffbeb', 'primary-100': '#fef3c7', 'primary-200': '#fde68a', 'primary-300': '#fcd34d', 'primary-400': '#fbbf24',
      'primary-500': '#f59e0b', 'primary-600': '#d97706', 'primary-700': '#b45309', 'primary-800': '#92400e', 'primary-900': '#78350f', 'primary-950': '#451a03',
    }),
  },
  {
    id: 'neon', name: 'Neon', description: 'Deep violet with a vivid magenta accent and cyan highlights.',
    swatch: ['#e935c1', '#160822', '#f3e8ff'],
    tokens: darkBase({
      'surface-800': '#1f0f30', 'surface-850': '#190c27', 'surface-900': '#13091e', 'surface-925': '#0f0718', 'surface-950': '#0a0512',
      'bg-base': '#0a0512', 'bg-panel': 'rgba(31, 15, 48, 0.65)', 'bg-card': 'rgba(31, 15, 48, 0.45)',
      'border-color': 'rgba(233, 53, 193, 0.12)', 'border-hover': 'rgba(233, 53, 193, 0.22)',
      'primary-50': '#fdf2fb', 'primary-100': '#fbe1f6', 'primary-200': '#f7c2ed', 'primary-300': '#f194de', 'primary-400': '#ee62cf',
      'primary-500': '#e935c1', 'primary-600': '#c91fa3', 'primary-700': '#a51684', 'primary-800': '#84136a', 'primary-900': '#6d1257', 'primary-950': '#420734',
      info: '#22d3ee', 'info-bg': 'rgba(34, 211, 238, 0.15)',
    }),
  },
  {
    id: 'minimal', name: 'Minimal', description: 'Flat, low-contrast grays and a quiet, understated accent.',
    swatch: ['#94a3b8', '#171717', '#e5e5e5'],
    tokens: darkBase({
      'surface-800': '#1a1a1a', 'surface-850': '#161616', 'surface-900': '#121212', 'surface-925': '#0e0e0e', 'surface-950': '#0a0a0a',
      'bg-base': '#0a0a0a', 'bg-panel': 'rgba(18, 18, 18, 0.6)', 'bg-card': 'rgba(18, 18, 18, 0.4)',
      'border-color': 'rgba(255, 255, 255, 0.05)', 'border-hover': 'rgba(255, 255, 255, 0.09)',
      'text-secondary': '#a1a1aa', 'text-muted': '#71717a', 'text-faint': '#52525b',
      'primary-50': '#f8fafc', 'primary-100': '#f1f5f9', 'primary-200': '#e2e8f0', 'primary-300': '#cbd5e1', 'primary-400': '#94a3b8',
      'primary-500': '#64748b', 'primary-600': '#475569', 'primary-700': '#334155', 'primary-800': '#1e293b', 'primary-900': '#0f172a', 'primary-950': '#020617',
      success: '#86efac', warning: '#fde68a', error: '#fca5a5', info: '#93c5fd',
    }),
  },
  {
    id: 'light', name: 'Light', description: 'A clean light workspace with an indigo accent.',
    swatch: ['#4f46e5', '#f8fafc', '#0f172a'],
    tokens: {
      'surface-50': '#0f172a', 'surface-100': '#1e293b', 'surface-200': '#334155', 'surface-300': '#475569',
      'surface-400': '#64748b', 'surface-500': '#94a3b8', 'surface-600': '#cbd5e1', 'surface-700': '#e2e8f0',
      'surface-800': '#f1f5f9', 'surface-850': '#f5f7fa', 'surface-900': '#f8fafc', 'surface-925': '#fafbfd', 'surface-950': '#ffffff',
      'bg-base': '#f1f5f9', 'bg-panel': 'rgba(255, 255, 255, 0.75)', 'bg-card': 'rgba(255, 255, 255, 0.6)',
      'bg-input': 'rgba(0, 0, 0, 0.04)', 'bg-hover': 'rgba(0, 0, 0, 0.06)',
      'border-color': 'rgba(0, 0, 0, 0.10)', 'border-hover': 'rgba(0, 0, 0, 0.18)',
      'text-primary': '#0f172a', 'text-secondary': '#334155', 'text-muted': '#64748b', 'text-faint': '#94a3b8',
      'scrollbar-thumb': 'rgba(0, 0, 0, 0.15)', 'scrollbar-hover': 'rgba(0, 0, 0, 0.25)',
      'primary-50': '#eef2ff', 'primary-100': '#e0e7ff', 'primary-200': '#c7d2fe', 'primary-300': '#a5b4fc', 'primary-400': '#818cf8',
      'primary-500': '#6366f1', 'primary-600': '#4f46e5', 'primary-700': '#4338ca', 'primary-800': '#3730a3', 'primary-900': '#312e81', 'primary-950': '#1e1b4b',
      success: '#059669', 'success-bg': 'rgba(5, 150, 105, 0.12)',
      warning: '#d97706', 'warning-bg': 'rgba(217, 119, 6, 0.12)',
      error: '#dc2626', 'error-bg': 'rgba(220, 38, 38, 0.12)',
      info: '#0284c7', 'info-bg': 'rgba(2, 132, 199, 0.12)',
    },
  },
];

export function getTheme(id: string): ThemePreset {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// Nav items that can be given their own accent color — mirrors Sidebar.tsx's
// actual nav list exactly (no invented "Games"/"Servers" entries; those
// live as Home cards, not sidebar items, in the current app).
export const NAV_COLOR_TARGETS: { id: string; label: string; cssVar: string }[] = [
  { id: 'home', label: 'Home', cssVar: '--nav-home' },
  { id: 'library', label: 'Library', cssVar: '--nav-library' },
  { id: 'downloads', label: 'Downloads', cssVar: '--nav-downloads' },
  { id: 'settings', label: 'Settings', cssVar: '--nav-settings' },
  { id: 'admin', label: 'Admin', cssVar: '--nav-admin' },
];

export const CUSTOMIZABLE_TOKEN_GROUPS: { label: string; keys: (keyof ThemeTokens)[] }[] = [
  { label: 'Backgrounds', keys: ['bg-base', 'surface-900', 'surface-850'] },
  { label: 'Cards & Panels', keys: ['bg-card', 'bg-panel', 'border-color'] },
  { label: 'Accent', keys: ['primary-500', 'primary-600'] },
  { label: 'Text', keys: ['text-primary', 'text-secondary', 'text-muted'] },
  { label: 'Inputs', keys: ['bg-input', 'border-hover'] },
  { label: 'Status', keys: ['success', 'warning', 'error', 'info'] },
];
