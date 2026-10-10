// Per-server content status and the join-readiness stepper. Pure: built from a requirements report, an install plan
// and the catalog status, so the UI can show exactly what is installed / missing / outdated / incompatible / manual
// and never claim more than was actually checked.
import type { AcRequirementsReport, CheckItem, SrpServerRequirements } from '../AcRequirementsChecker';
import type { InstallPlan, PlanItem } from './installer';
import type { CatalogStatus } from './catalogSync';

export type ContentState = 'installed' | 'missing' | 'outdated' | 'incompatible' | 'manual' | 'unknown';
export interface ContentRow {
  id: string; kind: 'game' | 'csp' | 'car' | 'track' | 'layout' | 'app';
  name: string; required: boolean; state: ContentState; detail: string;
  planItemId?: string; action?: 'install' | 'update' | 'repair' | 'manual'; blocked?: string;
}
export interface ContentCounts { installed: number; missing: number; outdated: number; incompatible: number; manual: number; unknown: number }
export interface ContentStatus { serverId: string; rows: ContentRow[]; counts: ContentCounts; requiredNotReady: number }

function planFor(plan: InstallPlan | null, id: string): PlanItem | undefined { return plan?.items.find((i) => i.id === id); }

function stateOf(item: CheckItem, kind: ContentRow['kind']): ContentState {
  const ev = (item.evidence ?? {}) as { state?: string; issues?: string[] };
  if (item.status === 'pass' || item.status === 'info') return 'installed';
  if (item.status === 'unknown') return 'unknown';
  if (kind === 'car') {
    if (ev.state === 'missing') return 'missing';
    if ((ev.issues ?? []).includes('physics')) return 'incompatible';
    if ((ev.issues ?? []).some((x) => x === 'version' || x === 'skin')) return 'outdated';
    if ((ev.issues ?? []).includes('physics-unverifiable')) return 'unknown';
    return 'outdated';
  }
  if (kind === 'track' || kind === 'layout') {
    if (ev.state === 'missing' || ev.state === 'layout-missing') return 'missing';
    if (ev.state === 'marker-mismatch') return 'incompatible';
    return 'outdated';
  }
  if (kind === 'csp') return item.id === 'csp-installed' ? 'missing' : 'outdated';
  if (kind === 'game') return 'missing';
  return item.status === 'warn' ? 'outdated' : 'missing';
}

export function buildContentStatus(report: AcRequirementsReport, plan: InstallPlan | null, server: SrpServerRequirements): ContentStatus {
  const rows: ContentRow[] = [];
  const add = (item: CheckItem, kind: ContentRow['kind'], required: boolean, planId?: string) => {
    let state = stateOf(item, kind);
    const p = planId ? planFor(plan, planId) : undefined;
    // anything the launcher is not allowed/able to fetch itself is a manual step for the player
    if (state !== 'installed' && state !== 'unknown' && (kind === 'game' || kind === 'csp' || (p && (p.kind === 'external' || p.blocked)))) state = 'manual';
    rows.push({ id: item.id, kind, name: item.label, required, state, detail: item.detail, planItemId: p?.id, action: p ? (p.action as ContentRow['action']) : undefined, blocked: p?.blocked });
  };
  for (const i of report.sections.install) add(i, 'game', true);
  for (const i of report.sections.csp) add(i, 'csp', server.csp.required && !server.csp.none);
  for (const i of report.sections.track) {
    const demoted = !!(i.evidence as { optionalDemoted?: boolean } | undefined)?.optionalDemoted;
    add(i, i.id.startsWith('track-layout') ? 'layout' : 'track', !demoted, i.id.startsWith('track-layout') ? undefined : i.id);
  }
  for (const i of report.sections.cars) {
    const id = i.id.replace(/^car:/, '');
    const req = server.cars.find((c) => c.id === id);
    add(i, 'car', req ? req.requirement !== 'optional' : true, i.id);
  }
  for (const i of report.sections.companion) if (i.id.startsWith('app:') && !i.id.endsWith(':integrity') && !i.id.endsWith(':stamp')) add(i, 'app', false, `companion:${i.id.slice(4)}`);
  const counts: ContentCounts = { installed: 0, missing: 0, outdated: 0, incompatible: 0, manual: 0, unknown: 0 };
  for (const r of rows) counts[r.state]++;
  return { serverId: report.serverId, rows, counts, requiredNotReady: rows.filter((r) => r.required && r.state !== 'installed' && r.state !== 'unknown').length };
}

// ── readiness stepper ─────────────────────────────────────────────────────────
export type StepState = 'done' | 'todo' | 'warn' | 'blocked' | 'unknown';
export interface ReadinessStep { id: 'catalog' | 'install' | 'content' | 'prerequisites' | 'endpoint' | 'join'; label: string; state: StepState; detail: string }
export interface Readiness {
  serverId: string; steps: ReadinessStep[];
  /** Everything Mercy Launcher CAN check is in order. Says nothing about whether the server will accept the connection. */
  readyToLaunch: boolean;
  /** The four things the launcher keeps distinct — never merged into one "online" claim. */
  facts: { catalogAvailable: boolean; contentReady: boolean; gamePort: 'untested' | 'reachable' | 'unreachable' | 'unconfigured'; infoPage: 'answered' | 'no-answer' | 'unconfigured' | 'unchecked'; joinVerified: false };
}

export function buildReadiness(input: {
  serverId: string; catalog: CatalogStatus; content: ContentStatus;
  endpointConfigured: boolean; infoState?: 'online' | 'offline' | 'unconfigured';
  gamePort?: 'reachable' | 'unreachable'; contentManagerAvailable: boolean; serverStatus?: 'active' | 'maintenance' | 'retired';
}): Readiness {
  const { catalog, content } = input;
  const steps: ReadinessStep[] = [];

  // 1 catalog
  if (!catalog.configured) steps.push({ id: 'catalog', label: 'Server catalog', state: 'warn', detail: 'No catalog is configured, so this is the built-in list shipped with the launcher and may be out of date.' });
  else if (catalog.source === 'builtin') steps.push({ id: 'catalog', label: 'Server catalog', state: 'warn', detail: catalog.lastError ? `The catalog could not be loaded (${catalog.lastError.message}). Showing the built-in list.` : 'The catalog has not synced yet. Showing the built-in list.' });
  else if (catalog.expired) steps.push({ id: 'catalog', label: 'Server catalog', state: 'blocked', detail: 'The last synced catalog has expired. Refresh to get the current requirements.' });
  else if (catalog.stale || catalog.lastError) steps.push({ id: 'catalog', label: 'Server catalog', state: 'warn', detail: `Using the last synced catalog (revision ${catalog.revision}${catalog.lastSuccessAt ? `, synced ${catalog.lastSuccessAt}` : ''})${catalog.lastError ? `; the latest refresh failed: ${catalog.lastError.message}` : ''}.` });
  else steps.push({ id: 'catalog', label: 'Server catalog', state: 'done', detail: `Requirements are current (revision ${catalog.revision}${catalog.signatureVerified ? ', signature verified' : catalog.unsignedDev ? ', UNSIGNED development catalog' : ''}).` });
  if (input.serverStatus === 'maintenance') steps.push({ id: 'catalog', label: 'Server notice', state: 'warn', detail: 'The server owner marked this server as being in maintenance.' });

  // 2 local install (+ owned base-game content)
  const game = content.rows.find((r) => r.kind === 'game');
  const baseCars = content.rows.filter((r) => r.kind === 'car' && /base-game|Steam/i.test(r.detail + (r.blocked ?? '')));
  if (!game || game.state !== 'installed') steps.push({ id: 'install', label: 'Assetto Corsa install', state: 'blocked', detail: game?.detail ?? 'Assetto Corsa was not found.' });
  else {
    const missingBase = baseCars.filter((r) => r.state !== 'installed');
    steps.push({ id: 'install', label: 'Assetto Corsa install', state: missingBase.length ? 'blocked' : 'done', detail: missingBase.length ? `Your game is missing ${missingBase.length} base-game car${missingBase.length === 1 ? '' : 's'} this server uses — verify the game files in Steam.` : 'Game found; the base-game content this server uses is present.' });
  }

  // 3 content
  const needs = content.rows.filter((r) => r.required && (r.kind === 'car' || r.kind === 'track' || r.kind === 'layout') && r.state !== 'installed' && r.state !== 'unknown');
  const manual = needs.filter((r) => r.state === 'manual');
  const optionalLeft = content.rows.filter((r) => !r.required && (r.kind === 'car' || r.kind === 'track' || r.kind === 'layout') && r.state !== 'installed' && r.state !== 'unknown').length;
  if (!needs.length) steps.push({ id: 'content', label: 'Server content', state: content.counts.unknown ? 'warn' : 'done', detail: `All required cars and tracks are installed${optionalLeft ? ` (${optionalLeft} optional item${optionalLeft === 1 ? '' : 's'} not installed)` : ''}${content.counts.unknown ? '; some items could not be fully verified' : ''}.` });
  else steps.push({ id: 'content', label: 'Server content', state: manual.length === needs.length ? 'blocked' : 'todo', detail: `${needs.length} required item${needs.length === 1 ? ' needs' : 's need'} attention: ${needs.slice(0, 3).map((r) => `${r.name} (${r.state})`).join(', ')}${needs.length > 3 ? '…' : ''}${manual.length ? `. ${manual.length} must be handled by you (not downloadable by the launcher).` : ''}` });

  // 4 prerequisites (CSP)
  const csp = content.rows.filter((r) => r.kind === 'csp');
  const cspBad = csp.find((r) => r.state !== 'installed' && r.state !== 'unknown' && r.required);
  const cspUnknown = csp.find((r) => r.state === 'unknown');
  if (!csp.length) steps.push({ id: 'prerequisites', label: 'Custom Shaders Patch', state: 'unknown', detail: 'Not checked yet.' });
  else if (cspBad) steps.push({ id: 'prerequisites', label: 'Custom Shaders Patch', state: 'blocked', detail: `${cspBad.detail} Mercy Launcher never installs or updates CSP — do it yourself, then re-check.` });
  else if (cspUnknown) steps.push({ id: 'prerequisites', label: 'Custom Shaders Patch', state: 'warn', detail: cspUnknown.detail });
  else steps.push({ id: 'prerequisites', label: 'Custom Shaders Patch', state: 'done', detail: csp.every((r) => /does not require/i.test(r.detail)) ? 'This server does not need CSP.' : 'Installed and meets the requirement.' });

  // 5 endpoint
  const info = input.infoState;
  steps.push({
    id: 'endpoint', label: 'Server address', state: !input.endpointConfigured ? 'blocked' : input.gamePort === 'unreachable' ? 'warn' : 'done',
    detail: !input.endpointConfigured ? 'No public address is published for this server yet (and no LAN address is set on this computer).'
      : `Address configured. ${info === 'online' ? 'The server\'s status page answered' : info === 'offline' ? 'The server\'s status page did not answer' : 'The status page has not been checked'}${input.gamePort ? `; the game port was ${input.gamePort}` : '; the game port itself has not been tested (use Test connection)'}.`,
  });

  // 6 join
  steps.push({ id: 'join', label: 'Join', state: input.contentManagerAvailable ? 'unknown' : 'blocked', detail: input.contentManagerAvailable ? 'Joining is handed to Content Manager. Whether the connection actually succeeds is NOT verified by Mercy Launcher.' : 'Content Manager (the acmanager:// handler) was not found; joining is launched through it.' });

  const readyToLaunch = steps.every((s) => s.id === 'join' ? s.state !== 'blocked' : s.state !== 'blocked' && s.state !== 'todo');
  return {
    serverId: input.serverId, steps, readyToLaunch,
    facts: {
      catalogAvailable: catalog.source === 'catalog' && !catalog.expired,
      contentReady: !needs.length,
      gamePort: !input.endpointConfigured ? 'unconfigured' : input.gamePort ?? 'untested',
      infoPage: !input.endpointConfigured ? 'unconfigured' : info === 'online' ? 'answered' : info === 'offline' ? 'no-answer' : 'unchecked',
      joinVerified: false,
    },
  };
}
