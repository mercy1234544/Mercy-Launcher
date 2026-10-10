// "Test connection" for a configured endpoint. Read-only network probes from THIS computer to the server the
// player/owner configured — nothing is started, stopped or changed on any server, and no dashboard is touched.
//
// What it can and cannot prove (stated in the result so nobody over-trusts it):
//   * DNS: does the public host name resolve, and to something that is not a private address?
//   * Game TCP port: does anything accept a connection on it from here?
//   * HTTP status port: does the server's /INFO answer?
//   * It CANNOT test the game's UDP port — UDP has no handshake to probe. Only a real join proves UDP works.
// Output never contains an address; only counts, kinds and port numbers.
import * as dns from 'dns';
import * as net from 'net';
import { classifyHost } from '../AcRequirementsChecker';
import type { AcEndpoint } from './endpoints';
import { probeServerInfo, type ServerInfoResult } from './serverInfo';

export type CheckState = 'pass' | 'fail' | 'warn' | 'skipped' | 'info';
export interface EndpointCheck { id: 'dns' | 'game-tcp' | 'http' | 'udp'; label: string; state: CheckState; detail: string }
export interface EndpointDiagnosis { scope: 'lan' | 'public'; checks: EndpointCheck[]; hints: string[]; reachable: boolean }

export interface DiagnoseDeps {
  lookup?: (host: string) => Promise<string[]>;
  tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<{ ok: boolean; code?: string }>;
  httpProbe?: (host: string, port: number, timeoutMs: number) => Promise<ServerInfoResult>;
  timeoutMs?: number;
}

export const defaultLookup = async (host: string) => (await dns.promises.lookup(host, { all: true, family: 4 })).map((r) => r.address);
export const defaultTcpProbe = (host: string, port: number, timeoutMs: number) => new Promise<{ ok: boolean; code?: string }>((resolve) => {
  const s = net.connect({ host, port });
  const done = (r: { ok: boolean; code?: string }) => { s.destroy(); resolve(r); };
  s.setTimeout(timeoutMs, () => done({ ok: false, code: 'ETIMEDOUT' }));
  s.once('connect', () => done({ ok: true }));
  s.once('error', (e: NodeJS.ErrnoException) => done({ ok: false, code: e.code ?? 'ERROR' }));
});

export async function diagnoseEndpoint(ep: AcEndpoint, deps: DiagnoseDeps = {}): Promise<EndpointDiagnosis> {
  const timeout = deps.timeoutMs ?? 3000;
  const lookup = deps.lookup ?? defaultLookup;
  const tcp = deps.tcpProbe ?? defaultTcpProbe;
  const http = deps.httpProbe ?? probeServerInfo;
  const checks: EndpointCheck[] = []; const hints: string[] = [];
  const kind = classifyHost(ep.host);

  // DNS
  let resolved = true;
  if (kind === 'hostname') {
    try {
      const ips = await lookup(ep.host);
      if (!ips.length) { resolved = false; checks.push({ id: 'dns', label: 'Host name resolves', state: 'fail', detail: 'The name resolved to no IPv4 address.' }); hints.push('Create an "A" record for the host name that points at your home\'s public IP address, then wait for DNS to update (up to a few minutes, sometimes longer).'); }
      else {
        const priv = ips.filter((i) => ['private-lan', 'loopback'].includes(classifyHost(i))).length;
        if (ep.scope === 'public' && priv > 0) { checks.push({ id: 'dns', label: 'Host name resolves', state: 'warn', detail: `Resolves to ${ips.length} address${ips.length === 1 ? '' : 'es'}, ${priv} of them private/loopback — a public name should point at your public IP.` }); hints.push('The public host name points at a private address. Remote players cannot reach that; point the DNS record at your public IP (or, if you only use a hosts-file or local DNS entry on this PC, fix that).'); }
        else checks.push({ id: 'dns', label: 'Host name resolves', state: 'pass', detail: `Resolves to ${ips.length} public address${ips.length === 1 ? '' : 'es'}.` });
      }
    } catch (e: any) {
      resolved = false;
      checks.push({ id: 'dns', label: 'Host name resolves', state: 'fail', detail: `The name could not be resolved (${e?.code ?? 'lookup failed'}).` });
      hints.push('Check the host name for typos. If it is new, create an "A" record for it that points at your home\'s public IP address, then wait for DNS to update. Also make sure this computer is online.');
    }
  } else checks.push({ id: 'dns', label: 'Host name resolves', state: 'skipped', detail: kind === 'public-ip' ? 'The endpoint is an IP address, so no name lookup is needed.' : 'The endpoint is a local address, so no name lookup is needed.' });

  // Game TCP
  if (!resolved) {
    checks.push({ id: 'game-tcp', label: `Game port ${ep.tcpPort} (TCP) accepts a connection`, state: 'skipped', detail: 'Skipped because the host name did not resolve.' });
    checks.push({ id: 'http', label: `Server status page (HTTP ${ep.httpPort})`, state: 'skipped', detail: 'Skipped because the host name did not resolve.' });
  } else {
    const t = await tcp(ep.host, ep.tcpPort, timeout);
    if (t.ok) checks.push({ id: 'game-tcp', label: `Game port ${ep.tcpPort} (TCP) accepts a connection`, state: 'pass', detail: 'Something answered on that port.' });
    else {
      checks.push({ id: 'game-tcp', label: `Game port ${ep.tcpPort} (TCP) accepts a connection`, state: 'fail', detail: t.code === 'ECONNREFUSED' ? 'The machine was reached but nothing is listening on that port.' : t.code === 'ETIMEDOUT' ? 'No answer within the time limit.' : `Could not connect (${t.code}).` });
      if (t.code === 'ECONNREFUSED') hints.push(`The address is reachable but nothing accepts connections on TCP ${ep.tcpPort}: the game server may be stopped, or the port-forward points at the wrong internal port.`);
      else hints.push(ep.scope === 'public'
        ? `No answer on TCP ${ep.tcpPort}. Usual causes: the router is not forwarding TCP ${ep.tcpPort} to the server PC, the Windows/Linux firewall blocks it, your provider uses carrier-grade NAT (no public IP), or this PC is on the same network and the router does not support "hairpin" loopback — test from a different network (e.g. a phone hotspot) to be sure.`
        : `No answer on TCP ${ep.tcpPort} on the local network. Check the address is right and the server is running and reachable from this PC.`);
    }
    const h = await http(ep.host, ep.httpPort, timeout);
    if (h.online) checks.push({ id: 'http', label: `Server status page (HTTP ${ep.httpPort})`, state: 'pass', detail: `The server's status page answered${h.players != null && h.maxPlayers != null ? ` (${h.players}/${h.maxPlayers} players)` : ''}.` });
    else {
      checks.push({ id: 'http', label: `Server status page (HTTP ${ep.httpPort})`, state: 'fail', detail: h.reason ?? 'No answer.' });
      hints.push(`Remote players also need TCP ${ep.httpPort} (the server's HTTP port): Content Manager and Custom Shaders Patch fetch the server's content list and scripts from it. Forward that port too.`);
    }
  }
  checks.push({ id: 'udp', label: `Game port ${ep.tcpPort} (UDP)`, state: 'info', detail: 'Cannot be tested from here — UDP has no handshake to probe. Assetto Corsa needs this port forwarded for UDP as well as TCP; only a real join proves it works.' });

  const reachable = checks.filter((c) => c.id === 'game-tcp' || c.id === 'http').every((c) => c.state === 'pass');
  return { scope: ep.scope, checks, hints: [...new Set(hints)], reachable };
}
