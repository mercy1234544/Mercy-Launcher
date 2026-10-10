// Developer-only access to the catalog's technical settings. Ordinary players see the server list and a Join
// button; the catalog address, the pinned signing keys, the refresh knobs and the per-server connection overrides
// are only readable/writable while "Developer options" is on in Settings. The gate lives in the main process (the
// IPC layer calls these helpers), so a hidden UI is not the only thing between a player and those values.
// It is a visibility/safety gate, not a security boundary: the catalog is still only accepted when its signature
// verifies against a pinned key, whoever changed the settings.
import type { CatalogSettings } from './catalogSync';

/** Settings keys a player cannot read or change without developer options. */
export const DEVELOPER_ONLY_CATALOG_KEYS = ['baseUrl', 'trustedKeys', 'allowUnsignedDev', 'intervalMinutes', 'maxAutoDownloadBytes'] as const;

export const DEVELOPER_ONLY_MESSAGE = 'This is a developer option. Turn on Developer options in Settings to change it.';

/** What a non-developer is allowed to see of the catalog settings: preferences, never the address or the keys. */
export function redactCatalogSettings(s: CatalogSettings, developer: boolean): CatalogSettings {
  if (developer) return s;
  return { ...s, baseUrl: null, trustedKeys: [], allowUnsignedDev: false };
}

/** Drops the developer-only keys from a patch when developer options are off, and says so. */
export function restrictCatalogPatch(patch: Record<string, unknown>, developer: boolean): { patch: Record<string, unknown>; errors: string[] } {
  if (developer) return { patch, errors: [] };
  const out: Record<string, unknown> = {}; const errors: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if ((DEVELOPER_ONLY_CATALOG_KEYS as readonly string[]).includes(k)) { if (!errors.length) errors.push(DEVELOPER_ONLY_MESSAGE); continue; }
    out[k] = v;
  }
  return { patch: out, errors };
}

/** Per-server connection overrides contain addresses; a player sees only whether one is set. */
export function redactEndpoints<T extends Record<string, unknown>>(e: T, developer: boolean): T {
  if (developer) return e;
  const out: Record<string, unknown> = { ...e };
  for (const k of Object.keys(out)) if (/host|address|ip$/i.test(k) && typeof out[k] === 'string') out[k] = null;
  return out as T;
}
