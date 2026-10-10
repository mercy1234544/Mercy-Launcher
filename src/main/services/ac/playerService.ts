// Orchestrates the PLAYER side of Assetto Corsa: Mercy's Servers profiles, requirement checks, install
// plans/runs, endpoints, live status, join gating and diagnostics. It composes the single-purpose
// modules (checker, installer, endpoints, serverInfo) — it contains no game logic of its own and it
// does not touch AssettoCorsaManager (the dedicated-server HOST side).
//
// Every dependency that reaches outside the process (finding the game, opening Content Manager,
// broadcasting progress) is injected, so the whole service is testable against fixtures.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkAcRequirements, findAcRoot, parseBoardServers, parseCspVersionFromLog, classifyHost } from '../AcRequirementsChecker';
import type { AcRequirementsReport, SrpBundle, SrpServerRequirements } from '../AcRequirementsChecker';
import { getBundledSrpBundle } from '../AcSrpBundle';
import releaseEndpoints from '../../data/assettocorsa-srp/endpoints.public.json';
import catalogReleaseConfig from '../../data/assettocorsa-srp/catalog.config.json';
import { buildJoinUrl, chooseJoinEndpoint, LocalEndpointStore, redactForLog, resolveEndpoints, type AcEndpoint, type LocalEndpointSettings, type ReleaseEndpointsFile, type ResolvedEndpoints } from './endpoints';
import { buildInstallPlan, executeInstall, listInterruptedInstalls, type InstallInputs, type InstallPlan, type InstallProgress, type InstallResult } from './installer';
import { findArchiveTool } from './archive';
import { probeServerInfo, type ServerInfoResult } from './serverInfo';
import { validateTrackArchive, type TrackArchiveValidation } from './trackValidation';
import { defaultTcpProbe, diagnoseEndpoint, type DiagnoseDeps, type EndpointDiagnosis } from './endpointDiagnostics';
import { buildJoinCheck, identityMatches, type JoinCheck } from './joinCheck';
import { checkBaseUrl } from './catalogClient';
import { CatalogSettingsStore, CatalogSync, type CatalogEvent, type CatalogSettings, type CatalogStatus, type SyncReason, type SyncResult } from './catalogSync';
import type { Transport } from './catalogClient';
import type { AdaptedCatalog } from './catalogAdapter';
import { buildContentStatus, buildReadiness, type ContentStatus, type Readiness } from './contentStatus';
import { selectAutoInstall } from './autoInstall';

export interface PlayerServiceDeps {
  userDataPath: string;
  /** Best guess of the AC install (GameScanner / Steam libraries). */
  detectAcRoot: () => Promise<string | null>;
  documentsAcDir: () => string;
  broadcast: (channel: string, data: unknown) => void;
  isContentManagerAvailable: () => boolean;
  /** Where Windows says Content Manager lives (the acmanager:// handler's executable), or null. Used to prove the launch path is real. */
  contentManagerExe?: () => string | null;
  /** Tests: replace the real TCP connect used to test a server's game port. */
  tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<{ ok: boolean; code?: string }>;
  openExternal: (url: string) => Promise<void>;
  bundle?: SrpBundle;
  release?: ReleaseEndpointsFile;
  /** Tests: replace the network probe. */
  probe?: (host: string, httpPort: number, timeoutMs?: number) => Promise<ServerInfoResult>;
  isGameRunning?: () => Promise<boolean>;
  allowLoopbackHttp?: boolean;
  resolver?: (host: string) => Promise<string[]>;
  /** Tests: replace the real DNS/TCP/HTTP probes used by "Test connection". */
  diagnoseDeps?: DiagnoseDeps;
  /** Catalog sync: tests inject the transport, clock and sleeper; release defaults come from catalog.config.json. */
  catalogTransport?: Transport;
  catalogNow?: () => Date;
  catalogSleep?: (ms: number) => Promise<void>;
  catalogRandom?: () => number;
  catalogReleaseDefaults?: Partial<CatalogSettings>;
  /** Whether a saved catalog address / key override may be used (Developer options). Default: yes (tests). */
  catalogAllowOverride?: () => boolean;
}

export interface RequiredContentRow { id: string; name: string; required: boolean; detail?: string }
export interface MercyServerProfile {
  id: string;
  name: string;
  engine: 'kunos-stock' | 'assettoserver' | string;
  purpose: string;
  layoutName: string;
  trackVersion: string;
  maxPlayers: number | null;
  aiTraffic: number | null;
  requiredContent: RequiredContentRow[];
  hud: { delivered: boolean; version: string };
  companionApp: boolean;
  /** Longer description from the catalog, when it has one. */
  description: string | null;
  serverState: 'active' | 'maintenance';
  fromCatalog: boolean;
  tracks: { id: string; name: string; layouts: string[] }[];
  endpoint: { publicConfigured: boolean; publicSource: ResolvedEndpoints['publicSource']; lanConfigured: boolean; problems: string[] };
}

export interface JoinStatus {
  canJoin: boolean;
  blockers: string[];
  via: 'lan' | 'public' | null;
  port: number | null;
  reason: string;
  /** Always true until a real end-to-end join has been observed; shown to the player. */
  unverified: true;
}

const STATUS_TTL_MS = 15_000;
const LOG_MAX = 1024 * 1024;

export class AcPlayerService {
  private builtinBundle: SrpBundle;
  private builtinRelease: ReleaseEndpointsFile;
  private store: LocalEndpointStore;
  private sync: CatalogSync;
  private catalogSettings: CatalogSettingsStore;
  private autoFile: string;
  private autoAttempts: Record<string, string> = {};
  private autoRunning = false;
  private autoRerun = false;
  private settingsFile: string;
  private installLog: string;
  private active: AbortController | null = null;
  private statusCache = new Map<string, { at: number; value: unknown }>();

  constructor(private deps: PlayerServiceDeps) {
    this.builtinBundle = deps.bundle ?? getBundledSrpBundle();
    this.builtinRelease = deps.release ?? (releaseEndpoints as unknown as ReleaseEndpointsFile);
    this.store = new LocalEndpointStore(deps.userDataPath);
    this.settingsFile = path.join(deps.userDataPath, 'ac-player-settings.json');
    this.installLog = path.join(deps.userDataPath, 'ac-install.log');
    this.autoFile = path.join(deps.userDataPath, 'ac-catalog', 'auto-attempts.json');
    try { this.autoAttempts = JSON.parse(fs.readFileSync(this.autoFile, 'utf8')); } catch { /* none yet */ }
    this.catalogSettings = new CatalogSettingsStore(deps.userDataPath, deps.catalogReleaseDefaults ?? (catalogReleaseConfig as unknown as Partial<CatalogSettings>), deps.catalogAllowOverride);
    this.sync = new CatalogSync({
      userDataPath: deps.userDataPath, settings: this.catalogSettings, boardBase: this.builtinBundle,
      builtin: (): AdaptedCatalog => ({ bundle: this.builtinBundle, release: this.builtinRelease, lanDefaults: {}, serverStatus: {}, notices: [] }),
      transport: deps.catalogTransport, now: deps.catalogNow, sleep: deps.catalogSleep, random: deps.catalogRandom,
      onEvent: (e) => this.onCatalogEvent(e),
      log: (l) => this.log(l, []),
    });
  }

  /** The requirements in force: the verified catalog when there is one, otherwise the package built into the launcher. */
  private get bundle(): SrpBundle { return this.sync.adapted().bundle; }
  private get release(): ReleaseEndpointsFile { return this.sync.adapted().release; }

  // ── settings / install location ──────────────────────────────────────────
  private readSettings(): { acRootOverride?: string | null } { try { return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { return {}; } }
  setAcRootOverride(dir: string | null): { success: boolean; error?: string } {
    if (dir && !findAcRoot([dir])) return { success: false, error: 'That folder does not contain Assetto Corsa (acs.exe was not found).' };
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify({ ...this.readSettings(), acRootOverride: dir }, null, 2));
    return { success: true };
  }
  async resolveAcRoot(): Promise<{ root: string | null; source: 'manual' | 'detected' | 'none' }> {
    const ov = this.readSettings().acRootOverride;
    if (ov && findAcRoot([ov])) return { root: ov, source: 'manual' };
    const det = findAcRoot([await this.deps.detectAcRoot().catch(() => null)]);
    return det ? { root: det, source: 'detected' } : { root: null, source: 'none' };
  }

  private server(id: string): SrpServerRequirements {
    const s = this.bundle.servers.find((x) => x.server.id === id);
    if (!s) throw new Error(`Unknown Mercy server "${id}"`);
    return s;
  }
  private endpointsFor(id: string): ResolvedEndpoints {
    const local = this.store.get(id);
    // A development catalog may offer a LAN address for testing; a value the player typed always wins, and a production catalog never has one.
    const dflt = this.sync.adapted().lanDefaults[id];
    return resolveEndpoints(this.server(id), this.release, !local.lanHost && dflt ? { ...local, lanHost: dflt.host } : local);
  }
  private get devCatalog() { return this.sync.status().environment === 'development'; }

  // ── profiles (the data behind the server cards) ──────────────────────────
  listServers(): MercyServerProfile[] { return this.bundle.servers.map((s) => this.profile(s)); }
  private profile(s: SrpServerRequirements): MercyServerProfile {
    const ep = this.endpointsFor(s.server.id);
    const trackInv = this.bundle.tracks.tracks.find((t) => t.id === s.track.id);
    const trackTitle = s.track.name ?? 'Shutoko Revival Project';
    const adapted = this.sync.adapted();
    // "Track - Layout" -> "Layout"; empty when the layout adds nothing beyond the track's own name.
    const shortOf = (t: { layout: string; layoutName?: string; name?: string }) => { const l = (t.layoutName ?? t.layout).split(' - ').pop()!.trim(); return l === (t.name ?? '') ? '' : l; };
    const packs = new Map<string, { name: string; n: number }>();
    for (const c of s.cars) {
      const src = this.bundle.sources.sources.find((x) => x.sourceId === c.source);
      const key = c.source; const cur = packs.get(key) ?? { name: src?.name ?? (c.source === 'ac_base_game' ? 'Assetto Corsa base game' : c.source), n: 0 };
      cur.n++; packs.set(key, cur);
    }
    const aiN = s.server.ai?.enabled ? (s.server.ai.trafficCars ?? 0) : 0;
    // The package's layoutName is a full title ("Shutoko Revival Project 0.9.3 - Daishi PA"); the card wants just the layout.
    const shortLayout = shortOf(s.track);
    const content: RequiredContentRow[] = [
      { id: 'ac', name: 'Assetto Corsa (Steam)', required: true },
      { id: 'csp', name: `Custom Shaders Patch ${s.csp.minimumVersion}+`, required: s.csp.required, detail: `Tested on ${s.csp.testedVersion}. You install and update this yourself.` },
      { id: 'track', name: `${trackTitle} ${trackInv?.version ?? s.track.version}${shortLayout ? ` — ${shortLayout}` : ''}`, required: !s.track.optional },
      ...(s.extraTracks ?? []).map((t) => ({ id: `track:${t.id}`, name: `${t.name ?? t.id} ${t.version}${shortOf(t) ? ` — ${shortOf(t)}` : ''}`, required: !t.optional })),
      ...[...packs.entries()].map(([id, p]) => ({ id: `cars:${id}`, name: `${p.n} car${p.n === 1 ? '' : 's'} from ${p.name}`, required: true })),
      ...s.companionApps.map((a) => ({ id: `app:${a.id}`, name: 'SRP Board companion app', required: false, detail: 'Hides the F9 position strip on this server.' })),
    ];
    return {
      id: s.server.id, name: s.server.displayName, engine: s.server.type,
      purpose: `${[trackTitle, shortLayout].filter(Boolean).join(' · ')} · ${s.server.maxPlayers ?? '?'} player slots · ${aiN ? `${aiN} AI traffic cars` : 'no AI traffic'}`,
      layoutName: s.track.layoutName ?? s.track.layout, trackVersion: s.track.version,
      maxPlayers: s.server.maxPlayers ?? null, aiTraffic: s.server.ai ? aiN : null,
      requiredContent: content,
      hud: { delivered: s.hud.delivery !== 'none', version: s.hud.version },
      companionApp: s.companionApps.length > 0,
      description: this.sync.currentCatalog()?.servers.find((x) => x.id === s.server.id)?.description ?? null,
      serverState: adapted.serverStatus[s.server.id] === 'maintenance' ? 'maintenance' : 'active',
      fromCatalog: this.sync.usingCatalog(),
      tracks: [s.track, ...(s.extraTracks ?? [])].map((t) => ({ id: t.id, name: t.name ?? t.id, layouts: [t.layout, ...(t.extraLayouts ?? [])] })),
      endpoint: { publicConfigured: !!ep.public, publicSource: ep.publicSource, lanConfigured: !!ep.lan, problems: ep.problems },
    };
  }

  // ── endpoints ─────────────────────────────────────────────────────────────
  getLocalEndpoints(id: string): LocalEndpointSettings { this.server(id); return this.store.get(id); }
  setLocalEndpoints(id: string, patch: Partial<LocalEndpointSettings>) { this.server(id); this.statusCache.delete(id); return this.store.set(id, patch); }

  // ── requirements / plan / install ────────────────────────────────────────
  async check(id: string, opts: { deep?: boolean } = {}): Promise<AcRequirementsReport> {
    this.server(id);
    const { root } = await this.resolveAcRoot();
    return checkAcRequirements({ acRoot: root, bundle: this.bundle, serverId: id, deep: opts.deep, documentsAcDir: this.deps.documentsAcDir() });
  }
  async plan(id: string): Promise<InstallPlan> {
    const { root } = await this.resolveAcRoot();
    return buildInstallPlan({ acRoot: root, bundle: this.bundle, serverId: id, endpoints: this.endpointsFor(id), documentsAcDir: this.deps.documentsAcDir(), resolver: this.deps.resolver, allowLoopbackHttp: this.deps.allowLoopbackHttp, allowPrivateHttp: this.devCatalog });
  }
  isInstalling(): boolean { return this.active !== null; }
  cancelInstall(): boolean { if (!this.active) return false; this.active.abort(); return true; }

  async install(id: string, approvedIds: string[], inputs: InstallInputs = {}): Promise<InstallResult> {
    if (this.active) throw new Error('An installation is already running.');
    const { root } = await this.resolveAcRoot();
    if (!root) throw new Error('Assetto Corsa was not found. Set the game folder in Setup & Diagnostics first.');
    const cs = this.sync.status();
    if (this.sync.usingCatalog() && !cs.installsAllowed) throw new Error(cs.installBlockedReason ?? 'Installing is paused for this catalog.');
    const plan = await this.plan(id);
    const ctrl = new AbortController(); this.active = ctrl;
    const ep = this.endpointsFor(id);
    const hosts = [ep.lan?.host, ep.public?.host];
    this.log(`--- install started for ${id}: ${approvedIds.length} item(s) approved ---`, hosts);
    try {
      const res = await executeInstall({
        acRoot: root, bundle: this.bundle, serverId: id, endpoints: ep, downloadDir: path.join(this.deps.userDataPath, 'ac-downloads'),
        documentsAcDir: this.deps.documentsAcDir(), resolver: this.deps.resolver, isGameRunning: this.deps.isGameRunning, allowLoopbackHttp: this.deps.allowLoopbackHttp, allowPrivateHttp: this.devCatalog, signal: ctrl.signal,
        onProgress: (p: InstallProgress) => this.deps.broadcast('assettocorsa:install:progress', { serverId: id, ...p }),
        log: (l) => this.log(l, hosts),
      }, plan, approvedIds, inputs);
      this.log(`--- install finished: ${res.success ? 'success' : 'incomplete'}; ${res.groups.map((g) => `${g.group}=${g.ok ? 'ok' : g.rolledBack ? 'rolled back' : 'failed'}`).join(', ')} ---`, hosts);
      this.statusCache.delete(id);
      return res;
    } finally { this.active = null; this.flushAutoRerun(); }
  }

  private log(line: string, hosts: (string | null | undefined)[]) {
    try {
      fs.mkdirSync(path.dirname(this.installLog), { recursive: true });
      if (fs.existsSync(this.installLog) && fs.statSync(this.installLog).size > LOG_MAX) fs.writeFileSync(this.installLog, fs.readFileSync(this.installLog, 'utf8').slice(-200_000));
      fs.appendFileSync(this.installLog, `${new Date().toISOString()} ${redactForLog(line, hosts)}\n`);
    } catch { /* logging must never break an install */ }
  }
  readInstallLog(limit = 80): string[] { try { return fs.readFileSync(this.installLog, 'utf8').split('\n').filter(Boolean).slice(-limit); } catch { return []; } }

  // ── live status + joining ────────────────────────────────────────────────
  async status(id: string, force = false): Promise<{ state: 'online' | 'offline' | 'unconfigured'; via?: 'lan' | 'public'; players?: number; maxPlayers?: number; reason: string; checkedAt?: string }> {
    const ep = this.endpointsFor(id);
    const target = ep.lan ?? ep.public;
    if (!target) return { state: 'unconfigured', reason: 'No endpoint is configured, so the server\'s status cannot be checked. The public host name (PUBLIC_HOST_TBD) has not been assigned.' };
    const cached = this.statusCache.get(id);
    if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value as any;
    const r = await (this.deps.probe ?? probeServerInfo)(target.host, target.httpPort, 3000);
    const value = r.online
      ? { state: 'online' as const, via: target.scope, players: r.players, maxPlayers: r.maxPlayers, reason: 'The server answered its status page just now.', checkedAt: r.checkedAt }
      : { state: 'offline' as const, via: target.scope, reason: r.reason ?? 'No answer.', checkedAt: r.checkedAt };
    this.statusCache.set(id, { at: Date.now(), value });
    return value;
  }

  async joinStatus(id: string): Promise<JoinStatus> {
    const blockers: string[] = [];
    const report = await this.check(id, { deep: true });
    if (!report.summary.readyToJoin) blockers.push(...report.summary.blockers.map((b) => b.slice(0, 220)));
    const ep = this.endpointsFor(id);
    let lanReachable: boolean | null = null;
    if (ep.lan) lanReachable = (await (this.deps.probe ?? probeServerInfo)(ep.lan.host, ep.lan.httpPort, 1500)).online;
    const choice = chooseJoinEndpoint(ep, lanReachable);
    if (!choice.endpoint) blockers.push(choice.reason);
    const cs = this.sync.status();
    if (cs.source === 'catalog' && cs.expired) blockers.push('The server catalog has expired, so the requirements may be out of date. Refresh the catalog first.');
    if (!this.deps.isContentManagerAvailable()) blockers.push('Content Manager (the acmanager:// link handler) was not found. Joining is launched through Content Manager.');
    return { canJoin: blockers.length === 0, blockers, via: choice.endpoint?.scope ?? null, port: choice.endpoint?.tcpPort ?? null, reason: choice.reason, unverified: true };
  }

  /**
   * The full, fact-based answer to "can I join this server now?": address, the server's own status page (and that it
   * is the RIGHT server), a TCP test of its game port, Assetto Corsa, Content Manager, CSP and the required content.
   * Returns ONE of ready / missing / unavailable plus the exact reasons. Nothing here changes anything.
   */
  async joinCheck(id: string): Promise<JoinCheck> { return (await this.runJoinCheck(id)).check; }

  private async runJoinCheck(id: string): Promise<{ check: JoinCheck; endpoint: AcEndpoint | null }> {
    const s = this.server(id);
    const ep = this.endpointsFor(id);
    const probe = this.deps.probe ?? probeServerInfo;
    const tcpProbe = this.deps.tcpProbe ?? defaultTcpProbe;
    const lanReachable = ep.lan ? (await probe(ep.lan.host, ep.lan.httpPort, 1500)).online : null;
    const choice = chooseJoinEndpoint(ep, lanReachable);
    const chosen = choice.endpoint;
    const [info, tcp] = chosen ? await Promise.all([probe(chosen.host, chosen.httpPort, 3000), tcpProbe(chosen.host, chosen.tcpPort, 3000)]) : [null, null];
    const content = await this.contentStatus(id);
    const exe = this.deps.contentManagerExe?.() ?? null;
    const base = checkBaseUrl(this.catalogSettings.get().baseUrl);
    const catalogHostIsPrivate = base.ok && base.privateHost && classifyHost(new URL(base.base).hostname) === 'private-lan';
    const check = buildJoinCheck({
      serverId: id, serverName: s.server.displayName, expectedTrack: { trackId: s.track.id, layout: s.track.layout },
      content, endpoints: ep, chosen, chosenReason: choice.reason, info, tcp,
      contentManager: { available: this.deps.isContentManagerAvailable(), exePath: exe, exeExists: exe ? fs.existsSync(exe) : null },
      source: this.sync.usingCatalog() ? 'catalog' : 'builtin', catalogHostIsPrivate, portsKnown: !!s.server.game,
    });
    return { check, endpoint: chosen };
  }

  /**
   * Hands the join link to Content Manager, but only after a fresh joinCheck says Ready. The result says exactly how far it
   * got: 'blocked' (a check failed; nothing was launched), 'launch' (the hand-off itself failed) or 'handed-off' (the OS
   * accepted the link). It never claims the game connected: that is not observable from here.
   */
  async join(id: string): Promise<{ success: boolean; stage: 'blocked' | 'launch' | 'handed-off'; error?: string; note?: string; check: JoinCheck }> {
    const { check, endpoint } = await this.runJoinCheck(id);
    if (!check.canJoin || !endpoint) {
      const first = check.issues.find((x) => x.severity === 'blocker');
      return { success: false, stage: 'blocked', error: first ? `${first.title}. ${first.detail}` : 'Not ready to join.', check };
    }
    const hosts = [endpoint.host, this.endpointsFor(id).lan?.host, this.endpointsFor(id).public?.host];
    this.log(`join requested for ${id} via ${endpoint.scope} endpoint (http port ${endpoint.httpPort})`, hosts);
    try { await this.deps.openExternal(buildJoinUrl(endpoint)); }
    catch (e: any) {
      this.log(`join hand-off failed for ${id}: ${e?.message ?? 'unknown error'}`, hosts);
      return { success: false, stage: 'launch', error: `Content Manager could not be opened (${redactForLog(String(e?.message ?? 'unknown error'), hosts)}). Check that Content Manager still starts, then try again.`, check };
    }
    this.log(`join link handed to Content Manager for ${id}`, hosts);
    return { success: true, stage: 'handed-off', note: 'The join request was handed to Content Manager, which should open and start the game. Mercy Launcher cannot see whether the connection then succeeds.', check };
  }

  /**
   * For the owner at home: the catalog is served from a private address, on the same machine as the game servers. This
   * tries that address for every server that has no address yet, and keeps it (as THIS PC's LAN address only) ONLY where
   * the server's own status page answers there AND names the expected server. Nothing is invented or published.
   */
  async adoptCatalogHost(): Promise<{ host: boolean; results: { serverId: string; name: string; adopted: boolean; reason: string }[] }> {
    const base = checkBaseUrl(this.catalogSettings.get().baseUrl);
    const results: { serverId: string; name: string; adopted: boolean; reason: string }[] = [];
    if (!base.ok || !base.privateHost) return { host: false, results };
    const host = new URL(base.base).hostname;
    if (classifyHost(host) !== 'private-lan') return { host: false, results };
    const probe = this.deps.probe ?? probeServerInfo;
    for (const s of this.bundle.servers) {
      const id = s.server.id; const name = s.server.displayName;
      const cur = this.endpointsFor(id);
      if (cur.public || cur.lan) { results.push({ serverId: id, name, adopted: false, reason: 'Already has an address.' }); continue; }
      if (!s.server.game) { results.push({ serverId: id, name, adopted: false, reason: 'The catalog gives no ports for this server.' }); continue; }
      const info = await probe(host, s.server.game.httpPort, 3000);
      if (!info.online) { results.push({ serverId: id, name, adopted: false, reason: 'Nothing answered there for this server.' }); continue; }
      if (identityMatches(info.name, name) !== 'match') { results.push({ serverId: id, name, adopted: false, reason: 'Something answered, but not this server, so it was not used.' }); continue; }
      const r = this.setLocalEndpoints(id, { lanHost: host });
      results.push({ serverId: id, name, adopted: r.success, reason: r.success ? 'Connected over your home network.' : (r.error ?? 'Could not save.') });
    }
    this.statusCache.clear();
    return { host: true, results };
  }

  // ── server catalog (signed, synced) ──────────────────────────────────────────
  startCatalog(): void { this.sync.start(); void this.refreshCatalog('startup').catch(() => undefined); }
  stopCatalog(): void { this.sync.stop(); }
  /** The rules for which catalog settings apply changed (Developer options toggled): re-evaluate and refresh. */
  catalogOverrideChanged(): void {
    this.sync.settingsChanged(); this.statusCache.clear();
    this.deps.broadcast('assettocorsa:catalog:event', { type: 'status', status: this.sync.status() });
    void this.refreshCatalog('manual').catch(() => undefined);
  }
  catalogStatus(): CatalogStatus { return this.sync.status(); }
  getCatalogSettings(): CatalogSettings { return this.catalogSettings.get(); }
  setCatalogSettings(patch: Partial<CatalogSettings>): { settings: CatalogSettings; errors: string[] } {
    const before = this.catalogSettings.get();
    const r = this.catalogSettings.set(patch);
    const keysChanged = JSON.stringify(before.trustedKeys) !== JSON.stringify(r.settings.trustedKeys);
    if (before.baseUrl !== r.settings.baseUrl || keysChanged || before.allowUnsignedDev !== r.settings.allowUnsignedDev) this.sync.settingsChanged();
    this.autoAttempts = {}; this.saveAuto();
    this.statusCache.clear();
    this.deps.broadcast('assettocorsa:catalog:event', { type: 'status', status: this.sync.status() });
    if (r.settings.installMode === 'auto') void this.runAutoInstall('settings-changed').catch(() => undefined);
    return r;
  }
  resetCatalog(): CatalogStatus { this.sync.reset(); this.autoAttempts = {}; this.saveAuto(); this.statusCache.clear(); return this.sync.status(); }
  async refreshCatalog(reason: SyncReason): Promise<SyncResult> {
    const r = await this.sync.refresh(reason);
    if (r.outcome === 'updated') this.statusCache.clear();
    return r;
  }
  private onCatalogEvent(e: CatalogEvent) {
    try { this.deps.broadcast('assettocorsa:catalog:event', e); } catch { /* UI may be gone */ }
    if (e.type === 'changed') { this.statusCache.clear(); void this.runAutoInstall('catalog-changed').catch(() => undefined); }
  }

  /** What is installed / missing / outdated / incompatible / manual for one server, derived from a real check. */
  async contentStatus(id: string): Promise<ContentStatus> {
    const report = await this.check(id, { deep: true });
    const plan = await this.plan(id);
    return buildContentStatus(report, plan, this.server(id));
  }
  /** The join-readiness stepper. Keeps catalog availability, content readiness, game-port reachability and an actual join apart. */
  async readiness(id: string, known?: ContentStatus): Promise<Readiness> {
    const content = known ?? await this.contentStatus(id);
    const ep = this.endpointsFor(id);
    const configured = !!(ep.public || ep.lan);
    let info: 'online' | 'offline' | 'unconfigured' | undefined;
    if (configured) { try { info = (await this.status(id)).state; } catch { info = 'offline'; } }
    return buildReadiness({ serverId: id, catalog: this.sync.status(), content, endpointConfigured: configured, infoState: info, contentManagerAvailable: this.deps.isContentManagerAvailable(), serverStatus: this.sync.adapted().serverStatus[id] });
  }

  private saveAuto() { try { fs.mkdirSync(path.dirname(this.autoFile), { recursive: true }); fs.writeFileSync(this.autoFile, JSON.stringify(this.autoAttempts)); } catch { /* best effort */ } }
  /**
   * Automatic install for servers the player marked "keep ready", when (and only when) auto mode is on and the
   * catalog is signed, current and a production one. Everything it does goes through the same verified installer and
   * is logged. A given revision + item set is attempted once, so a failure never turns into a download loop.
   */
  async runAutoInstall(trigger: string): Promise<{ ran: { serverId: string; itemIds: string[]; success: boolean; error?: string }[]; skipped: { serverId: string; reason: string }[] }> {
    const out = { ran: [] as { serverId: string; itemIds: string[]; success: boolean; error?: string }[], skipped: [] as { serverId: string; reason: string }[] };
    const settings = this.catalogSettings.get();
    if (settings.installMode !== 'auto') return out;
    // A trigger that arrives mid-run (settings changed, new revision) is remembered and handled right after, never lost.
    if (this.autoRunning || this.active) { this.autoRerun = true; out.skipped.push({ serverId: '*', reason: 'An install is already running.' }); return out; }
    this.autoRunning = true;
    try {
      const { root } = await this.resolveAcRoot();
      if (!root) { out.skipped.push({ serverId: '*', reason: 'Assetto Corsa was not found.' }); return out; }
      for (const s of this.bundle.servers) {
        const id = s.server.id;
        if (!settings.autoServers.includes(id)) continue;
        const status = this.sync.status();
        let plan: InstallPlan;
        try { plan = await this.plan(id); } catch (e) { out.skipped.push({ serverId: id, reason: (e as Error).message }); continue; }
        const gameRunning = this.deps.isGameRunning ? await this.deps.isGameRunning().catch(() => false) : false;
        const sel = selectAutoInstall({ plan, settings, status, serverId: id, gameRunning });
        if (sel.refused) { out.skipped.push({ serverId: id, reason: sel.refused }); continue; }
        if (!sel.itemIds.length) { out.skipped.push({ serverId: id, reason: sel.skipped[0]?.reason ?? 'Nothing to install.' }); continue; }
        const key = `${status.revision}|${[...sel.itemIds].sort().join(',')}`;
        if (this.autoAttempts[id] === key) { out.skipped.push({ serverId: id, reason: 'Already attempted for this catalog revision.' }); continue; }
        this.autoAttempts[id] = key; this.saveAuto();
        const hosts = [this.endpointsFor(id).lan?.host, this.endpointsFor(id).public?.host];
        this.log(`auto-install (${trigger}) for ${id}: ${sel.itemIds.length} item(s), ${(sel.totalBytes / 1e6).toFixed(0)} MB`, hosts);
        this.deps.broadcast('assettocorsa:catalog:auto-install', { serverId: id, phase: 'started', itemIds: sel.itemIds });
        try {
          const res = await this.install(id, sel.itemIds);
          out.ran.push({ serverId: id, itemIds: sel.itemIds, success: res.success, error: res.success ? undefined : res.groups.find((g) => g.error)?.error });
        } catch (e) { out.ran.push({ serverId: id, itemIds: sel.itemIds, success: false, error: (e as Error).message }); }
        const last = out.ran[out.ran.length - 1];
        this.log(`auto-install for ${id} ${last.success ? 'finished' : `did not finish: ${last.error ?? 'see the install log'}`}`, hosts);
        this.deps.broadcast('assettocorsa:catalog:auto-install', { phase: 'done', ...last });
      }
      return out;
    } finally { this.autoRunning = false; this.flushAutoRerun(); }
  }
  private flushAutoRerun() { if (this.autoRerun && !this.active && !this.autoRunning) { this.autoRerun = false; void this.runAutoInstall('queued').catch(() => undefined); } }

  // ── storage the installer uses (downloaded archives, backups of replaced files) ──
  private downloadDir() { return path.join(this.deps.userDataPath, 'ac-downloads'); }
  private static dirBytes(dir: string): number {
    let n = 0;
    (function walk(d: string) { let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { n += fs.statSync(p).size; } catch {} } })(dir);
    return n;
  }

  /** What the launcher is keeping on disk for you, so it can be seen and cleaned up. Read-only. */
  async storageInfo(): Promise<{
    downloads: { dir: string; totalBytes: number; files: { name: string; bytes: number }[] };
    backups: { id: string; path: string; createdAt: string | null; bytes: number; items: string[]; inProgress: boolean }[];
  }> {
    const dl = this.downloadDir(); const files: { name: string; bytes: number }[] = [];
    try { for (const e of fs.readdirSync(dl, { withFileTypes: true })) if (e.isFile()) files.push({ name: e.name, bytes: fs.statSync(path.join(dl, e.name)).size }); } catch {}
    const backups: { id: string; path: string; createdAt: string | null; bytes: number; items: string[]; inProgress: boolean }[] = [];
    const { root } = await this.resolveAcRoot();
    if (root) {
      const br = path.join(root, 'content', '.mercy-backups'); let ids: string[] = []; try { ids = fs.readdirSync(br); } catch {}
      for (const id of ids.sort().reverse()) {
        const dir = path.join(br, id); let st: fs.Stats; try { st = fs.statSync(dir); } catch { continue; } if (!st.isDirectory()) continue;
        let state = ''; let createdAt: string | null = null;
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8')); state = j.state; createdAt = j.startedAt ?? null; } catch {}
        const items: string[] = [];
        for (const sub of ['content/cars', 'content/tracks', 'apps/lua']) { try { for (const e of fs.readdirSync(path.join(dir, ...sub.split('/')), { withFileTypes: true })) if (e.isDirectory()) items.push(`${sub}/${e.name}`); } catch {} }
        backups.push({ id, path: dir, createdAt, bytes: AcPlayerService.dirBytes(dir), items, inProgress: state === 'staging' || state === 'placing' });
      }
    }
    return { downloads: { dir: dl, totalBytes: files.reduce((s, f) => s + f.bytes, 0), files }, backups };
  }

  /** Deletes only the launcher's own download cache (never anything in the game folder). */
  deleteDownloads(): { success: boolean; freedBytes: number; error?: string } {
    const dl = this.downloadDir(); let freed = 0;
    try { for (const e of fs.readdirSync(dl, { withFileTypes: true })) { const p = path.join(dl, e.name); if (e.isFile()) { freed += fs.statSync(p).size; fs.rmSync(p, { force: true }); } } return { success: true, freedBytes: freed }; }
    catch (e: any) { return e?.code === 'ENOENT' ? { success: true, freedBytes: 0 } : { success: false, freedBytes: freed, error: e?.message ?? 'Could not delete the downloads.' }; }
  }

  /** Deletes one backup the installer made. Refuses anything outside .mercy-backups and any install still in progress. */
  async deleteBackup(id: string): Promise<{ success: boolean; freedBytes: number; error?: string }> {
    if (typeof id !== 'string' || !/^[0-9A-Za-z_\-]+$/.test(id)) return { success: false, freedBytes: 0, error: 'That is not a backup name.' };
    const { root } = await this.resolveAcRoot();
    if (!root) return { success: false, freedBytes: 0, error: 'Assetto Corsa was not found.' };
    const dir = path.join(root, 'content', '.mercy-backups', id);
    if (!fs.existsSync(dir)) return { success: false, freedBytes: 0, error: 'That backup no longer exists.' };
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8')); if (j.state === 'staging' || j.state === 'placing') return { success: false, freedBytes: 0, error: 'That install did not finish; it will be rolled back automatically next time. Its backup is needed until then.' }; } catch {}
    const bytes = AcPlayerService.dirBytes(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); return { success: true, freedBytes: bytes }; }
    catch (e: any) { return { success: false, freedBytes: 0, error: /EBUSY|EPERM|EACCES/.test(e?.code ?? '') ? 'A file in that backup is in use. Close Assetto Corsa and Content Manager, then try again.' : (e?.message ?? 'Could not delete the backup.') }; }
  }

  // ── track archive pre-flight + endpoint test ──────────────────────────────
  /** Read-only: is this player-chosen archive really the SRP build the servers run? */
  async validateTrackArchive(archivePath: string, trackId?: string): Promise<TrackArchiveValidation> {
    return validateTrackArchive(archivePath, this.bundle, { hashWholeFile: true, trackId });
  }

  /** Probes the configured endpoint from this computer. Says plainly when nothing is configured. */
  async testEndpoint(id: string, scope: 'lan' | 'public'): Promise<{ configured: boolean; message?: string; diagnosis?: EndpointDiagnosis }> {
    const ep = this.endpointsFor(id)[scope];
    if (!ep) return { configured: false, message: scope === 'public'
      ? 'No public endpoint is configured for this server (PUBLIC_HOST_TBD). Enter the public host name in the field above and save, then test again.'
      : 'No LAN address is set on this computer for this server.' };
    return { configured: true, diagnosis: await diagnoseEndpoint(ep, this.deps.diagnoseDeps) };
  }

  // ── diagnostics ───────────────────────────────────────────────────────────
  async diagnostics() {
    const { root, source } = await this.resolveAcRoot();
    const docs = this.deps.documentsAcDir();
    const out: any = {
      acRoot: root, acRootSource: source, documentsDir: docs, documentsExists: fs.existsSync(docs),
      archiveTool: findArchiveTool()?.kind ?? 'none', platform: `${os.platform()} ${os.release()}`,
      contentManager: { protocolHandler: this.deps.isContentManagerAvailable() },
      csp: { installed: false, version: null as string | null, build: null as number | null, source: 'none' as string },
      content: { cars: 0, tracks: 0 }, luaApps: [] as string[], srpBoard: null as any, srpHudConflict: false,
      freeGb: null as number | null, interruptedInstalls: [] as string[], cspLogSrpLines: [] as string[], installLog: this.readInstallLog(40),
      catalog: this.sync.status(),
      endpoints: this.bundle.servers.map((s) => { const e = this.endpointsFor(s.server.id); return { serverId: s.server.id, publicConfigured: !!e.public, publicSource: e.publicSource, lanConfigured: !!e.lan, problems: e.problems }; }),
    };
    if (!root) return out;
    out.interruptedInstalls = listInterruptedInstalls(root);
    out.csp.installed = fs.existsSync(path.join(root, 'dwrite.dll')) && fs.existsSync(path.join(root, 'extension'));
    try { out.content.cars = fs.readdirSync(path.join(root, 'content', 'cars'), { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch {}
    try { out.content.tracks = fs.readdirSync(path.join(root, 'content', 'tracks'), { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch {}
    try { out.luaApps = fs.readdirSync(path.join(root, 'apps', 'lua'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
    out.srpHudConflict = out.luaApps.includes('srp_hud');
    try { const st = fs.statfsSync(root); out.freeGb = Math.round(Number(st.bavail) * Number(st.bsize) / 1e8) / 10; } catch {}
    const logFile = path.join(docs, 'logs', 'custom_shaders_patch.log');
    try {
      const fd = fs.openSync(logFile, 'r'); const size = fs.fstatSync(fd).size;
      const headLen = Math.min(size, 16 * 1024); const head = Buffer.alloc(headLen); fs.readSync(fd, head, 0, headLen, 0);
      const take = Math.min(size, 512 * 1024); const tail = Buffer.alloc(take); fs.readSync(fd, tail, 0, take, size - take); fs.closeSync(fd);
      const text = tail.toString('utf8');
      const v = parseCspVersionFromLog(head.toString('utf8'));
      if (v) out.csp = { ...out.csp, version: v.version, build: v.build, source: 'last-run custom_shaders_patch.log' };
      const hosts: string[] = [];
      for (const s of this.bundle.servers) { const e = this.endpointsFor(s.server.id); if (e.lan) hosts.push(e.lan.host); if (e.public) hosts.push(e.public.host); }
      out.cspLogSrpLines = text.split(/\r?\n/).filter((l) => /\[SRP Board\]|SRP server:|srp_hud|SRP HUD|Remote server script|position strip/i.test(l)).slice(-30).map((l) => redactForLog(l.slice(0, 300), hosts));
    } catch {}
    const appDir = path.join(root, 'apps', 'lua', 'srp_board');
    if (fs.existsSync(appDir)) {
      let version: string | null = null; let stamped: { kind: string; port: number }[] | null = null;
      try { version = /^VERSION=(.*)$/m.exec(fs.readFileSync(path.join(appDir, 'manifest.ini'), 'utf8'))?.[1]?.trim() ?? null; } catch {}
      try { const e = parseBoardServers(fs.readFileSync(path.join(appDir, 'srp_board.lua'), 'latin1')); stamped = e ? e.map((x) => { const i = x.lastIndexOf(':'); return { kind: classifyHost(x.slice(0, i)), port: parseInt(x.slice(i + 1), 10) }; }) : null; } catch {}
      // Does the installed stamp cover the endpoints configured on THIS computer? (booleans only — never the addresses)
      let rawStamped: string[] = [];
      try { rawStamped = (parseBoardServers(fs.readFileSync(path.join(appDir, 'srp_board.lua'), 'latin1')) ?? []).map((x) => x.toLowerCase()); } catch {}
      const coverage = this.bundle.servers.filter((s) => s.companionApps.length > 0).map((s) => {
        const e = this.endpointsFor(s.server.id);
        const has = (t: AcEndpoint | null) => (t ? rawStamped.includes(`${t.host.toLowerCase()}:${t.tcpPort}`) : null);
        return { serverId: s.server.id, public: has(e.public), lan: has(e.lan) };
      });
      out.srpBoard = { installed: true, version, stamped, coverage };
    } else out.srpBoard = { installed: false, version: null, stamped: null };
    return out;
  }
}
