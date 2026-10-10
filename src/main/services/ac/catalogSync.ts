// Keeps the launcher's view of the Mercy servers in step with the signed catalog the owner publishes.
//
//  evaluateCatalog — the acceptance policy for one downloaded catalog (pure; documented in the contract §10).
//  CatalogSettingsStore — owner-configurable settings (address, pinned keys, install mode…), validated on write.
//  CatalogSync — fetch → evaluate → cache → diff → notify, with rate limits, backoff and a last-good fallback.
//
// A catalog that fails ANY check is dropped and the previous good one stays in use. Nothing here installs content.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SrpBundle } from '../AcRequirementsChecker';
import type { ReleaseEndpointsFile } from './endpoints';
import { catalogToBundle, type AdaptedCatalog } from './catalogAdapter';
import { checkBaseUrl, fetchCatalogFiles, normalizeCatalogPaths, DEFAULT_CATALOG_PATHS, MAX_CATALOG_BYTES, type CatalogPaths, type FetchOutcome, type Transport } from './catalogClient';

type Fetched = Extract<FetchOutcome, { kind: 'fetched' }>;
import { diffCatalogs, type CatalogDiff } from './catalogDiff';
import { validateCatalog, type AcCatalog } from './catalogSchema';
import { parsePublicKey, sha256Hex, verifyCatalogSignature, type TrustedKey } from './catalogSigning';

// ── settings ──────────────────────────────────────────────────────────────────
export interface CatalogSettings {
  baseUrl: string | null;
  /** Where the catalog + signature are served under baseUrl. Release-config only: a player cannot change it. */
  paths: CatalogPaths;
  trustedKeys: TrustedKey[];
  /** Development catalogs fetched from a private address may be unsigned. Never applies to production catalogs. */
  allowUnsignedDev: boolean;
  intervalMinutes: number;
  installMode: 'review' | 'auto';
  /** Auto mode may also replace existing content (always with a backup). Default off. */
  autoUpdateExisting: boolean;
  maxAutoDownloadBytes: number;
  /** Servers the player marked "keep ready": auto mode only ever installs for these. */
  autoServers: string[];
}
export const DEFAULT_SETTINGS: CatalogSettings = {
  baseUrl: null, paths: DEFAULT_CATALOG_PATHS, trustedKeys: [], allowUnsignedDev: false, intervalMinutes: 15, installMode: 'review', autoUpdateExisting: false, maxAutoDownloadBytes: 1024 ** 3, autoServers: [],
};
export const INTERVAL_RANGE = [5, 120] as const;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeSettings(raw: unknown, fallback: CatalogSettings = DEFAULT_SETTINGS): CatalogSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const keys: TrustedKey[] = [];
  if (Array.isArray(r.trustedKeys)) for (const k of r.trustedKeys) {
    const o = k as Partial<TrustedKey>;
    if (o && typeof o.keyId === 'string' && KEY_ID_RE.test(o.keyId) && typeof o.publicKey === 'string' && parsePublicKey(o.publicKey) && !keys.some((x) => x.keyId === o.keyId)) keys.push({ keyId: o.keyId, publicKey: o.publicKey.trim() });
  }
  const baseOk = typeof r.baseUrl === 'string' && checkBaseUrl(r.baseUrl).ok;
  return {
    baseUrl: r.baseUrl === null ? null : baseOk ? (r.baseUrl as string).trim() : fallback.baseUrl,
    paths: r.paths !== undefined ? normalizeCatalogPaths(r.paths) : fallback.paths,
    trustedKeys: Array.isArray(r.trustedKeys) ? keys : fallback.trustedKeys,
    allowUnsignedDev: typeof r.allowUnsignedDev === 'boolean' ? r.allowUnsignedDev : fallback.allowUnsignedDev,
    intervalMinutes: num(r.intervalMinutes, INTERVAL_RANGE[0], INTERVAL_RANGE[1], fallback.intervalMinutes),
    installMode: r.installMode === 'auto' || r.installMode === 'review' ? r.installMode : fallback.installMode,
    autoUpdateExisting: typeof r.autoUpdateExisting === 'boolean' ? r.autoUpdateExisting : fallback.autoUpdateExisting,
    maxAutoDownloadBytes: num(r.maxAutoDownloadBytes, 1, 16 * 1024 ** 3, fallback.maxAutoDownloadBytes),
    autoServers: Array.isArray(r.autoServers) ? [...new Set((r.autoServers as unknown[]).filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x)))].slice(0, 50) : fallback.autoServers,
  };
}

/** Reads/writes userData/ac-catalog-settings.json on top of the release defaults (catalog.config.json).
 *  The release config is what an ordinary player runs: an EMPTY saved address (null / "" — what older builds wrote when the
 *  address box was left blank) never overrides it, and the address / keys / unsigned opt-in / interval saved in the file are
 *  only honoured while `allowOverride()` is true (Developer options). Preferences (install mode, keep-ready list, …) always apply. */
export class CatalogSettingsStore {
  private file: string;
  constructor(userDataPath: string, private releaseDefaults: Partial<CatalogSettings> = {}, private allowOverride: () => boolean = () => true) { this.file = path.join(userDataPath, 'ac-catalog-settings.json'); }
  private user(): Partial<CatalogSettings> { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  get(): CatalogSettings {
    const base = normalizeSettings(this.releaseDefaults);
    const raw = this.user();
    const u: Partial<CatalogSettings> = this.allowOverride() ? raw : { ...raw, baseUrl: undefined, trustedKeys: undefined, allowUnsignedDev: undefined, intervalMinutes: undefined };
    const ownUrl = typeof u.baseUrl === 'string' && u.baseUrl.trim() !== '';
    const merged = normalizeSettings({ ...u, trustedKeys: Array.isArray(u.trustedKeys) ? u.trustedKeys : undefined, baseUrl: ownUrl ? u.baseUrl : base.baseUrl }, base);
    const releaseKeys = base.trustedKeys.filter((k) => !merged.trustedKeys.some((x) => x.keyId === k.keyId));
    return { ...merged, trustedKeys: [...merged.trustedKeys, ...releaseKeys] };
  }
  /** Validates a patch; returns what was rejected so the UI can say why. */
  set(patch: Partial<CatalogSettings>): { settings: CatalogSettings; errors: string[] } {
    const errors: string[] = [];
    const next: Record<string, unknown> = { ...this.user() };
    if ('baseUrl' in patch) {
      if (patch.baseUrl === null || patch.baseUrl === '') delete next.baseUrl;       // "no override": back to the release address
      else { const c = checkBaseUrl(patch.baseUrl); if (c.ok) next.baseUrl = patch.baseUrl!.trim(); else errors.push(c.error); }
    }
    if ('trustedKeys' in patch) {
      const keys: TrustedKey[] = [];
      for (const k of patch.trustedKeys ?? []) {
        if (!k || !KEY_ID_RE.test(String(k.keyId ?? ''))) { errors.push('A key id may only contain letters, digits, dot, dash and underscore (max 64).'); continue; }
        if (!parsePublicKey(String(k.publicKey ?? ''))) { errors.push(`The public key for "${k.keyId}" is not a valid Ed25519 key (PEM, or 32 raw bytes in base64).`); continue; }
        if (!keys.some((x) => x.keyId === k.keyId)) keys.push({ keyId: k.keyId, publicKey: k.publicKey.trim() });
      }
      next.trustedKeys = keys;
    }
    if ('allowUnsignedDev' in patch) { if (typeof patch.allowUnsignedDev === 'boolean') next.allowUnsignedDev = patch.allowUnsignedDev; else errors.push('allowUnsignedDev must be true or false.'); }
    if ('autoUpdateExisting' in patch) { if (typeof patch.autoUpdateExisting === 'boolean') next.autoUpdateExisting = patch.autoUpdateExisting; else errors.push('autoUpdateExisting must be true or false.'); }
    if ('autoServers' in patch) { if (Array.isArray(patch.autoServers)) next.autoServers = normalizeSettings({ autoServers: patch.autoServers }).autoServers; else errors.push('autoServers must be a list of server ids.'); }
    if ('installMode' in patch) { if (patch.installMode === 'auto' || patch.installMode === 'review') next.installMode = patch.installMode; else errors.push('Install mode must be "review" or "auto".'); }
    if ('intervalMinutes' in patch) { if (typeof patch.intervalMinutes === 'number' && Number.isFinite(patch.intervalMinutes)) next.intervalMinutes = Math.min(INTERVAL_RANGE[1], Math.max(INTERVAL_RANGE[0], Math.round(patch.intervalMinutes))); else errors.push('The refresh interval must be a number of minutes.'); }
    if ('maxAutoDownloadBytes' in patch) { if (typeof patch.maxAutoDownloadBytes === 'number' && Number.isFinite(patch.maxAutoDownloadBytes) && patch.maxAutoDownloadBytes > 0) next.maxAutoDownloadBytes = Math.min(16 * 1024 ** 3, Math.round(patch.maxAutoDownloadBytes)); else errors.push('The automatic download limit must be a positive number of bytes.'); }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return { settings: this.get(), errors };
  }
  reset() { try { fs.rmSync(this.file, { force: true }); } catch { /* nothing to reset */ } return this.get(); }
}

// ── acceptance policy ─────────────────────────────────────────────────────────
export type RejectCode = 'malformed' | 'schema' | 'signature' | 'unsigned' | 'rollback' | 'conflict' | 'identity' | 'expired' | 'future' | 'environment';
export interface AcceptedRef { catalogId: string; revision: number; sha256: string }
export type EvalResult =
  | { ok: true; catalog: AcCatalog; sha256: string; warnings: string[]; verified: { keyId: string; signedAt: string } | null; unsignedDev: boolean; unchanged: boolean; expired: boolean }
  | { ok: false; code: RejectCode; message: string; details?: string[]; subcode?: string };

const FUTURE_SKEW_MS = 10 * 60 * 1000;

export function evaluateCatalog(input: {
  bytes: Buffer; signature: string | null; settings: CatalogSettings; privateUrl: boolean; prev: AcceptedRef | null; now: Date;
  /** 'cache' = re-checking our own stored copy: no rollback test, and an expired catalog is kept (flagged) instead of rejected. */
  mode?: 'fetch' | 'cache'; resetIdentity?: boolean;
}): EvalResult {
  const { bytes, signature, settings, privateUrl, prev, now } = input;
  const mode = input.mode ?? 'fetch';
  if (bytes.length === 0 || bytes.length > MAX_CATALOG_BYTES) return { ok: false, code: 'malformed', message: bytes.length ? 'The catalog is larger than the allowed size.' : 'The catalog is empty.' };
  let raw: any;
  try { raw = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return { ok: false, code: 'malformed', message: 'The catalog is not valid JSON.' }; }
  const env = raw?.catalog?.environment;

  // environment gate: a development catalog is only ever accepted from a private/loopback address
  if (env === 'development' && !privateUrl) return { ok: false, code: 'environment', message: 'This is a DEVELOPMENT catalog, which is only accepted from a private network address.' };

  // signature
  let verified: { keyId: string; signedAt: string } | null = null; let unsignedDev = false;
  const mayBeUnsigned = settings.allowUnsignedDev && env === 'development' && privateUrl;
  if (signature === null) {
    if (!mayBeUnsigned) return { ok: false, code: 'unsigned', message: settings.trustedKeys.length ? 'The catalog has no signature, so it cannot be trusted.' : 'No signing key is pinned in Mercy Launcher yet, and the catalog has no signature. Ask the server owner for the public key.' };
    unsignedDev = true;
  } else {
    const v = verifyCatalogSignature(bytes, signature, settings.trustedKeys);
    if (!v.ok) {
      if (mayBeUnsigned && (v.code === 'no-keys' || v.code === 'unknown-key')) unsignedDev = true;
      else return { ok: false, code: 'signature', subcode: v.code, message: v.message };
    } else verified = { keyId: v.keyId, signedAt: v.signedAt };
  }

  const vr = validateCatalog(raw);
  if (!vr.ok) return { ok: false, code: 'schema', message: `The catalog failed validation (${vr.errors.length} problem${vr.errors.length === 1 ? '' : 's'}): ${vr.errors[0]}`, details: vr.errors.slice(0, 20) };
  const catalog = vr.catalog;
  const sha256 = sha256Hex(bytes);

  const generated = Date.parse(catalog.catalog.generatedAt);
  if (generated > now.getTime() + FUTURE_SKEW_MS) return { ok: false, code: 'future', message: 'The catalog claims to have been generated in the future — check this computer\'s clock.' };
  const expired = catalog.catalog.expiresAt ? Date.parse(catalog.catalog.expiresAt) <= now.getTime() : false;
  if (expired && mode === 'fetch') return { ok: false, code: 'expired', message: 'The catalog has expired. The server owner needs to publish a fresh one.' };

  let unchanged = false;
  if (mode === 'fetch' && prev && !input.resetIdentity) {
    if (prev.catalogId !== catalog.catalog.id) return { ok: false, code: 'identity', message: `The catalog identity changed from "${prev.catalogId}" to "${catalog.catalog.id}". If this is expected, reset the catalog in Setup.` };
    if (catalog.catalog.revision < prev.revision) return { ok: false, code: 'rollback', message: `The catalog is older (revision ${catalog.catalog.revision}) than the one already accepted (revision ${prev.revision}). It was ignored.` };
    if (catalog.catalog.revision === prev.revision) {
      if (sha256 !== prev.sha256) return { ok: false, code: 'conflict', message: `Two different catalogs claim revision ${prev.revision}. The one already accepted was kept.` };
      unchanged = true;
    }
  }
  return { ok: true, catalog, sha256, warnings: vr.warnings, verified, unsignedDev, unchanged, expired };
}

// ── persistence ───────────────────────────────────────────────────────────────
interface AcceptedState extends AcceptedRef { generatedAt: string; etag: string | null; keyId: string | null; unsignedDev: boolean; acceptedAt: string; environment: 'production' | 'development'; expiresAt: string | null }
interface SyncState {
  sourceKey: string | null; accepted: AcceptedState | null;
  lastAttemptAt: string | null; lastSuccessAt: string | null; failures: number; nextAttemptAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  lastChange: { at: string; summary: string[]; serverIds: string[] } | null;
}
const EMPTY_STATE: SyncState = { sourceKey: null, accepted: null, lastAttemptAt: null, lastSuccessAt: null, failures: 0, nextAttemptAt: null, lastError: null, lastChange: null };

function atomicWrite(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ── status + results ──────────────────────────────────────────────────────────
export interface CatalogStatus {
  configured: boolean; source: 'catalog' | 'builtin'; syncing: boolean;
  environment: 'production' | 'development' | null; catalogId: string | null; revision: number | null;
  generatedAt: string | null; expiresAt: string | null; keyId: string | null; signatureVerified: boolean; unsignedDev: boolean;
  lastSuccessAt: string | null; lastAttemptAt: string | null; nextAttemptAt: string | null; failures: number;
  lastError: { code: string; message: string; at: string } | null;
  stale: boolean; expired: boolean;
  lastChange: { at: string; summary: string[]; serverIds: string[] } | null;
  notices: string[];
  installsAllowed: boolean; installBlockedReason: string | null; autoInstallAllowed: boolean;
}
export type SyncReason = 'startup' | 'section-open' | 'periodic' | 'manual';
export interface SyncResult {
  outcome: 'updated' | 'unchanged' | 'rejected' | 'unavailable' | 'skipped' | 'unconfigured';
  changed: boolean; diff?: CatalogDiff; error?: { code: string; message: string }; skippedBecause?: 'rate-limit' | 'backoff' | 'in-flight' | 'debounced'; revision?: number;
}
export interface CatalogEvent { type: 'status' | 'changed'; status: CatalogStatus; diff?: CatalogDiff }

export const MIN_SECTION_OPEN_GAP_MS = 60_000;
export const MANUAL_DEBOUNCE_MS = 3_000;
export const BACKOFF_FIRST_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

export interface CatalogSyncDeps {
  userDataPath: string;
  settings: { get(): CatalogSettings };
  /** The built-in package, used until (and unless) a catalog has been accepted. */
  builtin: () => AdaptedCatalog;
  boardBase: SrpBundle;
  transport?: Transport;
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: CatalogEvent) => void;
  log?: (line: string) => void;
  /** Tests: replace setTimeout/clearTimeout for the periodic timer. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

export class CatalogSync {
  private dir: string;
  private state: SyncState = { ...EMPTY_STATE };
  private catalog: AcCatalog | null = null;
  private adaptedCache: AdaptedCatalog | null = null;
  private verifiedKeyId: string | null = null;
  private expiredNow = false;
  private inFlight: Promise<SyncResult> | null = null;
  private lastManualAt = 0; private lastManualResult: SyncResult | null = null;
  private timer: unknown = null; private stopped = true;

  constructor(private deps: CatalogSyncDeps) {
    this.dir = path.join(deps.userDataPath, 'ac-catalog');
    this.loadState();
  }

  private now() { return (this.deps.now ?? (() => new Date()))(); }
  private log(line: string) { try { this.deps.log?.(`[catalog] ${line}`); } catch { /* logging must never break a sync */ } }
  private stateFile() { return path.join(this.dir, 'state.json'); }
  private saveState() { try { atomicWrite(this.stateFile(), JSON.stringify(this.state, null, 2)); } catch { /* best effort */ } }
  private sourceKey(settings: CatalogSettings) { const c = checkBaseUrl(settings.baseUrl, settings.paths); return c.ok ? crypto.createHash('sha256').update(c.base).digest('hex').slice(0, 16) : null; }

  private loadState() {
    let s: SyncState = { ...EMPTY_STATE };
    try { s = { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) }; } catch { /* first run */ }
    this.state = s;
    this.loadCache();
  }

  /** Re-verifies the stored copy from scratch (signature included): a tampered cache is discarded, never trusted. */
  private loadCache() {
    this.catalog = null; this.adaptedCache = null; this.verifiedKeyId = null; this.expiredNow = false;
    const settings = this.deps.settings.get();
    const b = checkBaseUrl(settings.baseUrl, settings.paths);
    if (!b.ok || !this.state.accepted || this.state.sourceKey !== this.sourceKey(settings)) return;
    try {
      const bytes = fs.readFileSync(path.join(this.dir, 'catalog.json'));
      let sig: string | null = null; try { sig = fs.readFileSync(path.join(this.dir, 'catalog.json.sig'), 'utf8'); } catch { /* unsigned dev */ }
      const r = evaluateCatalog({ bytes, signature: sig, settings, privateUrl: b.privateHost, prev: null, now: this.now(), mode: 'cache' });
      if (!r.ok || r.sha256 !== this.state.accepted.sha256) { this.log(`cached catalog discarded (${r.ok ? 'hash differs from state' : r.code})`); this.state.accepted = null; this.saveState(); return; }
      this.catalog = r.catalog; this.verifiedKeyId = r.verified?.keyId ?? null; this.expiredNow = r.expired;
      this.adaptedCache = catalogToBundle(r.catalog, this.deps.boardBase);
    } catch { this.state.accepted = null; }
  }

  adapted(): AdaptedCatalog { return this.adaptedCache ?? this.deps.builtin(); }
  currentCatalog(): AcCatalog | null { return this.catalog; }
  usingCatalog(): boolean { return !!this.catalog; }

  status(): CatalogStatus {
    const settings = this.deps.settings.get(); const b = checkBaseUrl(settings.baseUrl, settings.paths);
    const now = this.now().getTime();
    const acc = this.state.accepted;
    const expired = this.catalog?.catalog.expiresAt ? Date.parse(this.catalog.catalog.expiresAt) <= now : false;
    this.expiredNow = expired;
    const lastOk = this.state.lastSuccessAt ? Date.parse(this.state.lastSuccessAt) : 0;
    const stale = b.ok && (!lastOk || now - lastOk > settings.intervalMinutes * 60_000 * 3);
    const dev = this.catalog?.catalog.environment === 'development';
    const signatureVerified = !!this.verifiedKeyId;
    let blocked: string | null = null;
    if (expired) blocked = 'The catalog has expired, so installing is paused until the owner publishes a fresh one.';
    return {
      configured: b.ok, source: this.catalog ? 'catalog' : 'builtin', syncing: !!this.inFlight,
      environment: this.catalog?.catalog.environment ?? null, catalogId: acc?.catalogId ?? null, revision: acc?.revision ?? null,
      generatedAt: acc?.generatedAt ?? null, expiresAt: this.catalog?.catalog.expiresAt ?? null, keyId: this.verifiedKeyId, signatureVerified, unsignedDev: !!acc?.unsignedDev,
      lastSuccessAt: this.state.lastSuccessAt, lastAttemptAt: this.state.lastAttemptAt, nextAttemptAt: this.state.nextAttemptAt, failures: this.state.failures,
      lastError: this.state.lastError, stale, expired, lastChange: this.state.lastChange,
      notices: this.adapted().notices,
      installsAllowed: !blocked, installBlockedReason: blocked,
      autoInstallAllowed: !!this.catalog && signatureVerified && !expired && !dev && settings.installMode === 'auto',
    };
  }

  private emit(type: CatalogEvent['type'], diff?: CatalogDiff) { try { this.deps.onEvent?.({ type, status: this.status(), diff }); } catch { /* listeners must not break sync */ } }

  // ── scheduling ──────────────────────────────────────────────────────────────
  start() { this.stopped = false; this.schedule(); }
  stop() { this.stopped = true; if (this.timer) (this.deps.timers?.clear ?? clearTimeout as (h: unknown) => void)(this.timer); this.timer = null; }
  private schedule() {
    if (this.stopped) return;
    if (this.timer) (this.deps.timers?.clear ?? clearTimeout as (h: unknown) => void)(this.timer);
    const settings = this.deps.settings.get();
    const next = this.state.nextAttemptAt ? Date.parse(this.state.nextAttemptAt) : this.now().getTime() + settings.intervalMinutes * 60_000;
    const delay = Math.max(30_000, next - this.now().getTime());
    const h = (this.deps.timers?.set ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as NodeJS.Timeout).unref?.(); return t; }))(() => { void this.refresh('periodic').catch(() => undefined); }, delay);
    this.timer = h;
  }
  private backoffMs(n: number) { const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, n - 1)); const j = 0.8 + 0.4 * (this.deps.random ?? Math.random)(); return Math.min(BACKOFF_MAX_MS, Math.round(base * j)); }

  // ── refresh ─────────────────────────────────────────────────────────────────
  refresh(reason: SyncReason): Promise<SyncResult> {
    const settings = this.deps.settings.get();
    const b = checkBaseUrl(settings.baseUrl, settings.paths);
    if (!b.ok) return Promise.resolve({ outcome: 'unconfigured', changed: false, error: { code: 'unconfigured', message: b.error } });
    const nowMs = this.now().getTime();
    if (this.inFlight) return this.inFlight;
    if (reason === 'manual') {
      if (this.lastManualResult && nowMs - this.lastManualAt < MANUAL_DEBOUNCE_MS) return Promise.resolve({ ...this.lastManualResult, skippedBecause: 'debounced' });
    } else {
      const lastAttempt = this.state.lastAttemptAt ? Date.parse(this.state.lastAttemptAt) : 0;
      const nextAt = this.state.nextAttemptAt ? Date.parse(this.state.nextAttemptAt) : 0;
      if (reason === 'section-open' && lastAttempt && nowMs - lastAttempt < MIN_SECTION_OPEN_GAP_MS) return Promise.resolve({ outcome: 'skipped', changed: false, skippedBecause: 'rate-limit' });
      if ((reason === 'periodic' || reason === 'section-open') && nextAt && nowMs < nextAt && this.state.failures > 0) return Promise.resolve({ outcome: 'skipped', changed: false, skippedBecause: 'backoff' });
      if (reason === 'periodic' && nextAt && nowMs < nextAt) { this.schedule(); return Promise.resolve({ outcome: 'skipped', changed: false, skippedBecause: 'rate-limit' }); }
    }
    this.inFlight = this.run(reason, settings, b).then((r) => { if (reason === 'manual') { this.lastManualAt = this.now().getTime(); this.lastManualResult = r; } return r; })
      .finally(() => { this.inFlight = null; this.schedule(); this.emit('status'); });
    this.emit('status');
    return this.inFlight;
  }

  private fail(code: string, message: string, retryable = true): SyncResult {
    const now = this.now();
    this.state.failures += 1;
    this.state.lastError = { code, message, at: now.toISOString() };
    this.state.nextAttemptAt = new Date(now.getTime() + this.backoffMs(this.state.failures)).toISOString();
    this.saveState();
    this.log(`sync failed: ${code}${retryable ? '' : ' (not retryable)'}`);
    return { outcome: ['network', 'timeout', 'http', 'too-large', 'redirect', 'cancelled'].includes(code) ? 'unavailable' : 'rejected', changed: false, error: { code, message } };
  }

  private async run(reason: SyncReason, settings: CatalogSettings, b: Extract<ReturnType<typeof checkBaseUrl>, { ok: true }>): Promise<SyncResult> {
    const now = this.now();
    // a different catalog address starts from a clean slate (rollback protection is per source)
    const key = this.sourceKey(settings);
    if (this.state.sourceKey !== key) { this.state = { ...EMPTY_STATE, sourceKey: key }; this.catalog = null; this.adaptedCache = null; this.verifiedKeyId = null; try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    this.state.lastAttemptAt = now.toISOString();
    const prevRef: AcceptedRef | null = this.state.accepted ? { catalogId: this.state.accepted.catalogId, revision: this.state.accepted.revision, sha256: this.state.accepted.sha256 } : null;

    let first: FetchOutcome = await fetchCatalogFiles(b, { etag: this.catalog ? this.state.accepted?.etag : null, transport: this.deps.transport });
    if (first.kind === 'not-modified' && this.catalog) {
      this.state.failures = 0; this.state.lastError = null; this.state.lastSuccessAt = now.toISOString();
      this.state.nextAttemptAt = new Date(now.getTime() + settings.intervalMinutes * 60_000).toISOString(); this.saveState();
      this.log(`sync ok (${reason}): not modified`);
      return { outcome: 'unchanged', changed: false, revision: this.state.accepted?.revision };
    }
    if (first.kind === 'not-modified') first = await fetchCatalogFiles(b, { etag: null, transport: this.deps.transport });
    if (first.kind === 'error') return this.fail(first.code, first.message, first.retryable);
    if (first.kind !== 'fetched') return this.fail('http', 'The catalog server sent an unexpected response.', true);
    let fetched: Fetched = first;

    const evalOnce = (f: Fetched) => evaluateCatalog({ bytes: f.catalogBytes, signature: f.signature, settings, privateUrl: b.privateHost, prev: prevRef, now: this.now(), mode: 'fetch' });
    let ev = evalOnce(fetched);
    // The two files are published separately: a mismatch right after a publish is usually a half-finished swap, so look once more.
    if (!ev.ok && ev.code === 'signature' && ev.subcode === 'hash-mismatch') {
      await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1500);
      const again = await fetchCatalogFiles(b, { etag: null, transport: this.deps.transport });
      if (again.kind === 'fetched') { fetched = again; ev = evalOnce(again); }
    }
    if (!ev.ok) { this.log(`catalog rejected: ${ev.code}`); return this.fail(ev.code, ev.message, false); }

    this.state.failures = 0; this.state.lastError = null; this.state.lastSuccessAt = now.toISOString();
    this.state.nextAttemptAt = new Date(now.getTime() + settings.intervalMinutes * 60_000).toISOString();
    if (ev.unchanged) {
      if (this.state.accepted) this.state.accepted.etag = fetched.etag ?? this.state.accepted.etag;
      this.saveState(); this.log(`sync ok (${reason}): unchanged revision ${ev.catalog.catalog.revision}`);
      return { outcome: 'unchanged', changed: false, revision: ev.catalog.catalog.revision };
    }

    const diff = diffCatalogs(this.catalog, ev.catalog);
    try {
      atomicWrite(path.join(this.dir, 'catalog.json'), fetched.catalogBytes);
      if (fetched.signature !== null) atomicWrite(path.join(this.dir, 'catalog.json.sig'), fetched.signature); else fs.rmSync(path.join(this.dir, 'catalog.json.sig'), { force: true });
    } catch (e) { return this.fail('cache', `Could not save the catalog (${(e as Error).message}).`, true); }
    this.state.sourceKey = key;
    this.state.accepted = { catalogId: ev.catalog.catalog.id, revision: ev.catalog.catalog.revision, sha256: ev.sha256, generatedAt: ev.catalog.catalog.generatedAt, etag: fetched.etag, keyId: ev.verified?.keyId ?? null, unsignedDev: ev.unsignedDev, acceptedAt: now.toISOString(), environment: ev.catalog.catalog.environment, expiresAt: ev.catalog.catalog.expiresAt ?? null };
    this.catalog = ev.catalog; this.verifiedKeyId = ev.verified?.keyId ?? null; this.expiredNow = ev.expired;
    this.adaptedCache = catalogToBundle(ev.catalog, this.deps.boardBase);
    if (diff.changed && !diff.firstSync) this.state.lastChange = { at: now.toISOString(), summary: diff.summary, serverIds: diff.serverIds };
    else if (diff.firstSync) this.state.lastChange = { at: now.toISOString(), summary: diff.summary, serverIds: diff.serverIds };
    this.saveState();
    this.log(`sync ok (${reason}): accepted revision ${ev.catalog.catalog.revision}${diff.changed ? ` (${diff.changes.length} change(s))` : ''}`);
    this.emit('changed', diff);
    return { outcome: 'updated', changed: diff.changed, diff, revision: ev.catalog.catalog.revision };
  }

  /** Forget the accepted catalog, the cache and rollback history (Setup → Reset). Never touches game files. */
  reset() {
    this.stop(); this.state = { ...EMPTY_STATE }; this.catalog = null; this.adaptedCache = null; this.verifiedKeyId = null;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.emit('status');
  }
  /** Settings changed (address / keys): re-evaluate the stored copy against them. */
  settingsChanged() { this.loadCache(); this.emit('status'); }
}

export function releaseEndpointsFromBuiltin(r: ReleaseEndpointsFile): ReleaseEndpointsFile { return r; }
