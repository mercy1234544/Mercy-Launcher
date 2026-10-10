// Read-only live status for a Mercy's Server: one HTTP GET to the server's own /INFO page
// (Kunos acServer and AssettoServer both publish it on the server's HTTP port).
//
// Only ever called against an endpoint the user/owner has configured — nothing is probed by
// default, and nothing here starts, stops or reconfigures a server. A server is shown as
// "online" ONLY when this request actually succeeded just now; any failure is "unknown/offline"
// with the reason, never a guess. Verified against a local fake server in tests; NOT yet against
// the real SRP servers (that needs an endpoint the owner provides).
import * as http from 'http';

export interface ServerInfoResult {
  online: boolean;
  checkedAt: string;
  players?: number;
  maxPlayers?: number;
  name?: string;
  reason?: string;
}

export function probeServerInfo(host: string, httpPort: number, timeoutMs = 3000): Promise<ServerInfoResult> {
  return new Promise((resolve) => {
    const done = (r: Omit<ServerInfoResult, 'checkedAt'>) => resolve({ ...r, checkedAt: new Date().toISOString() });
    let settled = false;
    const finish = (r: Omit<ServerInfoResult, 'checkedAt'>) => { if (!settled) { settled = true; done(r); } };
    try {
      const req = http.get({ host, port: httpPort, path: '/INFO', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish({ online: false, reason: `The server answered HTTP ${res.statusCode}.` }); }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (size > 1024 * 1024) { req.destroy(); finish({ online: false, reason: 'The status reply was unexpectedly large.' }); } else chunks.push(c); });
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const players = Number(j.clients); const max = Number(j.maxclients);
            finish({ online: true, players: Number.isFinite(players) ? players : undefined, maxPlayers: Number.isFinite(max) ? max : undefined, name: typeof j.name === 'string' ? j.name : undefined });
          } catch { finish({ online: false, reason: 'The server answered, but not with a readable status page.' }); }
        });
        res.on('error', () => finish({ online: false, reason: 'The connection was interrupted.' }));
      });
      req.on('timeout', () => { req.destroy(); finish({ online: false, reason: 'No answer within the time limit.' }); });
      req.on('error', (e: NodeJS.ErrnoException) => finish({ online: false, reason: e.code === 'ECONNREFUSED' ? 'Connection refused (server not running, or the HTTP port is closed).' : `Could not connect (${e.code ?? 'network error'}).` }));
    } catch (e: any) { finish({ online: false, reason: `Could not start the check: ${e?.message ?? 'unknown error'}` }); }
  });
}
