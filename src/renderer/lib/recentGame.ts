// Minimal "what did you open last" tracker for Home's "Continue Where You
// Left Off" section. Purely local, purely real — it only ever records a game
// the user actually navigated into via its primary action, never seeded or
// guessed. No store needed for something this small.
const KEY = 'mercy-last-game';

export interface RecentGame {
  id: string;
  label: string;
  path: string;
  at: string;
}

export function setLastGame(id: string, label: string, path: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ id, label, path, at: new Date().toISOString() }));
  } catch {}
}

export function getLastGame(): RecentGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
