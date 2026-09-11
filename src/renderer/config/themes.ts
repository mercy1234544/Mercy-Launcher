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

function lightBase(overrides: Partial<ThemeTokens>): ThemeTokens {
  const base: ThemeTokens = {
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
  };
  return { ...base, ...overrides };
}

// ── Scale generation for the 12 named-color presets below ──────────────────
// Hand-picking 11 accent shades + 5 surface shades per theme (as the six
// original presets above do) doesn't scale to 12 more presets without
// either a lot of repetition or visibly inconsistent, guessed-looking
// shades. These presets are instead generated from their real named seed
// colors via real HSL lightness interpolation — same technique, applied
// programmatically — so every generated shade is a genuine derivative of
// the color the preset is actually named after, not a fabricated one.
function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255, g = parseInt(m.slice(2, 4), 16) / 255, b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}
// Lightness stops matching the original hand-picked scales' real profile
// (see 'mercy-default's indigo scale above) — 500 is the seed's own
// lightness, every other stop is a real interpolation around it.
const ACCENT_LIGHTNESS: Record<string, number> = {
  '50': 96, '100': 91, '200': 83, '300': 73, '400': 63, '600': -8, '700': -18, '800': -28, '900': -38, '950': -48,
};
// HSL leaves hue undefined for a genuinely achromatic color (pure grey/
// black/white) — hexToHsl below returns 0 (red) for it by convention, same
// as browsers/most color libraries do. That default hue must never actually
// be USED to add color, or a seed like "Light Grey"/"Crisp White" (exactly
// what Graphite/Obsidian are named after) would come out visibly pink/red
// instead of neutral. Every function below scales its saturation FROM the
// seed's own real saturation (never a fixed floor), so an achromatic seed
// input honestly produces an achromatic (grey) output.
function buildAccentScale(seedHex: string): Pick<ThemeTokens,
  'primary-50' | 'primary-100' | 'primary-200' | 'primary-300' | 'primary-400' | 'primary-500' | 'primary-600' | 'primary-700' | 'primary-800' | 'primary-900' | 'primary-950'> {
  const [h, s, baseL] = hexToHsl(seedHex);
  const lightSat = s * 0.6; // real seed saturation, proportionally softened toward the light end — never floored up
  const at = (stopKey: string, isAbove500: boolean) => {
    const stop = ACCENT_LIGHTNESS[stopKey];
    const l = isAbove500 ? stop : Math.max(4, Math.min(96, baseL + stop));
    return hslToHex(h, isAbove500 ? lightSat : s, l);
  };
  return {
    'primary-50': at('50', true), 'primary-100': at('100', true), 'primary-200': at('200', true),
    'primary-300': at('300', true), 'primary-400': at('400', true), 'primary-500': hslToHex(h, s, baseL),
    'primary-600': at('600', false), 'primary-700': at('700', false), 'primary-800': at('800', false),
    'primary-900': at('900', false), 'primary-950': at('950', false),
  };
}
// Tints the near-black surface scale toward a seed hue (instead of neutral
// grey) so a preset's "black" still reads as part of its own color story —
// exactly what darkBase()'s own surface-800..950/bg-* keys already are,
// just generated from a real seed instead of hand-picked per preset. The
// tint strength is capped by (and zero for) the seed's own real saturation,
// same reasoning as buildAccentScale above.
function buildDarkSurfaceScale(seedHex: string, opts: { panelAlpha?: number; cardAlpha?: number } = {}): Partial<ThemeTokens> {
  const [h, seedSat] = hexToHsl(seedHex);
  const sat = Math.min(seedSat, 22);
  const s800 = hslToHex(h, sat, 14), s850 = hslToHex(h, sat, 11), s900 = hslToHex(h, sat, 8), s925 = hslToHex(h, sat, 6), s950 = hslToHex(h, sat, 4);
  const rgb900 = hexToRgbTriplet(s900);
  return {
    'surface-800': s800, 'surface-850': s850, 'surface-900': s900, 'surface-925': s925, 'surface-950': s950,
    'bg-base': s950, 'bg-panel': `rgba(${rgb900}, ${opts.panelAlpha ?? 0.6})`, 'bg-card': `rgba(${rgb900}, ${opts.cardAlpha ?? 0.4})`,
  };
}
function hexToRgbTriplet(hex: string): string {
  const m = hex.replace('#', '');
  return `${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)}`;
}
function buildLightSurfaceScale(seedHex: string): Partial<ThemeTokens> {
  const [h, seedSat] = hexToHsl(seedHex);
  const sat = Math.min(seedSat, 30);
  return {
    'surface-800': hslToHex(h, sat, 95), 'surface-850': hslToHex(h, sat, 96.5), 'surface-900': hslToHex(h, sat, 98),
    'surface-925': hslToHex(h, sat, 99), 'surface-950': '#ffffff',
    'bg-base': hslToHex(h, sat, 95), 'bg-panel': 'rgba(255, 255, 255, 0.75)', 'bg-card': 'rgba(255, 255, 255, 0.6)',
  };
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

  // ── 12 new named-color presets — each token set generated from its own
  // real named seed colors via buildAccentScale/buildDarkSurfaceScale/
  // buildLightSurfaceScale above, not hand-guessed. ────────────────────────
  {
    id: 'lava', name: 'Lava', description: 'Molten red and orange over near-black charcoal.',
    swatch: ['#f97316', '#0a0a0a', '#ef4444'],
    tokens: darkBase({
      ...buildAccentScale('#f97316'),
      ...buildDarkSurfaceScale('#262626'),
      'bg-base': '#0a0a0a',
      error: '#ef4444', 'error-bg': 'rgba(239, 68, 68, 0.15)',
    }),
  },
  {
    id: 'royal', name: 'Royal', description: 'Royal blue and gold on deep navy, with a crimson edge.',
    swatch: ['#3454d1', '#0a1128', '#d4af37'],
    tokens: darkBase({
      ...buildAccentScale('#3454d1'),
      ...buildDarkSurfaceScale('#0a1128'),
      info: '#d4af37', 'info-bg': 'rgba(212, 175, 55, 0.15)',
      error: '#dc143c', 'error-bg': 'rgba(220, 20, 60, 0.15)',
    }),
  },
  {
    id: 'forest', name: 'Forest', description: 'Emerald and moss green over dark timber, with a cream highlight.',
    swatch: ['#10b981', '#2b2118', '#6b8e4e'],
    tokens: darkBase({
      ...buildAccentScale('#10b981'),
      ...buildDarkSurfaceScale('#2b2118'),
      success: '#6b8e4e', 'success-bg': 'rgba(107, 142, 78, 0.15)',
      'text-primary': '#f5f0dc', 'text-secondary': '#d8cfb0',
    }),
  },
  {
    id: 'cyberpunk', name: 'Cyberpunk', description: 'Neon yellow and hot pink over deep purple and black.',
    swatch: ['#eab308', '#1a0b2e', '#ec4899'],
    tokens: darkBase({
      ...buildAccentScale('#eab308'),
      ...buildDarkSurfaceScale('#2e1065'),
      'bg-base': '#05020a',
      info: '#ec4899', 'info-bg': 'rgba(236, 72, 153, 0.18)',
    }),
  },
  {
    id: 'abyss', name: 'Abyss', description: 'Deep teal and aquamarine over an ocean-blue black.',
    swatch: ['#0f766e', '#0c1f2e', '#2dd4bf'],
    tokens: darkBase({
      ...buildAccentScale('#0f766e'),
      ...buildDarkSurfaceScale('#0c4a6e'),
      'bg-base': '#020608',
      info: '#2dd4bf', 'info-bg': 'rgba(45, 212, 191, 0.15)',
    }),
  },
  {
    id: 'sandstone', name: 'Sandstone', description: 'Warm terracotta and tan over charcoal, with a beige highlight.',
    swatch: ['#c2673d', '#3a2f28', '#d2b48c'],
    tokens: darkBase({
      ...buildAccentScale('#c2673d'),
      ...buildDarkSurfaceScale('#3a2f28'),
      info: '#c9a66b', 'info-bg': 'rgba(201, 166, 107, 0.15)',
      'text-primary': '#ecdfc8', 'text-secondary': '#cbb997',
    }),
  },
  {
    id: 'vaporwave', name: 'Vaporwave', description: 'Lavender and pastel pink over midnight purple, with mint highlights.',
    swatch: ['#b19cd9', '#1a0b2e', '#f7a8c4'],
    tokens: darkBase({
      ...buildAccentScale('#b19cd9'),
      ...buildDarkSurfaceScale('#1a0b2e'),
      info: '#f7a8c4', 'info-bg': 'rgba(247, 168, 196, 0.18)',
      success: '#8fe3c0', 'success-bg': 'rgba(143, 227, 192, 0.15)',
    }),
  },
  {
    id: 'terminal', name: 'Terminal', description: 'Phosphor green on pure black — a classic CRT console.',
    swatch: ['#33cc33', '#000000', '#ffffff'],
    tokens: darkBase({
      ...buildAccentScale('#33cc33'),
      ...buildDarkSurfaceScale('#1a1a1a'),
      'bg-base': '#000000',
      'text-primary': '#d7ffd7', 'text-secondary': '#a3e8a3', 'text-muted': '#6fbf6f',
      success: '#33cc33', info: '#7fffd4',
    }),
  },
  {
    id: 'paper', name: 'Paper', description: 'Cream and ink blue on pure white — a clean, readable light theme.',
    swatch: ['#28437a', '#f7f2e7', '#2b2b2b'],
    tokens: lightBase({
      ...buildAccentScale('#28437a'),
      ...buildLightSurfaceScale('#e8dcc0'),
      'bg-base': '#f7f2e7', 'bg-panel': 'rgba(255, 255, 255, 0.8)', 'bg-card': 'rgba(255, 255, 255, 0.65)',
      'text-primary': '#2b2b2b', 'text-secondary': '#4a4a4a', 'text-muted': '#6b6b6b',
    }),
  },
  {
    id: 'solar', name: 'Solar', description: 'Amber and gold on pale yellow and white.',
    swatch: ['#f59e0b', '#fdf6e3', '#d4a017'],
    tokens: lightBase({
      ...buildAccentScale('#f59e0b'),
      ...buildLightSurfaceScale('#fdf6cf'),
      'bg-base': '#fdf6e3', 'bg-panel': 'rgba(255, 255, 255, 0.8)', 'bg-card': 'rgba(255, 255, 255, 0.65)',
      info: '#d4a017', 'info-bg': 'rgba(212, 160, 23, 0.15)',
    }),
  },
  {
    id: 'graphite', name: 'Graphite', description: 'A pure monochrome scale — light grey through black.',
    swatch: ['#9ca3af', '#1a1a1a', '#ffffff'],
    tokens: darkBase({
      ...buildAccentScale('#9ca3af'),
      ...buildDarkSurfaceScale('#1a1a1a'),
      'bg-base': '#0a0a0a',
      'text-primary': '#ffffff', 'text-secondary': '#d4d4d4',
    }),
  },
  {
    id: 'obsidian', name: 'Obsidian', description: 'True black and crisp white — maximum contrast, no color.',
    swatch: ['#ffffff', '#1a1a1a', '#000000'],
    tokens: darkBase({
      ...buildAccentScale('#e5e5e5'),
      ...buildDarkSurfaceScale('#1a1a1a'),
      'bg-base': '#000000', 'bg-panel': 'rgba(26, 26, 26, 0.7)', 'bg-card': 'rgba(26, 26, 26, 0.5)',
      'border-color': 'rgba(255, 255, 255, 0.08)', 'border-hover': 'rgba(255, 255, 255, 0.16)',
      'text-primary': '#ffffff', 'text-secondary': '#e5e5e5', 'text-muted': '#a3a3a3',
    }),
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
