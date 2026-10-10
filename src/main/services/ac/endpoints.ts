// Endpoint handling for Mercy's Servers — LAN for the owner, public for everyone else.
//
// Rules (from the owner's ENDPOINTS_LAN_AND_PUBLIC.md design + this task's brief):
//  * RELEASE data (endpoints.public.json, shipped in the app) may only ever hold PUBLIC endpoints, and
//    today holds none (host: null = PUBLIC_HOST_TBD). Nothing is invented or hardcoded here.
//  * A LAN address is a LOCAL, per-machine setting typed into the launcher and stored in userData.
//    It is never written to release data, logs (redacted), or the relay.
//  * The SRP Board companion app is stamped ON THE PLAYER'S PC at install time. A public player's
//    stamp therefore never contains the owner's LAN address.
//  * What CSP's ac.getServerIP() returns for a hostname join is UNPROVEN (see the package's
//    OPEN_ISSUES.md). Until proven, the stamp holds the hostname AND every IPv4 it resolves to.
//  * Nothing here claims public connectivity works — it only reports what is configured.
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import { classifyHost } from '../AcRequirementsChecker';
import type { SrpServerRequirements } from '../AcRequirementsChecker';
import { SRP_BOARD_TEMPLATE_B64 } from './srpBoardTemplate';

export type EndpointScope = 'lan' | 'public';
export interface AcEndpoint { scope: EndpointScope; host: string; tcpPort: number; httpPort: number }

/** Per-machine, per-server settings (userData/ac-endpoints.json). Never shipped. */
export interface LocalEndpointSettings {
  lanHost: string | null;
  publicHostOverride: string | null;
  publicTcpPortOverride: number | null;
  publicHttpPortOverride: number | null;
}
export interface ReleaseEndpointsFile {
  servers: Record<string, { host: string | null; tcpPort: number | null; httpPort: number | null }>;
}

export interface ResolvedEndpoints {
  serverId: string;
  lan: AcEndpoint | null;
  public: AcEndpoint | null;
  publicSource: 'release' | 'local-override' | 'none';
  /** Human-readable, actionable. Empty when everything needed is configured. */
  problems: string[];
}

export const EMPTY_LOCAL: LocalEndpointSettings = { lanHost: null, publicHostOverride: null, publicTcpPortOverride: null, publicHttpPortOverride: null };

const HOST_RE = /^[A-Za-z0-9.\-]{1,253}$/;
const SERVER_ENTRY_RE = /^[A-Za-z0-9.\-]{1,253}:\d{1,5}$/;
const validPort = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535;

export function validateHost(raw: string, scope: EndpointScope): { ok: true; host: string } | { ok: false; error: string } {
  const host = (raw ?? '').trim().toLowerCase();
  if (!host) return { ok: false, error: 'Enter a host name or IP address.' };
  if (!HOST_RE.test(host)) return { ok: false, error: 'Host may contain only letters, digits, dots and hyphens (no port, scheme or spaces).' };
  const kind = classifyHost(host);
  if (scope === 'public' && (kind === 'private-lan' || kind === 'loopback')) {
    return { ok: false, error: 'A public endpoint cannot be a private or loopback address. Enter your public host name; use the LAN field for a private address.' };
  }
  if (scope === 'lan' && kind === 'public-ip') {
    return { ok: false, error: 'That looks like a public IP. Put it in the public endpoint field; the LAN field is for a private address or local host name.' };
  }
  return { ok: true, host };
}

/** Combine release data + local settings + the server's own ports into the endpoints this machine would use. */
export function resolveEndpoints(server: SrpServerRequirements, release: ReleaseEndpointsFile, local: LocalEndpointSettings = EMPTY_LOCAL): ResolvedEndpoints {
  const id = server.server.id;
  const tcp = server.server.game?.tcpPort ?? server.server.connection?.publicPort ?? 0;
  const http = server.server.game?.httpPort ?? 0;
  const problems: string[] = [];
  const rel = release.servers[id];

  let pub: AcEndpoint | null = null;
  let publicSource: ResolvedEndpoints['publicSource'] = 'none';
  const relHost = rel?.host ? validateHost(rel.host, 'public') : null;
  const ovHost = local.publicHostOverride ? validateHost(local.publicHostOverride, 'public') : null;
  if (ovHost && ovHost.ok) {
    pub = { scope: 'public', host: ovHost.host, tcpPort: local.publicTcpPortOverride ?? rel?.tcpPort ?? tcp, httpPort: local.publicHttpPortOverride ?? rel?.httpPort ?? http };
    publicSource = 'local-override';
  } else if (relHost && relHost.ok) {
    pub = { scope: 'public', host: relHost.host, tcpPort: rel!.tcpPort ?? tcp, httpPort: rel!.httpPort ?? http };
    publicSource = 'release';
  }
  if (ovHost && !ovHost.ok) problems.push(`Public endpoint override is invalid: ${ovHost.error}`);
  if (relHost && !relHost.ok) problems.push(`Release public endpoint is invalid: ${relHost.error}`);
  if (!pub) problems.push('No public endpoint is configured for this server yet (PUBLIC_HOST_TBD). Remote players cannot be pointed at it until the owner assigns a public host name.');
  if (pub && (!validPort(pub.tcpPort) || !validPort(pub.httpPort))) { problems.push('The configured public ports are not valid (1–65535).'); pub = null; publicSource = 'none'; }

  let lan: AcEndpoint | null = null;
  if (local.lanHost) {
    const v = validateHost(local.lanHost, 'lan');
    if (v.ok && validPort(tcp) && validPort(http)) lan = { scope: 'lan', host: v.host, tcpPort: tcp, httpPort: http };
    else if (!v.ok) problems.push(`LAN address is invalid: ${v.error}`);
  }
  return { serverId: id, lan, public: pub, publicSource, problems };
}

// ── SRP Board stamping (same rule + validation as the package's stamp-srp-board.js) ──────────────

/** Stamp the inert template's `local SERVERS = { }` line. Throws on a bad or empty list. */
export function stampLua(luaSource: string, servers: string[]): string {
  if (!servers.length) throw new Error('At least one server entry is required (an unstamped SRP Board is inert).');
  for (const s of servers) {
    const port = +s.split(':').pop()!;
    if (!SERVER_ENTRY_RE.test(s) || port < 1 || port > 65535) throw new Error(`Bad server entry (expected host:port): "${s}"`);
  }
  if (!/^local SERVERS = \{ \}/m.test(luaSource)) throw new Error('Template SERVERS line "local SERVERS = { }" not found (already stamped or edited?).');
  return luaSource.replace(/^local SERVERS = \{ \}/m, `local SERVERS = { ${servers.map((s) => `'${s.toLowerCase()}'`).join(', ')} }`);
}

export type StampOrigin = 'public-host' | 'public-resolved-ip' | 'lan';
export interface StampPlan {
  /** What goes into the file (internal — never logged or sent anywhere). */
  entries: string[];
  /** Safe-to-show description: origin + kind + port, no addresses. */
  described: { origin: StampOrigin; kind: string; port: number }[];
  warnings: string[];
}

export type Resolver = (host: string) => Promise<string[]>;
export const defaultResolver: Resolver = async (host) => {
  const r = await dns.promises.lookup(host, { all: true, family: 4 });
  return r.map((x) => x.address);
};

/**
 * Entries to stamp for one server on THIS machine.
 *  - public host name, plus every IPv4 it resolves to (what ac.getServerIP() reports is unproven)
 *  - the local LAN address, only if this machine has one configured (i.e. it is the owner's machine)
 */
export async function planStamp(resolved: ResolvedEndpoints, resolve: Resolver = defaultResolver): Promise<StampPlan> {
  const entries: string[] = []; const described: StampPlan['described'] = []; const warnings: string[] = [];
  const add = (host: string, port: number, origin: StampOrigin) => {
    const e = `${host.toLowerCase()}:${port}`;
    if (entries.includes(e)) return;
    entries.push(e); described.push({ origin, kind: classifyHost(host), port });
  };
  if (resolved.public) {
    add(resolved.public.host, resolved.public.tcpPort, 'public-host');
    if (classifyHost(resolved.public.host) === 'hostname') {
      try {
        const ips = await resolve(resolved.public.host);
        if (!ips.length) warnings.push('The public host name resolved to no IPv4 address; only the name was stamped.');
        for (const ip of ips) add(ip, resolved.public.tcpPort, 'public-resolved-ip');
      } catch {
        warnings.push('The public host name could not be resolved right now; only the name was stamped. Re-run this when you are online so the resolved address is stamped too.');
      }
    }
  }
  if (resolved.lan) add(resolved.lan.host, resolved.lan.tcpPort, 'lan');
  if (!entries.length) warnings.push('Nothing to stamp: no public endpoint and no LAN address is configured, so the SRP Board would do nothing.');
  return { entries, described, warnings };
}

/** The three files of the SRP Board app, stamped. */
export function buildSrpBoardFiles(entries: string[]): Record<'manifest.ini' | 'srp_board.lua' | 'icon.png', Buffer> {
  const lua = Buffer.from(SRP_BOARD_TEMPLATE_B64['srp_board.lua'], 'base64').toString('latin1');
  return {
    'manifest.ini': Buffer.from(SRP_BOARD_TEMPLATE_B64['manifest.ini'], 'base64'),
    'srp_board.lua': Buffer.from(stampLua(lua, entries), 'latin1'),
    'icon.png': Buffer.from(SRP_BOARD_TEMPLATE_B64['icon.png'], 'base64'),
  };
}

/** Does the stamp on disk cover the endpoint(s) this machine will actually join? (pure; kinds only in the result) */
export function stampCoversEndpoints(stamped: string[], target: AcEndpoint[]): { covered: boolean; missing: { scope: EndpointScope; port: number }[] } {
  const have = new Set(stamped.map((s) => s.toLowerCase()));
  const missing = target.filter((t) => !have.has(`${t.host.toLowerCase()}:${t.tcpPort}`)).map((t) => ({ scope: t.scope, port: t.tcpPort }));
  return { covered: missing.length === 0, missing };
}

// ── Joining ──────────────────────────────────────────────────────────────────

export interface JoinDecision {
  endpoint: AcEndpoint | null;
  /** Why this endpoint, or exactly what is missing. */
  reason: string;
}

/** Prefer the LAN endpoint when it is reachable (hairpin NAT is not guaranteed); otherwise the public one. */
export function chooseJoinEndpoint(resolved: ResolvedEndpoints, lanReachable: boolean | null): JoinDecision {
  if (resolved.lan && lanReachable === true) return { endpoint: resolved.lan, reason: 'Your LAN address answered, so the local connection is used.' };
  if (resolved.public) return { endpoint: resolved.public, reason: resolved.lan && lanReachable === false ? 'Your LAN address did not answer, so the public address is used.' : 'Using the public address.' };
  if (resolved.lan) return { endpoint: resolved.lan, reason: lanReachable === false ? 'Only a LAN address is configured and it is not answering right now.' : 'Only a LAN address is configured (no public endpoint yet).' };
  return { endpoint: null, reason: 'No endpoint is configured. The owner must assign a public host name (PUBLIC_HOST_TBD) before remote players can join.' };
}

/** Content Manager's online-join link. The format is the documented acmanager:// scheme but has NOT been verified end-to-end here. */
export function buildJoinUrl(ep: AcEndpoint): string {
  return `acmanager://race/online/join?ip=${encodeURIComponent(ep.host)}&httpPort=${ep.httpPort}`;
}

// ── Diagnostics: redaction ───────────────────────────────────────────────────

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Replace every IPv4 and any configured host name so a log line can be shown or saved without leaking addresses. */
export function redactForLog(text: string, hosts: (string | null | undefined)[] = []): string {
  let out = text;
  for (const h of hosts) if (h && h.length >= 3) out = out.split(h).join('[host]').split(h.toUpperCase()).join('[host]');
  return out.replace(IPV4_RE, (m) => {
    const k = classifyHost(m);
    return k === 'private-lan' ? '[lan-ip]' : k === 'loopback' ? '[loopback]' : '[ip]';
  });
}

// ── Local settings persistence (userData — never the app bundle) ─────────────

export class LocalEndpointStore {
  private file: string;
  private data: Record<string, LocalEndpointSettings> = {};
  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, 'ac-endpoints.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }
  get(serverId: string): LocalEndpointSettings { return { ...EMPTY_LOCAL, ...(this.data[serverId] ?? {}) }; }
  set(serverId: string, patch: Partial<LocalEndpointSettings>): { success: true } | { success: false; error: string } {
    const next = { ...this.get(serverId), ...patch };
    if (next.lanHost) { const v = validateHost(next.lanHost, 'lan'); if (!v.ok) return { success: false, error: v.error }; next.lanHost = v.host; }
    if (next.publicHostOverride) { const v = validateHost(next.publicHostOverride, 'public'); if (!v.ok) return { success: false, error: v.error }; next.publicHostOverride = v.host; }
    for (const k of ['publicTcpPortOverride', 'publicHttpPortOverride'] as const) {
      if (next[k] !== null && !validPort(next[k])) return { success: false, error: 'Ports must be whole numbers from 1 to 65535.' };
    }
    this.data[serverId] = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return { success: true };
  }
}
