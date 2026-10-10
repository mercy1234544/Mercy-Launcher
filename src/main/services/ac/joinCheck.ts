// "Can I join this server right now?" — answered from facts, never from hope. Pure: the service gathers the facts
// (endpoint, the server's own status page, a TCP test of the game port, the local install check, Content Manager),
// this turns them into ONE of three states plus the exact reasons:
//
//   unavailable — no usable address, or the server / its game port does not answer from this PC
//   missing     — the server is reachable but something is missing here (game, Content Manager, CSP, cars, track)
//   ready       — everything the launcher CAN check is in order
//
// "ready" still never means "the connection will succeed": UDP cannot be tested and a real join has not been observed.
// Connection problems are listed first and take priority — files on disk never make an unreachable server "ready".
import type { ContentRow, ContentStatus } from './contentStatus';
import type { ResolvedEndpoints, AcEndpoint } from './endpoints';
import type { ServerInfoResult } from './serverInfo';

export type JoinState = 'ready' | 'missing' | 'unavailable';
export type FixKind = 'install' | 'manual' | 'setup' | 'adopt-host' | 'retry';
export interface JoinIssue {
  id: string;
  kind: 'connection' | 'game' | 'content-manager' | 'csp' | 'content';
  /** blocker = stops joining; note = worth knowing, does not stop it. */
  severity: 'blocker' | 'note';
  title: string;
  detail: string;
  fix?: { kind: FixKind; label: string; planItemIds?: string[] };
}
export interface MissingItem { id: string; name: string; state: ContentRow['state']; detail: string; installable: boolean; planItemId?: string; required: boolean }
export interface JoinConnection {
  configured: boolean;
  scope: 'lan' | 'public' | null;
  /** True when the server has a usable address but NO public one is configured: only reachable from the owner's own network. */
  lanOnly: boolean;
  /** Did the server's own status page answer just now? null = not asked (no address). */
  infoOnline: boolean | null;
  identity: 'match' | 'mismatch' | 'unknown';
  gamePortTcp: 'open' | 'closed' | 'untested';
  players?: number;
  maxPlayers?: number;
  /** The track the server itself reports; compared with the catalog only as a note. */
  serverTrack?: string;
  reason: string;
}
export interface JoinCheck {
  serverId: string;
  state: JoinState;
  headline: string;
  checkedAt: string;
  connection: JoinConnection;
  issues: JoinIssue[];
  missing: MissingItem[];
  canJoin: boolean;
  /** Always true: the launcher cannot observe the game connecting. */
  unverified: true;
  /** A one-click, verified way to use the catalog's own (private) host as this PC's LAN address is available. */
  canAdoptHost: boolean;
}

export interface JoinCheckInput {
  serverId: string;
  serverName: string;
  /** The catalog / package says this server runs this track-layout (for the note only). */
  expectedTrack?: { trackId: string; layout: string };
  content: ContentStatus;
  endpoints: ResolvedEndpoints;
  /** Which endpoint the launcher would use (LAN preferred when it answers) — null when none is configured. */
  chosen: AcEndpoint | null;
  chosenReason: string;
  info: ServerInfoResult | null;
  tcp: { ok: boolean; code?: string } | null;
  contentManager: { available: boolean; exePath: string | null; exeExists: boolean | null };
  /** Where the missing address would have to come from. */
  source: 'catalog' | 'builtin';
  catalogHostIsPrivate: boolean;
  /** The catalog entry has ports (needed to reach it at all). */
  portsKnown: boolean;
  now?: () => Date;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The server's own name (AssettoServer appends extra text) must start with the name the catalog gave it. */
export function identityMatches(infoName: string | undefined, expected: string): 'match' | 'mismatch' | 'unknown' {
  if (!infoName) return 'unknown';
  const a = norm(infoName), b = norm(expected);
  if (!a || !b) return 'unknown';
  return a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ') ? 'match' : 'mismatch';
}

export function buildJoinCheck(i: JoinCheckInput): JoinCheck {
  const issues: JoinIssue[] = [];
  const ep = i.chosen;
  const conn: JoinConnection = { configured: !!ep, scope: ep?.scope ?? null, lanOnly: !!ep && !i.endpoints.public, infoOnline: null, identity: 'unknown', gamePortTcp: 'untested', reason: i.chosenReason };
  const canAdoptHost = !ep && i.catalogHostIsPrivate && i.portsKnown;

  // ── 1. connection ────────────────────────────────────────────────────────────
  if (!ep) {
    const where = i.source === 'catalog'
      ? (i.portsKnown
        ? 'The server catalog lists no public address for this server (its "connection.public" is empty), so there is nothing to connect to yet.'
        : 'The server catalog lists neither a public address nor the server\'s ports (it has no "connection.public" and no "connection.ports"), so there is nothing to connect to yet.')
      : 'The list built into this version of Mercy Launcher has no public address for this server.';
    issues.push({
      id: 'no-endpoint', kind: 'connection', severity: 'blocker', title: 'No server address yet',
      detail: `${where} The server owner must set a public host name for it${i.source === 'catalog' ? ' in the catalog (connection.public.host, with its game and HTTP ports)' : ''}. Until then it can only be reached from the owner's own network.`,
      fix: canAdoptHost ? { kind: 'adopt-host', label: 'Connect over my home network' } : { kind: 'setup', label: 'Enter a server address' },
    });
  } else {
    // the server's own status page
    const info = i.info;
    conn.infoOnline = !!info?.online;
    if (info?.online) { conn.players = info.players; conn.maxPlayers = info.maxPlayers; conn.serverTrack = info.track; conn.identity = identityMatches(info.name, i.serverName); }
    if (!info || !info.online) {
      issues.push({ id: 'server-offline', kind: 'connection', severity: 'blocker', title: 'The server is not answering',
        detail: `Its status page did not answer from this PC (${info?.reason ?? 'no reply'}). The server may be down, or this PC cannot reach it (network or firewall).`, fix: { kind: 'retry', label: 'Check again' } });
    } else if (conn.identity === 'mismatch') {
      issues.push({ id: 'wrong-server', kind: 'connection', severity: 'blocker', title: 'That address is a different server',
        detail: `The address answered as "${info.name}", not "${i.serverName}". Joining it would put you on the wrong server, so it is blocked. Check the server address.`, fix: { kind: 'setup', label: 'Check the address' } });
    }
    // the game port
    if (i.tcp) {
      conn.gamePortTcp = i.tcp.ok ? 'open' : 'closed';
      if (!i.tcp.ok && info?.online) {
        issues.push({ id: 'game-port-closed', kind: 'connection', severity: 'blocker', title: `The game port (${ep.tcpPort}) is not reachable`,
          detail: i.tcp.code === 'ECONNREFUSED'
            ? `The machine answered, but nothing accepts connections on game port ${ep.tcpPort}. The game server may be restarting or misconfigured.`
            : `The server's status page answers, but its game port ${ep.tcpPort} (TCP) does not (${i.tcp.code === 'ETIMEDOUT' ? 'no reply — usually a firewall dropping it' : i.tcp.code ?? 'no reply'}). The server owner must allow ${ep.tcpPort} (TCP and UDP) through the server's firewall.`, fix: { kind: 'retry', label: 'Check again' } });
      } else if (!i.tcp.ok && !info?.online) { /* the offline message already explains it */ }
    }
    if (info?.online && conn.identity !== 'mismatch') {
      const exp = i.expectedTrack;
      const reported = (info.track ?? '').toLowerCase();
      if (exp && reported && reported !== `${exp.trackId}-${exp.layout}`.toLowerCase() && reported !== exp.trackId.toLowerCase()) {
        issues.push({ id: 'track-differs', kind: 'connection', severity: 'note', title: 'The server reports a different track than the catalog',
          detail: `The server says it is running "${info.track}" but the catalog expects "${exp.trackId}-${exp.layout}". The requirements below follow the catalog, so you may need different content.` });
      }
    }
  }

  // ── 2. this PC: game, Content Manager, CSP, content ──────────────────────────
  const rows = i.content.rows;
  const game = rows.find((r) => r.kind === 'game');
  if (!game || game.state !== 'installed') {
    issues.push({ id: 'game', kind: 'game', severity: 'blocker', title: 'Assetto Corsa was not found', detail: game?.detail ?? 'Assetto Corsa was not found on this PC.', fix: { kind: 'setup', label: 'Set the game folder' } });
  }
  const cm = i.contentManager;
  if (!cm.available) {
    issues.push({ id: 'content-manager', kind: 'content-manager', severity: 'blocker', title: 'Content Manager is required', detail: 'Joining is launched through Content Manager, and it is not installed or not registered on this PC. Install Content Manager (from its official site), run it once, then check again.', fix: { kind: 'manual', label: 'Install Content Manager' } });
  } else if (cm.exePath && cm.exeExists === false) {
    issues.push({ id: 'content-manager-path', kind: 'content-manager', severity: 'blocker', title: 'Content Manager has moved', detail: 'Windows still points at a Content Manager file that no longer exists. Start Content Manager once from where it is now so it re-registers itself, then check again.', fix: { kind: 'retry', label: 'Check again' } });
  }
  for (const r of rows.filter((x) => x.kind === 'csp')) {
    if (r.required && r.state !== 'installed' && r.state !== 'unknown') {
      issues.push({ id: `csp:${r.id}`, kind: 'csp', severity: 'blocker', title: r.id === 'csp-version' ? 'Custom Shaders Patch is too old' : 'Custom Shaders Patch is missing', detail: `${r.detail} Mercy Launcher never installs or updates it — do it in Content Manager, then check again.`, fix: { kind: 'manual', label: 'Update Custom Shaders Patch' } });
    }
  }
  const missing: MissingItem[] = rows
    .filter((r) => (r.kind === 'car' || r.kind === 'track' || r.kind === 'layout') && r.state !== 'installed' && r.state !== 'unknown')
    .map((r) => ({ id: r.id, name: r.name, state: r.state, detail: r.detail, installable: !!r.planItemId && !r.blocked && r.state !== 'manual' && (r.action === 'install' || r.action === 'update' || r.action === 'repair'), planItemId: r.planItemId, required: r.required }));
  const blockingMissing = missing.filter((m) => m.required);
  if (blockingMissing.length) {
    const installable = blockingMissing.filter((m) => m.installable && m.planItemId);
    issues.push({
      id: 'content', kind: 'content', severity: 'blocker',
      title: `${blockingMissing.length} required item${blockingMissing.length === 1 ? ' is' : 's are'} missing or out of date`,
      detail: blockingMissing.slice(0, 4).map((m) => m.name).join(', ') + (blockingMissing.length > 4 ? ` and ${blockingMissing.length - 4} more` : '') + '.',
      fix: installable.length ? { kind: 'install', label: 'Get what is missing', planItemIds: installable.map((m) => m.planItemId!) } : { kind: 'manual', label: 'See how to get them' },
    });
  }

  const blockers = issues.filter((x) => x.severity === 'blocker');
  const connectionBlocked = blockers.some((x) => x.kind === 'connection');
  const state: JoinState = connectionBlocked ? 'unavailable' : blockers.length ? 'missing' : 'ready';
  const headline = state === 'ready' ? 'Ready to Join' : state === 'unavailable' ? 'Connection Unavailable' : 'Missing Content';
  const now = (i.now ?? (() => new Date()))();
  return {
    serverId: i.serverId, state, headline, checkedAt: now.toISOString(), connection: conn,
    issues: [...blockers.sort((a, b) => order(a.kind) - order(b.kind)), ...issues.filter((x) => x.severity === 'note')],
    missing, canJoin: state === 'ready', unverified: true, canAdoptHost,
  };
}
const order = (k: JoinIssue['kind']) => ({ connection: 0, game: 1, 'content-manager': 2, csp: 3, content: 4 }[k]);
