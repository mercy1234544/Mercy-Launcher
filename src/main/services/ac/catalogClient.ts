// HTTP client for the catalog's static files (catalog.json, catalog.json.sig). It only ever performs GETs, never
// sends credentials or cookies, caps the size of what it will read, refuses redirects to another host, and treats
// the response as untrusted bytes — verifying and parsing them is the caller's job (catalogSync.evaluateCatalog).
import * as http from 'http';
import * as https from 'https';
import { classifyHost } from '../AcRequirementsChecker';

export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 4 * 1024;

export interface HttpResult { status: number; headers: Record<string, string>; body: Buffer }
export interface TransportOptions { headers?: Record<string, string>; timeoutMs: number; maxBytes: number; signal?: AbortSignal }
export type Transport = (url: string, opts: TransportOptions) => Promise<HttpResult>;

export type FetchErrorCode = 'unconfigured' | 'policy' | 'network' | 'timeout' | 'too-large' | 'http' | 'redirect' | 'cancelled';
export class CatalogFetchError extends Error {
  constructor(public code: FetchErrorCode, message: string, public status?: number) { super(message); }
}

export type BaseUrlCheck = { ok: true; base: string; catalogUrl: string; signatureUrl: string; healthUrl: string; privateHost: boolean } | { ok: false; error: string };

/** Validates the owner-configured base URL. https always; plain http only for private/loopback hosts (LAN testing). */
export function checkBaseUrl(raw: string | null | undefined): BaseUrlCheck {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'No catalog address is configured.' };
  let u: URL; try { u = new URL(text); } catch { return { ok: false, error: 'The catalog address is not a valid URL.' }; }
  if (u.username || u.password) return { ok: false, error: 'The catalog address must not contain a user name or password.' };
  if (u.search || u.hash) return { ok: false, error: 'The catalog address must not contain a query string or fragment.' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const kind = classifyHost(host);
  const privateHost = kind === 'private-lan' || kind === 'loopback' || host === 'localhost' || host.endsWith('.local');
  if (u.protocol === 'http:') {
    if (!privateHost) return { ok: false, error: 'The catalog address must use https. Plain http is only accepted for a private network address (LAN testing).' };
  } else if (u.protocol !== 'https:') return { ok: false, error: 'The catalog address must start with https://.' };
  const path = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
  const base = `${u.protocol}//${u.host}${path}`;
  return { ok: true, base, catalogUrl: base + 'catalog.json', signatureUrl: base + 'catalog.json.sig', healthUrl: base + 'health.json', privateHost };
}

/** Real transport: GET with a size cap, an idle timeout, and same-host redirects only. */
export const nodeTransport: Transport = (url, opts) => new Promise((resolve, reject) => {
  const origin = new URL(url);
  const go = (target: string, hop: number) => {
    let u: URL; try { u = new URL(target); } catch { return reject(new CatalogFetchError('redirect', 'The server sent an invalid redirect.')); }
    if (u.hostname.toLowerCase() !== origin.hostname.toLowerCase() || u.port !== origin.port) return reject(new CatalogFetchError('redirect', 'The catalog server redirected to a different host, which is not allowed.'));
    if (origin.protocol === 'https:' && u.protocol !== 'https:') return reject(new CatalogFetchError('redirect', 'The catalog server tried to downgrade the connection to http.'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'MercyLauncher/AcCatalog', Accept: 'application/json', ...(opts.headers ?? {}) }, timeout: opts.timeoutMs }, (res) => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (hop >= 3) return reject(new CatalogFetchError('redirect', 'Too many redirects.'));
        return go(new URL(res.headers.location, u).toString(), hop + 1);
      }
      const len = parseInt(String(res.headers['content-length'] ?? ''), 10);
      if (Number.isFinite(len) && len > opts.maxBytes) { res.destroy(); return reject(new CatalogFetchError('too-large', `The server announced ${len} bytes, over the ${opts.maxBytes}-byte limit.`)); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) { res.destroy(); reject(new CatalogFetchError('too-large', `The response is larger than the ${opts.maxBytes}-byte limit.`)); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        resolve({ status: code, headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => reject(new CatalogFetchError('network', e.message)));
    });
    req.on('timeout', () => req.destroy(new CatalogFetchError('timeout', 'The catalog server did not answer in time.')));
    req.on('error', (e) => reject(e instanceof CatalogFetchError ? e : new CatalogFetchError('network', (e as NodeJS.ErrnoException).code ? `Could not reach the catalog server (${(e as NodeJS.ErrnoException).code}).` : e.message)));
    opts.signal?.addEventListener('abort', () => req.destroy(new CatalogFetchError('cancelled', 'Cancelled.')), { once: true });
  };
  go(url, 0);
});

export type FetchOutcome =
  | { kind: 'not-modified' }
  | { kind: 'fetched'; catalogBytes: Buffer; signature: string | null; etag: string | null }
  | { kind: 'error'; code: FetchErrorCode; message: string; status?: number; retryable: boolean };

const asError = (e: unknown): FetchOutcome => {
  if (e instanceof CatalogFetchError) return { kind: 'error', code: e.code, message: e.message, status: e.status, retryable: e.code !== 'policy' && e.code !== 'cancelled' };
  return { kind: 'error', code: 'network', message: (e as Error)?.message ?? 'Network error.', retryable: true };
};

export async function fetchCatalogFiles(base: BaseUrlCheck & { ok: true }, opts: { etag?: string | null; transport?: Transport; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FetchOutcome> {
  const transport = opts.transport ?? nodeTransport;
  const timeoutMs = opts.timeoutMs ?? 15000;
  try {
    const cat = await transport(base.catalogUrl, { headers: opts.etag ? { 'If-None-Match': opts.etag } : undefined, timeoutMs, maxBytes: MAX_CATALOG_BYTES, signal: opts.signal });
    if (cat.status === 304) return { kind: 'not-modified' };
    if (cat.status === 404) return { kind: 'error', code: 'http', message: 'The server has no catalog at that address (HTTP 404). Check the address with the server owner.', status: 404, retryable: true };
    if (cat.status < 200 || cat.status >= 300) return { kind: 'error', code: 'http', message: `The catalog server answered HTTP ${cat.status}.`, status: cat.status, retryable: cat.status >= 500 || cat.status === 429 };
    let signature: string | null = null;
    try {
      const sig = await transport(base.signatureUrl, { timeoutMs, maxBytes: MAX_SIGNATURE_BYTES, signal: opts.signal });
      if (sig.status >= 200 && sig.status < 300) signature = sig.body.toString('utf8');
    } catch (e) { if (e instanceof CatalogFetchError && e.code === 'cancelled') throw e; /* an unreadable signature is treated as "no signature" */ }
    return { kind: 'fetched', catalogBytes: cat.body, signature, etag: cat.headers['etag'] ?? null };
  } catch (e) { return asError(e); }
}
