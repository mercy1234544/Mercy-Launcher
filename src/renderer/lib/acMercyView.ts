// Pure view-model for the Assetto Corsa "Mercy's Servers" UI — turns the main process's requirement
// report, install plan, live status and join status into exactly what the screens show. No React and no
// IPC in here, so every rule (what counts as "ready", which action a problem maps to, what is checked by
// default in the install dialog) is unit-tested against real checker output.

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
type Status = AcCheckStatus;
type SectionId = keyof AcRequirementsReport['sections'];

export const STATUS_TONE: Record<Status, Tone> = { pass: 'good', info: 'info', unknown: 'neutral', warn: 'warn', fail: 'bad' };

export const TONE_CLASSES: Record<Tone, { chip: string; dot: string; text: string }> = {
  good: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  warn: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/25', dot: 'bg-amber-400', text: 'text-amber-300' },
  bad: { chip: 'bg-red-500/15 text-red-300 border-red-500/25', dot: 'bg-red-400', text: 'text-red-300' },
  info: { chip: 'bg-sky-500/15 text-sky-300 border-sky-500/25', dot: 'bg-sky-400', text: 'text-sky-300' },
  neutral: { chip: 'bg-overlay-6 text-surface-400 border-overlay-10', dot: 'bg-surface-600', text: 'text-surface-400' },
};

export const SECTION_TITLES: Record<SectionId, string> = {
  install: 'Game install', csp: 'Custom Shaders Patch', track: 'Track', cars: 'Cars', companion: 'Companion app & HUD', conflicts: 'Conflicts',
};
const SECTION_ORDER: SectionId[] = ['install', 'csp', 'track', 'cars', 'companion', 'conflicts'];
const RANK: Status[] = ['pass', 'info', 'unknown', 'warn', 'fail'];
export const worstStatus = (list: Status[]): Status => list.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), 'pass' as Status);

export type OverallState = 'ready' | 'suggestions' | 'incomplete' | 'blocked' | 'unchecked';
export function summarizeReport(report: AcRequirementsReport | null): { state: OverallState; headline: string; tone: Tone } {
  if (!report) return { state: 'unchecked', headline: 'Not checked yet', tone: 'neutral' };
  const s = report.summary;
  if (s.fail > 0) return { state: 'blocked', headline: `${s.fail} thing${s.fail === 1 ? '' : 's'} to fix before you can join`, tone: 'bad' };
  if (s.unknown > 0) return { state: 'incomplete', headline: 'Some checks could not be completed', tone: 'warn' };
  if (s.warn > 0) return { state: 'suggestions', headline: `Ready to join · ${s.warn} suggestion${s.warn === 1 ? '' : 's'}`, tone: 'warn' };
  return { state: 'ready', headline: 'Ready to join', tone: 'good' };
}

export interface ReportGroup { id: SectionId; title: string; items: AcCheckItem[]; worst: Status; counts: Record<Status, number> }
export function groupReport(report: AcRequirementsReport): ReportGroup[] {
  return SECTION_ORDER.filter((id) => report.sections[id].length > 0).map((id) => {
    const items = report.sections[id];
    const counts = { pass: 0, info: 0, unknown: 0, warn: 0, fail: 0 } as Record<Status, number>;
    for (const i of items) counts[i.status]++;
    // Passing cars would drown the problems: show problems first, passing last.
    const sorted = [...items].sort((a, b) => RANK.indexOf(b.status) - RANK.indexOf(a.status));
    return { id, title: SECTION_TITLES[id], items: sorted, worst: worstStatus(items.map((i) => i.status)), counts };
  });
}

export type ItemActionKind = 'auto' | 'needs-file' | 'manual' | 'yours' | 'none';
export interface ItemAction { kind: ItemActionKind; label: string; planItemIds: string[]; steps?: string[] }

/** What can be done about one problem line: let the launcher fix it, hand it a file, or do it yourself. */
export function itemAction(item: AcCheckItem, plan: AcInstallPlan | null): ItemAction {
  if (item.status === 'pass' || item.status === 'info') return { kind: 'none', label: '', planItemIds: [] };
  const id = item.id;
  if (id === 'csp-installed' || id === 'csp-version') return { kind: 'yours', label: 'Install / update Custom Shaders Patch yourself', planItemIds: [], steps: ['Mercy Launcher never installs or updates Custom Shaders Patch for you.', 'Content Manager can install or update it. Start the game once afterwards so the version can be read, then re-check.'] };
  if (id === 'ac-install') return { kind: 'yours', label: 'Install Assetto Corsa or set its folder', planItemIds: [], steps: ['Install Assetto Corsa through Steam, or choose its folder in Setup & Diagnostics.'] };
  if (!plan) return { kind: 'none', label: '', planItemIds: [] };
  const own = (p: AcPlanItem) =>
    (id.startsWith('car:') && (p.id === id || p.id.startsWith(`skin:${id.slice(4)}:`))) ||
    ((id === 'track' || id === 'track-layout') && p.id === 'track') ||
    (id.startsWith('track:') && p.id === id) ||
    (id.startsWith('track-layout:') && p.id === `track:${id.split(':')[1]}`) ||
    (id.startsWith('app:') && p.id.startsWith('companion:')) ||
    (id === 'conflict-srp-hud' && p.id === 'conflict:srp_hud');
  const mine = plan.items.filter(own);
  if (!mine.length) return { kind: 'none', label: '', planItemIds: [] };
  const ids = mine.map((p) => p.id);
  const first = mine[0];
  if (first.kind === 'external') return { kind: 'manual', label: 'Do this yourself', planItemIds: ids, steps: first.manualSteps };
  if (first.needsLocalFile) return { kind: 'needs-file', label: 'Choose the downloaded archive', planItemIds: ids, steps: first.manualSteps };
  if (mine.every((p) => p.blocked)) return { kind: 'manual', label: 'Needs your action', planItemIds: ids, steps: first.manualSteps ?? [first.blocked!] };
  const verb = first.action === 'repair' ? 'Repair' : first.action === 'update' ? 'Update' : first.action === 'move-to-backup' ? 'Move aside' : 'Install';
  return { kind: 'auto', label: verb, planItemIds: ids };
}

export interface PlanChoices { auto: AcPlanItem[]; needsFile: AcPlanItem[]; manual: AcPlanItem[] }
export function planChoices(plan: AcInstallPlan): PlanChoices {
  return {
    auto: plan.items.filter((i) => !i.blocked && i.action !== 'manual'),
    needsFile: plan.items.filter((i) => i.needsLocalFile),
    manual: plan.items.filter((i) => (i.action === 'manual' || i.blocked) && !i.needsLocalFile),
  };
}

/** Pre-ticked items: required, non-destructive, automatic ones. Anything that replaces files or is optional needs a deliberate tick. */
export function defaultApproved(plan: AcInstallPlan): string[] {
  return planChoices(plan).auto.filter((i) => !i.destructive && !i.optional).map((i) => i.id);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return 'unknown size';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function totalDownloadBytes(plan: AcInstallPlan, approved: string[]): number {
  return plan.downloads.filter((d) => d.itemIds.some((id) => approved.includes(id))).reduce((s, d) => s + (d.bytes ?? 0), 0);
}

export const PHASE_LABEL: Record<string, string> = {
  preflight: 'Checking', downloading: 'Downloading', 'verifying-download': 'Verifying download', extracting: 'Extracting',
  'verifying-staged': 'Verifying files', installing: 'Installing', verifying: 'Final check', done: 'Finished', 'rolling-back': 'Restoring previous state', failed: 'Stopped',
};

export function liveStatusChip(s: AcServerLiveStatus | null): { label: string; tone: Tone; title: string } {
  if (!s) return { label: 'Checking status…', tone: 'neutral', title: '' };
  if (s.state === 'online') return { label: `Online${s.players != null && s.maxPlayers != null ? ` · ${s.players}/${s.maxPlayers}` : ''}`, tone: 'good', title: s.reason };
  if (s.state === 'offline') return { label: 'Not reachable', tone: 'bad', title: s.reason };
  return { label: 'Status unknown', tone: 'neutral', title: s.reason };
}

export function joinButton(join: AcJoinStatus | null, report: AcRequirementsReport | null, busy: boolean): { enabled: boolean; label: string; why: string } {
  if (busy) return { enabled: false, label: 'Working…', why: 'An operation is in progress.' };
  if (!report) return { enabled: false, label: 'Join Server', why: 'Check requirements first.' };
  if (!join) return { enabled: false, label: 'Join Server', why: 'Checking whether you can join…' };
  if (!join.canJoin) return { enabled: false, label: 'Join Server', why: join.blockers[0] ?? 'Not ready to join yet.' };
  return { enabled: true, label: 'Join Server', why: join.reason };
}


// ── server catalog (signed, synced) ────────────────────────────────────────────

/** "just now", "5 min ago", "2 h ago", "3 d ago". `now` is passed in so this stays pure. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso); if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 5400) return '1 h ago';
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export interface CatalogBarView {
  tone: Tone; title: string; detail: string;
  badges: { label: string; tone: Tone; title?: string }[];
  /** Plain-language reasons the player is looking at older or built-in data, most important first. */
  warnings: string[];
  canRefresh: boolean;
}
/** The one-line truth about where the server list came from and how fresh it is. */
export function catalogBar(st: AcCatalogStatus | null, now: number, settings?: Pick<AcCatalogSettings, 'installMode'> | null): CatalogBarView {
  if (!st) return { tone: 'neutral', title: 'Server catalog', detail: 'Loading…', badges: [], warnings: [], canRefresh: false };
  const badges: CatalogBarView['badges'] = [];
  const warnings: string[] = [];
  if (!st.configured) {
    return { tone: 'neutral', title: 'Built-in server list', detail: 'No catalog address is set, so this list is the one shipped with Mercy Launcher and will not update by itself. The server owner can give you the catalog address; enter it in Setup & Diagnostics.', badges: [{ label: 'Built-in', tone: 'neutral' }], warnings, canRefresh: false };
  }
  if (st.source === 'builtin') {
    if (st.lastError) warnings.push(`The catalog could not be loaded: ${st.lastError.message}`);
    // A catalog IS configured but none has been accepted: the built-in package is old data. It is never presented as current.
    warnings.push('This is the list that shipped with this version of Mercy Launcher and may be out of date. It is not the live catalog, and automatic install is off until a signed catalog loads.');
    return { tone: 'warn', title: 'Built-in server list (not the live catalog)', detail: st.syncing ? 'Contacting the catalog…' : st.lastError ? 'The catalog is unavailable right now.' : 'The catalog has not been downloaded yet.', badges: [{ label: 'Built-in · may be outdated', tone: 'warn' }], warnings, canRefresh: true };
  }
  if (st.environment === 'development') badges.push({ label: 'DEVELOPMENT', tone: 'warn', title: 'A test catalog. Automatic install is disabled for it.' });
  if (st.signatureVerified) badges.push({ label: 'Signature verified', tone: 'good', title: st.keyId ? `Signed with pinned key "${st.keyId}"` : undefined });
  else if (st.unsignedDev) badges.push({ label: 'UNSIGNED', tone: 'bad', title: 'Accepted only because you allowed unsigned development catalogs from a private address.' });
  if (settings?.installMode === 'auto') badges.push({ label: 'Auto-install on', tone: 'info', title: 'Content for servers marked "keep ready" installs by itself when the catalog changes.' });
  let tone: Tone = 'good';
  if (st.expired) { tone = 'bad'; warnings.push('This catalog has expired. Installing is paused and joining needs a refresh. The server owner must publish a new one.'); }
  if (st.lastError) { tone = tone === 'bad' ? 'bad' : 'warn'; warnings.push(`The latest refresh failed (${st.lastError.message.replace(/[.\s]+$/, '')}). You are seeing the last catalog that synced ${relativeTime(st.lastSuccessAt, now)}.`); }
  else if (st.stale) { tone = tone === 'bad' ? 'bad' : 'warn'; warnings.push(`The catalog has not refreshed for a while (last synced ${relativeTime(st.lastSuccessAt, now)}).`); }
  return { tone, title: `Server catalog · revision ${st.revision}`, detail: st.syncing ? 'Refreshing…' : `Last synced ${relativeTime(st.lastSuccessAt, now)}`, badges, warnings, canRefresh: true };
}

export const CONTENT_STATE_VIEW: Record<AcContentRow['state'], { label: string; tone: Tone }> = {
  installed: { label: 'Installed', tone: 'good' },
  missing: { label: 'Missing', tone: 'bad' },
  outdated: { label: 'Outdated', tone: 'warn' },
  incompatible: { label: 'Incompatible', tone: 'bad' },
  manual: { label: 'Needs you', tone: 'warn' },
  unknown: { label: 'Unverified', tone: 'neutral' },
};
const STATE_RANK: AcContentRow['state'][] = ['incompatible', 'missing', 'manual', 'outdated', 'unknown', 'installed'];
/** Problems first, installed last; required before optional inside a state. */
export function sortContentRows(rows: AcContentRow[]): AcContentRow[] {
  return [...rows].sort((a, b) => STATE_RANK.indexOf(a.state) - STATE_RANK.indexOf(b.state) || Number(b.required) - Number(a.required));
}
/** Counts for just the rows a list shows (the status object also counts the game and CSP rows). */
export function countRows(rows: AcContentRow[]): AcContentStatus['counts'] {
  const c = { installed: 0, missing: 0, outdated: 0, incompatible: 0, manual: 0, unknown: 0 };
  for (const r of rows) c[r.state]++;
  return c;
}
export function contentSummaryLine(c: AcContentStatus['counts']): string {
  const parts: string[] = [];
  if (c.installed) parts.push(`${c.installed} installed`);
  if (c.missing) parts.push(`${c.missing} missing`);
  if (c.outdated) parts.push(`${c.outdated} outdated`);
  if (c.incompatible) parts.push(`${c.incompatible} incompatible`);
  if (c.manual) parts.push(`${c.manual} need${c.manual === 1 ? 's' : ''} you`);
  if (c.unknown) parts.push(`${c.unknown} unverified`);
  return parts.join(' · ') || 'Nothing to check';
}
export const STEP_TONE: Record<AcReadiness['steps'][number]['state'], Tone> = { done: 'good', todo: 'warn', warn: 'warn', blocked: 'bad', unknown: 'neutral' };

/** What the Setup panel says about the install mode — kept next to the logic that enforces it. */
export function installModeExplanation(mode: 'review' | 'auto', autoUpdateExisting: boolean, maxBytes: number): string {
  if (mode === 'review') return 'Review before install: Mercy Launcher shows what is missing and installs nothing until you approve it.';
  return `Automatic: for servers you mark "keep ready", verified content from an authorised source installs by itself (up to ${formatBytes(maxBytes)} per run), only while the game is closed and the catalog is signed and current. ${autoUpdateExisting ? 'It may also replace existing content — always after a backup.' : 'It never replaces existing content; those changes wait for your approval.'} Custom Shaders Patch and your own files are never touched.`;
}
export function mbToBytes(gb: number): number { return Math.round(Math.max(0.1, Math.min(16, gb)) * 1024 ** 3); }
export function bytesToGb(b: number): number { return Math.round((b / 1024 ** 3) * 10) / 10; }

// ── plain-language catalog errors + card summaries ─────────────────────────────
export interface ErrorHelp { title: string; hint: string }
/** Turns a catalog sync error into what happened and what to do about it. Never hides the original message. */
export function catalogErrorHelp(e: { code: string; message: string } | null | undefined, audience: 'developer' | 'player' = 'developer'): ErrorHelp | null {
  if (!e) return null;
  if (audience === 'player') return playerCatalogHelp(e);
  const m = e.message || '';
  const keep = ' Nothing on your computer was changed, and the last good catalog (if there is one) is still the one in use.';
  switch (e.code) {
    case 'unconfigured': return { title: 'No catalog address is set', hint: 'Enter the catalog address the server owner gave you, then add their signing key.' };
    case 'network': return { title: 'Cannot reach the catalog server', hint: 'Check the address and port, that the server is running, and that this PC can reach it (same network, no firewall in the way). If it only fails here, test the address in a web browser on this PC.' + keep };
    case 'timeout': return { title: 'The catalog server did not answer in time', hint: 'The server may be down or blocked by a firewall. Try Refresh again in a minute.' + keep };
    case 'http': return /404/.test(m)
      ? { title: 'No catalog at that address', hint: 'The server answered, but has no /catalog.json there. Check the address (and path) with the server owner.' + keep }
      : { title: 'The catalog server reported an error', hint: 'This is usually temporary. The launcher retries on its own with a growing delay; Refresh tries immediately.' + keep };
    case 'redirect': return { title: 'The catalog server tried to send the launcher elsewhere', hint: 'Redirects to a different host (or from https to http) are refused for safety. The owner must serve the catalog directly from the configured address.' + keep };
    case 'too-large': return { title: 'The catalog is larger than allowed', hint: 'The catalog (limit 2 MB) or its signature (limit 4 KB) is too big. The owner must reduce it.' + keep };
    case 'unsigned': return { title: 'The catalog is not signed', hint: 'A production catalog is only trusted when it carries a valid signature from a key you pinned. Ask the owner for the signature file and their public key.' + keep };
    case 'signature':
      if (/not one of the keys pinned/.test(m)) return { title: 'Signed with a key you have not pinned', hint: 'Add the signing key (its key id and PUBLIC key) from the server owner under Trusted signing keys. The key id must match exactly.' + keep };
      if (/does not describe the catalog/.test(m)) return { title: 'The catalog and its signature do not match', hint: 'The two files came from different publishes. This often fixes itself in a minute (a publish in progress); press Refresh. If it keeps happening, the server is serving mismatched files (or the catalog is being altered on the way to you) and the owner must fix it.' + keep };
      if (/not a valid Ed25519/.test(m)) return { title: 'A pinned key is not a valid Ed25519 public key', hint: 'Re-paste the key (PEM, or 32 raw bytes in base64) from the server owner. Never use a private key.' + keep };
      if (/malformed/.test(m)) return { title: 'The signature file is malformed', hint: 'The owner must publish the signature in the agreed format.' + keep };
      if (/No signing key is pinned/.test(m)) return { title: 'No signing key is pinned', hint: 'Add the owner\'s key id and public key before the catalog can be trusted.' + keep };
      return { title: 'The signature is not valid for the pinned key', hint: 'Either the wrong key is pinned, or the catalog was altered after signing. Do not trust this catalog until the owner confirms the key.' + keep };
    case 'schema': return { title: 'The catalog failed validation', hint: 'The catalog does not follow the agreed format or breaks a safety rule (for example a private address, an unlisted download host or an unsafe path). The owner must fix it. First problem: ' + m.replace(/^The catalog failed validation \(\d+ problems?\): /, '') + keep };
    case 'malformed': return { title: 'The catalog is not valid JSON', hint: 'The server returned something that is not a catalog (an error page, or a cut-off file).' + keep };
    case 'rollback': return { title: 'An older catalog was served', hint: 'The server offered a lower revision than one already accepted, so it was ignored. If the owner deliberately reset the revision, use Reset catalog.' + keep };
    case 'conflict': return { title: 'Two different catalogs share one revision', hint: 'The owner must bump the revision whenever the catalog changes.' + keep };
    case 'identity': return { title: 'The catalog identity changed', hint: 'The catalog id differs from the one already accepted. If that is expected, press Reset catalog and refresh.' + keep };
    case 'expired': return { title: 'The catalog has expired', hint: 'The owner must publish a fresh catalog (a later expiry).' + keep };
    case 'future': return { title: 'The catalog is dated in the future', hint: 'Check this computer\'s date and time.' + keep };
    case 'environment': return { title: 'A development catalog from a non-private address', hint: 'Development catalogs are only accepted from a private network address.' + keep };
    default: return { title: 'The catalog could not be refreshed', hint: m + keep };
  }
}

/** What a player needs to know about a failed refresh: what happened, in plain words — no addresses, keys or settings to change. */
function playerCatalogHelp(e: { code: string; message: string }): ErrorHelp {
  const kept = ' Nothing on your computer was changed.';
  switch (e.code) {
    case 'unconfigured': return { title: 'The live server list is not set up', hint: 'This version of Mercy Launcher is showing its built-in list.' };
    case 'network': case 'timeout': return { title: 'Cannot reach the server list', hint: 'Check that you are on the same network as the servers, then press Refresh. The launcher also keeps retrying on its own.' + kept };
    case 'http': case 'redirect': case 'too-large': return { title: 'The server list is not available right now', hint: 'The list server answered with a problem. This is usually temporary; press Refresh in a minute.' + kept };
    case 'signature': case 'unsigned': return { title: 'The server list could not be verified', hint: 'It was not signed by a key this launcher trusts, so it was not used.' + kept + ' If this keeps happening, tell the server owner.' };
    case 'expired': case 'future': return { title: 'The server list is out of date', hint: 'The list has expired (or the clock on this computer is wrong). Check your date and time, then press Refresh.' + kept };
    default: return { title: 'The server list was not used', hint: 'It failed the safety checks built into Mercy Launcher.' + kept + ' If this keeps happening, tell the server owner.' };
  }
}

/** One short line listing what the plan says is missing, so the card shows it without opening anything. */
export function missingSummary(plan: AcInstallPlan | null | undefined): { text: string; manual: number } | null {
  if (!plan) return null;
  const items = plan.items.filter((i) => i.kind !== 'conflict' && i.kind !== 'companion');
  if (!items.length) return null;
  const names = items.slice(0, 4).map((i) => i.label.replace(/\s+—\s+skin ".*"$/, ' (skin)'));
  const more = items.length - names.length;
  return { text: `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`, manual: items.filter((i) => i.action === 'manual' || !!i.blocked).length };
}

/** HUD and companion-app facts for a server card, from the catalog. Never claims more than the profile says. */
export function hudCompanionLine(p: Pick<AcMercyServerProfile, 'hud' | 'companionApp'>): { hud: string; companion: string } {
  return {
    hud: p.hud.delivered ? `Server HUD ${p.hud.version} — sent by the server when you join; nothing to install` : 'No server HUD on this server',
    companion: p.companionApp ? 'SRP Board companion app — optional; the launcher can install it' : 'No companion app',
  };
}
