// View-model for the compact Mercy's Servers browser: turns a server profile, its live status and the main process's
// joinCheck into exactly what one row shows. No React and no IPC in here, so every rule (which state is shown, when
// Join is enabled, what a failed hand-off says) is unit-tested.
import type { Tone } from './acMercyView';

export type RowState = 'checking' | 'ready' | 'missing' | 'unavailable';
export const ROW_STATE_VIEW: Record<RowState, { label: string; tone: Tone }> = {
  checking: { label: 'Checking…', tone: 'neutral' },
  ready: { label: 'Ready to Join', tone: 'good' },
  missing: { label: 'Missing Content', tone: 'warn' },
  unavailable: { label: 'Connection Unavailable', tone: 'bad' },
};

export const rowState = (check: AcJoinCheck | null): RowState => (check ? check.state : 'checking');

const ENGINE_LABEL: Record<string, string> = { 'kunos-stock': 'Standard server', assettoserver: 'AssettoServer' };
export const engineLabel = (engine: string) => ENGINE_LABEL[engine] ?? engine;

/** Servers with AI traffic get a different accent from the stock one, so the two SRP servers are told apart at a glance. */
export function accentOf(p: Pick<AcMercyServerProfile, 'aiTraffic'>): 'sky' | 'amber' { return (p.aiTraffic ?? 0) > 0 ? 'amber' : 'sky'; }
export const ACCENT_CLASSES = {
  sky: { bar: 'bg-sky-400/80', icon: 'bg-sky-500/15 border-sky-500/25 text-sky-300', chip: 'bg-sky-500/10 text-sky-200 border-sky-500/25' },
  amber: { bar: 'bg-amber-400/80', icon: 'bg-amber-500/15 border-amber-500/25 text-amber-300', chip: 'bg-amber-500/10 text-amber-200 border-amber-500/25' },
} as const;

export interface RowFacts { name: string; trackLine: string; typeLabel: string; slots: string | null; ai: string | null; players: string | null }
/** The facts a row shows. Anything not actually known (server offline, not in the catalog) is null — never invented. */
export function rowFacts(p: AcMercyServerProfile, live: AcServerLiveStatus | null, check: AcJoinCheck | null): RowFacts {
  const trackName = p.fromCatalog && p.tracks?.[0] ? p.tracks[0].name : 'Shutoko Revival Project';
  const layout = p.layoutName.split(' - ').pop()?.trim() ?? '';
  const trackLine = layout && layout !== trackName ? `${trackName} · ${layout}` : trackName;
  const online = live?.state === 'online' || check?.connection.infoOnline === true;
  const players = online ? (live?.players ?? check?.connection.players ?? null) : null;
  const max = p.maxPlayers ?? (online ? (live?.maxPlayers ?? check?.connection.maxPlayers ?? null) : null);
  return {
    name: p.name, trackLine, typeLabel: engineLabel(p.engine),
    slots: max != null ? `${max} slots` : null,
    players: players != null && max != null ? `${players}/${max} online` : null,
    ai: p.aiTraffic != null ? (p.aiTraffic > 0 ? `${p.aiTraffic} AI traffic` : 'No AI traffic') : null,
  };
}

export type Phase = 'idle' | 'working' | 'handed-off' | 'failed';
export interface JoinButton { enabled: boolean; label: string; title: string }
/** Join is enabled ONLY when the latest check says Ready and nothing is already running. */
export function joinButtonModel(check: AcJoinCheck | null, phase: Phase): JoinButton {
  if (phase === 'working') return { enabled: false, label: 'Joining…', title: 'Checking everything and opening Content Manager.' };
  if (!check) return { enabled: false, label: 'Join Server', title: 'Checking this server…' };
  if (!check.canJoin) {
    const first = check.issues.find((i) => i.severity === 'blocker');
    return { enabled: false, label: 'Join Server', title: first ? `${first.title}. ${first.detail}` : 'Not ready to join.' };
  }
  return { enabled: true, label: phase === 'handed-off' || phase === 'failed' ? 'Join again' : 'Join Server', title: 'Opens Content Manager, which starts Assetto Corsa on this server.' };
}

export interface JoinOutcome { tone: Tone; headline: string; detail: string; retry: boolean }
/** What to tell the player after pressing Join. Never says "connected": the launcher cannot observe that. */
export function joinOutcome(r: { success: boolean; stage?: 'blocked' | 'launch' | 'handed-off'; error?: string; note?: string }): JoinOutcome {
  if (r.success) return { tone: 'good', headline: 'Opening Content Manager…', detail: 'Content Manager should open and start the game on this server. If nothing happens, press Join again. Mercy Launcher cannot see whether the connection then succeeds.', retry: true };
  if (r.stage === 'launch') return { tone: 'bad', headline: 'Content Manager could not be opened', detail: r.error ?? 'The hand-off to Content Manager failed.', retry: true };
  return { tone: 'bad', headline: 'Not ready to join', detail: r.error ?? 'Something needs fixing first.', retry: true };
}

export interface IssueLine { id: string; tone: Tone; title: string; detail: string; action?: { kind: AcJoinIssue['fix'] extends infer F ? (F extends { kind: infer K } ? K : never) : never; label: string; planItemIds?: string[] } }
/** Blockers first (connection before this-PC items), notes last. */
export function issueLines(check: AcJoinCheck | null): IssueLine[] {
  if (!check) return [];
  return check.issues.map((i) => ({ id: i.id, tone: (i.severity === 'note' ? 'info' : i.kind === 'connection' ? 'bad' : 'warn') as Tone, title: i.title, detail: i.detail, action: i.fix }));
}

/** The one-line "what do I do" under a row that is not ready. */
export function primaryAction(check: AcJoinCheck | null): { title: string; action?: IssueLine['action'] } | null {
  if (!check || check.canJoin) return null;
  const first = issueLines(check).find((l) => l.tone !== 'info');
  return first ? { title: first.title, action: first.action } : null;
}

/** The first sentence of a detail, with exactly one full stop (so "A, B." never becomes "A, B.."). */
export function firstSentence(detail: string): string {
  const t = detail.trim(); const i = t.search(/\.\s/);
  const s = i >= 0 ? t.slice(0, i) : t.replace(/\.+$/, '');
  return `${s.replace(/\.+$/, '')}.`;
}

/** Plain-language lines about the connection, for the expanded details only. */
export function connectionLines(check: AcJoinCheck | null): string[] {
  if (!check) return [];
  const c = check.connection; const out: string[] = [];
  if (!c.configured) { out.push('No server address is available.'); return out; }
  out.push(c.scope === 'lan' ? 'Using your home-network address.' : 'Using the public address.');
  if (c.lanOnly) out.push('This server has no public internet address yet, so it can only be joined from the same network.');
  out.push(c.infoOnline ? 'The server answered its status page.' : 'The server did not answer its status page.');
  if (c.identity === 'match') out.push('It identified itself as the right server.');
  if (c.gamePortTcp === 'open') out.push('Its game port accepts connections.');
  else if (c.gamePortTcp === 'closed') out.push('Its game port does not accept connections from this PC.');
  out.push('The UDP part of the game connection cannot be tested from here; only a real join proves it.');
  return out;
}

/** The slim list header: one line, loud only when something is wrong. */
export interface StripView { tone: Tone; text: string; showSetup: boolean; setupLabel: string }
export function stripView(st: AcCatalogStatus | null, relative: (iso: string | null) => string, developer = true): StripView {
  const v = stripViewFor(st, relative);
  // Setup & Diagnostics holds the catalog address and keys; only developers are sent there.
  return developer ? v : { ...v, showSetup: false, setupLabel: '' };
}
function stripViewFor(st: AcCatalogStatus | null, relative: (iso: string | null) => string): StripView {
  if (!st) return { tone: 'neutral', text: 'Loading the server list…', showSetup: false, setupLabel: '' };
  if (!st.configured) return { tone: 'neutral', text: 'Using the server list that came with this version. It will not update by itself.', showSetup: true, setupLabel: 'Connect to the live list' };
  if (st.source === 'builtin') return { tone: 'warn', text: st.lastError ? 'The live server list could not be loaded, so this older built-in list is shown.' : 'The live server list has not loaded yet; this older built-in list is shown.', showSetup: true, setupLabel: 'Fix' };
  if (st.expired) return { tone: 'bad', text: 'The server list has expired. Refresh, or ask the server owner for a new one.', showSetup: false, setupLabel: '' };
  if (st.lastError) return { tone: 'warn', text: `Could not refresh the server list. Showing the version from ${relative(st.lastSuccessAt)}.`, showSetup: true, setupLabel: 'Details' };
  if (st.stale) return { tone: 'warn', text: `Server list last updated ${relative(st.lastSuccessAt)}.`, showSetup: false, setupLabel: '' };
  return { tone: 'good', text: `Server list updated ${relative(st.lastSuccessAt)}.`, showSetup: false, setupLabel: '' };
}
